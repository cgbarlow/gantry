import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadDefinitionForInstance, readInstance, readModule } from '../lib/instance.js'
import { renderArtefact } from '../lib/render.js'
import { parseDecisionsLog, currentLogEntries } from '../web/lib/decisionsLog.js'
import { findOutOfDateFields } from '../web/lib/outOfDate.js'
import { parseSourceManifest, isRemovedSource, SOURCE_MANIFEST_PATH } from '../web/lib/sourceDocuments.js'
import { citedSourceIds } from '../web/lib/sourceCitations.js'
import { checkReviewedCopy, readReviewedCopy } from '../web/lib/reviewedCopy.js'
import { parseReviewManifest } from '../web/lib/reviewManifest.js'
import { answeredCounts, answeredReviewKeys } from '../web/lib/reviewRound.js'
import { reviewResponseDocx, reviewResponseRows } from '../web/lib/reviewResponse.js'
import { expectedRender } from '../lib/reviews.js'
import { unzip } from './helpers/reviewedCopyFixture.js'

// #310 (map #238): the bundled `kiwi-cover-mutual` example carries the evidence the AI interview works from: a Source document pack with
// citations to it in the content, a decisions log for each Stage and one Reviewed copy whose comments the logs show answered. These tests keep
// the evidence true to the example's content. When one fails because the example's wording has moved, run
// `node scripts/example-evidence/build.mjs` (see the top of that file).

const WORKSPACE = 'workspaces/examples'
const SLUG = 'kiwi-cover-mutual'
const INSTANCE = join(WORKSPACE, SLUG)

// #359: the evidence is built, and checked, against the version the example is pinned to (design v4 since #359), so a
// rebuild never describes the example on a version it does not run on.
const instance = readInstance(SLUG, { instancesDir: WORKSPACE })
const definition = loadDefinitionForInstance(instance)
const sources = parseSourceManifest(readFileSync(join(INSTANCE, SOURCE_MANIFEST_PATH), 'utf8'))
const logs = Object.fromEntries(definition.stages.map((stage) => [stage.id, parseDecisionsLog(readFileSync(join(INSTANCE, 'interview', `${stage.id}.yaml`), 'utf8'), stage.id)]))
const saved = Object.fromEntries([...definition.modules.keys()].filter((id) => existsSync(join(INSTANCE, 'modules', `${id}.md`))).map((id) => [id, readModule(definition, SLUG, id, { instancesDir: WORKSPACE })]))
const sourceText = (entry) => readFileSync(join(INSTANCE, 'sources', entry.text), 'utf8')

test('the example holds a small pack of four Source documents, each with its file, and the text read from the ones that have text', () => {
  assert.deepEqual(
    sources.map((s) => s.id),
    ['client-brief', 'requirements-register', 'design-workshop-notes', 'claim-registration-screen']
  )
  assert.deepEqual(
    sources.map((s) => s.filename.split('.').pop()),
    ['pdf', 'xlsx', 'docx', 'png']
  )
  for (const entry of sources) {
    assert.ok(!isRemovedSource(entry), `${entry.id} is kept`)
    assert.equal(readFileSync(join(INSTANCE, 'sources', entry.filename)).length, entry.size, `${entry.id} weighs what the manifest says`)
    if (entry.id === 'claim-registration-screen') assert.equal(entry.text, undefined, 'a screenshot has no text')
    else assert.ok(sourceText(entry).trim().length > 100, `${entry.id} has its extracted text`)
  }
  // Nothing in the folder that the manifest does not list.
  const listed = new Set(['manifest.yaml', '.text', ...sources.map((s) => s.filename)])
  assert.deepEqual(readdirSync(join(INSTANCE, 'sources')).filter((name) => !listed.has(name)), [])
})

test('every figure the content cites comes from a document in the pack, and the pack says it is fictitious', () => {
  const brief = sourceText(sources.find((s) => s.id === 'client-brief'))
  assert.match(brief, /12\.4 working days/)
  assert.match(brief, /18 percent/)
  const register = sourceText(sources.find((s) => s.id === 'requirements-register'))
  assert.match(register, /38000/)
  assert.match(register, /\b600\b/)
  for (const id of ['client-brief', 'design-workshop-notes']) assert.match(sourceText(sources.find((s) => s.id === id)), /Fictitious example document/)
})

test('the content cites the pack: every citation names a document in it, and every document is cited somewhere', () => {
  const ids = new Set(sources.map((s) => s.id))
  const cited = new Set()
  for (const [moduleId, module] of Object.entries(saved)) {
    for (const [fieldId, value] of Object.entries(module.fields)) {
      for (const id of citedSourceIds(Array.isArray(value) ? value.join('\n') : String(value))) {
        assert.ok(ids.has(id), `${moduleId}.${fieldId} cites "${id}", which is not in the pack`)
        cited.add(id)
      }
    }
  }
  assert.deepEqual([...cited].sort(), [...ids].sort())
})

test('every Stage has a decisions log in the shape a Save writes, and none of the Fields it records is Out of date', () => {
  for (const stage of definition.stages) {
    const log = logs[stage.id]
    assert.equal(log.stage, stage.id)
    assert.ok(log.entries.length >= 4, `${stage.id} has entries`)
    assert.equal(log.status.length, 1)
    assert.equal(log.status[0].state, 'saved', 'nothing is left paused')
    assert.deepEqual(log.status[0].models, [], 'no AI Provider was used, so no model is named')
    for (const key of Object.keys(log.fields)) {
      const [moduleId, ...rest] = key.split('.')
      assert.ok(definition.modules.get(moduleId)?.fields.some((f) => f.id === rest.join('.')), `${key} is a Field of the Definition`)
    }
  }
  const kinds = new Set(Object.values(logs).flatMap((log) => log.entries.map((e) => e.kind)))
  for (const kind of ['artefact', 'answer', 'fact', 'term', 'open-question', 'saved-content', 'review-answered', 'returned-to-draft']) assert.ok(kinds.has(kind), `a ${kind} entry`)
  assert.deepEqual(findOutOfDateFields({ sources, logs, modules: saved }), [], 'a fingerprint has drifted: run scripts/example-evidence/build.mjs')
})

test('each log says its interview ran on the version the example is pinned to, as a Save on that Instance would record it', () => {
  assert.equal(definition.version, instance.definitionVersion)
  for (const stage of definition.stages) {
    for (const status of logs[stage.id].status) assert.equal(status.instructions, `design@${instance.definitionVersion}`, stage.id)
  }
})

test('the open questions in the logs are the ones the Open questions module lists', () => {
  const module = saved['open-questions'].fields.questions
  const open = Object.values(logs).flatMap((log) => currentLogEntries(log).filter((e) => e.kind === 'open-question'))
  assert.equal(open.length, 6)
  for (const entry of open) assert.ok(module.includes(entry.question.slice(0, 40)), `"${entry.question}" is in the Open questions module`)
})

test('the Reviewed copy is a tagged render of this Instance, read back as four comments from two reviewers and one tracked change', async () => {
  const [entry, ...others] = parseReviewManifest(readFileSync(join(INSTANCE, 'reviews', 'manifest.yaml'), 'utf8'))
  assert.equal(others.length, 0)
  const bytes = readFileSync(join(INSTANCE, entry.file))
  assert.equal(bytes.length, entry.size)
  const read = await readReviewedCopy(bytes)
  assert.deepEqual(checkReviewedCopy(read.properties, expectedRender(SLUG, definition)), { ok: true })
  assert.equal(read.properties.artefact, entry.artefact)
  assert.equal(read.properties['render-id'], entry.renderId)
  assert.equal(read.threads.length, 4)
  assert.equal(read.changes.length, 1)
  assert.equal(read.commentCount, entry.comments)
  assert.deepEqual(read.commenters, entry.commenters)
  assert.ok(read.fieldBookmarks >= 10, 'it carries Gantry’s Field bookmarks, so a comment is placed on its Field')
  assert.equal(entry.commentsAnswered, 4)
  // The logs say every thread was answered, and say it the way the manifest counts it.
  const answered = answeredReviewKeys(logs)
  for (const thread of read.threads) assert.ok(answered.has(`${entry.id}:${thread.id}`), `thread ${thread.id} is answered`)
  assert.deepEqual(answeredCounts(logs), { [entry.id]: 4 })
})

test('the Review response list the logs give is four rows in one table, with each kind of outcome and a reason only where the architect gave one', () => {
  const list = reviewResponseRows(logs, { fieldTitle: (key) => key })
  assert.equal(list.copies.length, 1)
  assert.equal(list.rows.length, 4)
  assert.deepEqual(new Set(list.rows.map((r) => r.commenter)), new Set(['Aroha Kingi', 'Wiremu Ellis']))
  assert.deepEqual(
    list.rows.map((r) => r.outcome).sort(),
    ['Edit accepted', 'Kept as it was', 'Not settled yet (logged as an open question)', 'Wording revised']
  )
  assert.equal(list.rows.filter((r) => r.reason === '—').length, 2, 'two answers were given without a reason')
  const docx = unzip(Buffer.from(reviewResponseDocx(list, { instanceName: 'Kiwi Cover Mutual', date: '2026-03-25' })))
  assert.match(docx['word/document.xml'].toString('utf8'), /Where does the 12\.4 days come from/)
})

test('the example’s answers are what its content now says: the cited figure, the dated retention rules and the open question', () => {
  assert.match(saved.background.fields.problem, /12\.4 working days[^]*\(source:client-brief\)/)
  assert.match(saved.dependencies.fields['dependencies-overview'], /retention rules by 15 May 2026, before/)
  assert.match(saved['open-questions'].fields.questions, /Q6: Review comment \(Reviewer 2\): when will the bank’s payment API sandbox be ready\?/)
  assert.equal(saved['team-and-estimates'].fields.estimates.includes('Reconciliation and Treasury sign-off add elapsed time'), true, 'the kept Field is unchanged')
})

test('the Full SOAP regenerates with each citation printed as a footnote (#351), and the .md keeps the links', () => {
  const render = renderArtefact(SLUG, 'soap-full', { dryRun: true, instancesDir: WORKSPACE })
  assert.ok(!render.docxMarkdown.includes('source:'), 'no citation address reaches the Word document')
  assert.match(render.docxMarkdown, /hold mainframe skills\^\[Client brief, p\. 1\]/)
  assert.match(render.docxMarkdown, /# Sources\n\n\| Document \| File \| Added \|\n\| --- \| --- \| --- \|\n\| Claim registration screen \| Claim registration screen\.png \| 16 Mar 2026 \|/)
  assert.match(render.markdown, /\[Client brief, p\. 1\]\(source:client-brief\)/)
  assert.ok(!/\(\(/.test(render.docxMarkdown.replace(/\n\|.*\|/g, '').replace(/\(\(Reviewer/g, '')), 'no citation is printed inside a second pair of brackets')
})

test('every Artefact the example renders prints its Sources list from the pack', () => {
  for (const artefact of ['soap', 'hld', 'sad', 'ssad', 'as-built']) {
    const render = renderArtefact(SLUG, artefact, { dryRun: true, instancesDir: WORKSPACE })
    assert.ok(!render.docxMarkdown.includes('source:'), `${artefact} prints no citation address`)
  }
  const sad = renderArtefact(SLUG, 'sad', { dryRun: true, instancesDir: WORKSPACE })
  assert.match(sad.docxMarkdown, /# Sources[^]*Requirements register/)
})
