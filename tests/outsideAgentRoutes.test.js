import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { createInstance, instanceDefinitionVersion, readInstance } from '../lib/instance.js'
import { loadDefinition } from '../lib/definition.js'
import { buildInterviewBrief } from '../web/lib/interviewBrief.js'
import { emptyDecisionsLog } from '../web/lib/decisionsLog.js'
import { instanceTargetSize } from '../web/lib/instanceSettings.js'
import { loadInterviewSkills } from '../web/lib/interviewSkills.js'
import { createSessionLog } from '../web/lib/interviewLog.js'
import { resumeInfo } from '../web/lib/interviewResume.js'
import { withRunningServer } from './helpers/lifecycle.js'

// #307 (docs/adr/0067): what an outside agent in an AI interview session gets from `gantry serve`, on a local-style (server directory) workspace:
// the interview brief and a recap, a Save that carries the session's entries and status in the same write as the content, the Fields section
// rebuilt from citations so Out of date detection works, and the guard rails an agent in a session is held to. The MCP tools are tested in
// mcp-server/test; the Provider workspaces are tested in tests/outsideAgentProviders.test.js.

const SLUG = 'my-initiative'
const SESSION = 's-agent1'
const b64 = (bytes) => Buffer.from(bytes).toString('base64')
const SKILLS_DIR = new URL('../web/interview-skills/', import.meta.url)

async function withInstance(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createInstance('design', SLUG, { instancesDir })
    await withRunningServer({ slug: SLUG, instancesDir }, (base) => fn(base, join(instancesDir, 'default', SLUG)))
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

const call = (base, method, path, body) =>
  fetch(`${base}${path}${path.includes('?') ? '&' : '?'}slug=${SLUG}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
const json = async (res) => res.json()
const session = (extra = {}) => ({ id: SESSION, runUntil: 'shape', state: 'in-progress', model: 'claude-opus-4-1', who: 'a.architect', ...extra })

// The first Module of the current Stage and two of its Fields, as get_instance gives them.
async function firstTwoFields(base) {
  const instance = await json(await call(base, 'GET', '/api/instance'))
  const module = instance.modules.find((m) => m.fields.length >= 2)
  return { instance, moduleId: module.id, a: module.fields[0].id, b: module.fields[1].id }
}

describe('the interview brief an outside agent gets', () => {
  test('is byte for byte what the in-app builder gives for the same inputs', async () => {
    const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
    try {
      createInstance('design', SLUG, { instancesDir })
      await withRunningServer({ slug: SLUG, instancesDir }, async (base) => {
        const body = await json(await call(base, 'GET', '/api/instance/interview-brief'))
        const folder = join(instancesDir, 'default')
        const record = readInstance(SLUG, { instancesDir: folder })
        const def = loadDefinition(record.definition, { version: instanceDefinitionVersion(record) })
        const skills = await loadInterviewSkills((path) => readFileSync(new URL(path, SKILLS_DIR), 'utf8'))
        const expected = buildInterviewBrief({
          definition: def,
          stageId: record.stage,
          size: instanceTargetSize(def, record),
          saved: [],
          decisions: emptyDecisionsLog(record.stage),
          earlierDecisions: [],
          sources: [],
          skills,
          readerTool: true,
        })
        assert.equal(body.brief, expected.text)
        assert.deepEqual(body.fields, expected.fields)
        assert.deepEqual(body.tokens, expected.tokens)
        assert.equal(body.rulesVersion, expected.rulesVersion)
      })
    } finally {
      rmSync(instancesDir, { recursive: true, force: true })
    }
  })

  test('is the brief the in-app AI gets, built by the same builder from the same inputs, plus a recap', async () => {
    await withInstance(async (base) => {
      await call(base, 'POST', '/api/instance/sources', { filename: 'Client brief.txt', dataBase64: b64('Five thousand users, by March.'), extractText: true })
      const body = await json(await call(base, 'GET', '/api/instance/interview-brief'))
      assert.equal(body.stage.id, (await json(await call(base, 'GET', '/api/instance'))).stage.id)
      assert.match(body.brief, /## 1\. Gantry's interview rules/)
      assert.match(body.brief, /Five thousand users, by March\./)
      assert.match(body.brief, /## 9\. Decisions log so far/)
      assert.deepEqual(body.parts.map((p) => p.id), ['rules', 'skills', 'interview-instructions', 'stage', 'fields', 'saved-content', 'glossary', 'sources', 'decisions-log'])
      assert.equal(body.recap.resuming, false)
      assert.match(body.recap.line, /Starting .*nothing is logged/)
      assert.match(body.instructions, /outside agent/)

      // It carries the pinned skills the in-app AI follows, from the same bundled files.
      const skills = await loadInterviewSkills((path) => readFileSync(new URL(path, SKILLS_DIR), 'utf8'))
      assert.ok(skills.skills.length >= 2)
      assert.ok(body.brief.includes(skills.skills[0].files[0].text.trimEnd().slice(0, 80)))
      assert.equal(typeof body.rulesVersion, 'number')
    })
  })

  test('an unknown Stage is a 400, and a recap names a paused session to take over', async () => {
    await withInstance(async (base) => {
      assert.equal((await call(base, 'GET', '/api/instance/interview-brief?stage=nope')).status, 400)
      const { instance, moduleId, a } = await firstTwoFields(base)
      const saved = await call(base, 'PUT', '/api/instance/modules', {
        modules: { [moduleId]: { fields: { [a]: 'A first draft.' } } },
        baseVersion: instance.stageVersion,
        session: session({ state: 'paused' }),
        entries: [{ kind: 'answer', question: 'Who is it for?', answer: ['Retail customers'], fields: [`${moduleId}.${a}`] }],
      })
      assert.equal(saved.status, 200, await saved.clone().text())
      const body = await json(await call(base, 'GET', '/api/instance/interview-brief?who=a.architect'))
      assert.equal(body.recap.resuming, true)
      assert.match(body.recap.line, /^Resuming .*: 1 decision, 0 open questions/)
      assert.equal(body.recap.adoptable.session, SESSION)
      assert.equal(body.recap.adoptable.recordedBy, 'outside agent')
      assert.match(body.brief, /Who is it for\?/)
      assert.match(body.brief, /recorded by an outside agent/)
    })
  })
})

describe('a Save in a session', () => {
  test('commits the entries and the session status with the content, labelled as recorded by an outside agent', async () => {
    await withInstance(async (base, folder) => {
      const { instance, moduleId, a, b } = await firstTwoFields(base)
      const res = await call(base, 'PUT', '/api/instance/modules', {
        modules: { [moduleId]: { fields: { [a]: 'The platform serves retail customers.', [b]: 'Launch in March.' } } },
        baseVersion: instance.stageVersion,
        session: session({ state: 'saved' }),
        entries: [
          { kind: 'answer', question: 'Who is it for?', answer: ['Retail customers'], fields: [`${moduleId}.${a}`] },
          { kind: 'fact', words: 'We launch in March, no later.', fields: [`${moduleId}.${b}`] },
          { kind: 'open-question', question: 'Which card schemes?', why: 'Not in the brief' },
        ],
      })
      assert.equal(res.status, 200, await res.clone().text())
      const saved = await res.json()
      assert.deepEqual(saved.session, { id: SESSION, state: 'saved', recordedBy: 'outside agent', entriesRecorded: 3 })
      assert.equal(typeof saved.stageVersion, 'string')

      const log = parseYaml(readFileSync(join(folder, 'interview', `${instance.stage.id}.yaml`), 'utf8'))
      assert.equal(log.entries.length, 3)
      for (const entry of log.entries) {
        assert.equal(entry.recordedBy, 'outside agent')
        assert.equal(entry.agentModel, 'claude-opus-4-1')
        assert.equal(entry.session, SESSION)
        assert.equal(entry.who, 'a.architect')
        assert.match(entry.id, new RegExp(`^${SESSION}-\\d+$`))
      }
      assert.deepEqual(log.status.length, 1)
      assert.equal(log.status[0].session, SESSION)
      assert.equal(log.status[0].state, 'saved')
      assert.equal(log.status[0].target, 'shape')
      assert.equal(log.status[0].recordedBy, 'outside agent')
      assert.deepEqual(log.status[0].models, [{ type: 'outside-agent', model: 'claude-opus-4-1', tokens: 'not reported' }])
      assert.ok(log.status[0].lastAiSave)
      // The Fields section is rebuilt from the entries that name each Field.
      assert.deepEqual(log.fields[`${moduleId}.${a}`].entries, [log.entries[0].id])
      assert.deepEqual(log.fields[`${moduleId}.${b}`].entries, [log.entries[1].id])
      assert.ok(log.fields[`${moduleId}.${a}`].drafted)

      // The committed log reads back, status and all, through the routes the browser uses.
      const read = await json(await call(base, 'GET', `/api/instance/decisions?stage=${instance.stage.id}`))
      assert.equal(read.log.status[0].models[0].tokens, 'not reported')
    })
  })

  test('is refused without the stage version, and entries without a session are refused', async () => {
    await withInstance(async (base, folder) => {
      const { moduleId, a } = await firstTwoFields(base)
      const noVersion = await call(base, 'PUT', '/api/instance/modules', { modules: { [moduleId]: { fields: { [a]: 'x' } } }, session: session() })
      assert.equal(noVersion.status, 400)
      const body = await noVersion.json()
      assert.equal(body.code, 'stage_version_required')
      assert.match(body.error, /must pass the "stageVersion"/)
      const noSession = await call(base, 'PUT', '/api/instance/modules', { modules: { [moduleId]: { fields: { [a]: 'x' } } }, entries: [{ kind: 'open-question', question: 'Q?' }] })
      assert.equal(noSession.status, 400)
      assert.equal((await noSession.json()).code, 'session-required')
      // Nothing was written by either.
      assert.equal((await json(await call(base, 'GET', '/api/instance'))).modules.find((m) => m.id === moduleId).fields.find((f) => f.id === a).value || '', '')
      assert.throws(() => readFileSync(join(folder, 'interview'), 'utf8'))
    })
  })

  test('outside a session the same call is as before: no version needed, no log written', async () => {
    await withInstance(async (base, folder) => {
      const { moduleId, a } = await firstTwoFields(base)
      const res = await call(base, 'PUT', '/api/instance/modules', { modules: { [moduleId]: { fields: { [a]: 'A person typed this.' } } } })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal('session' in body, false)
      assert.throws(() => readFileSync(join(folder, 'interview'), 'utf8'))
    })
  })

  test('refuses an entry the log cannot take, and writes nothing', async () => {
    await withInstance(async (base) => {
      const { instance, moduleId, a } = await firstTwoFields(base)
      const bad = (entries) => call(base, 'PUT', '/api/instance/modules', { modules: { [moduleId]: { fields: { [a]: 'x' } } }, baseVersion: instance.stageVersion, session: session(), entries })
      assert.equal((await bad([{ kind: 'fact', fields: [`${moduleId}.${a}`] }])).status, 400)
      assert.equal((await bad([{ kind: 'wibble' }])).status, 400)
      assert.equal((await bad([{ kind: 'model-change' }])).status, 400)
      const replacing = await bad([{ kind: 'answer', question: 'Q', answer: 'A', replaces: ['s-agent1-99'] }])
      assert.equal(replacing.status, 400)
      assert.match((await replacing.json()).error, /not in this Stage's decisions log/)
      assert.equal((await call(base, 'PUT', '/api/instance/modules', { modules: { [moduleId]: { fields: { [a]: 'x' } } }, baseVersion: instance.stageVersion, session: { id: 'bad id', state: 'in-progress' } })).status, 400)
      assert.equal((await call(base, 'PUT', '/api/instance/modules', { modules: { [moduleId]: { fields: { [a]: 'x' } } }, baseVersion: instance.stageVersion, session: { id: 's-x', state: 'weird' } })).status, 400)
      const still = await json(await call(base, 'GET', '/api/instance'))
      assert.equal(still.stageVersion, instance.stageVersion, 'nothing was saved')
    })
  })

  test('a stale version is refused naming the Fields that differ, as for any Save', async () => {
    await withInstance(async (base) => {
      const { instance, moduleId, a } = await firstTwoFields(base)
      await call(base, 'PUT', '/api/instance/modules', { modules: { [moduleId]: { fields: { [a]: 'Someone else wrote this.' } } } })
      const res = await call(base, 'PUT', '/api/instance/modules', { modules: { [moduleId]: { fields: { [a]: 'Mine.' } } }, baseVersion: instance.stageVersion, session: session() })
      assert.equal(res.status, 409)
      assert.equal((await res.json()).code, 'stage_changed')
    })
  })

  test('appends to the log: a second Save continues the session\'s numbering and keeps one status line', async () => {
    await withInstance(async (base, folder) => {
      const { instance, moduleId, a, b } = await firstTwoFields(base)
      const first = await json(
        await call(base, 'PUT', '/api/instance/modules', {
          modules: { [moduleId]: { fields: { [a]: 'One.' } } },
          baseVersion: instance.stageVersion,
          session: session({ state: 'paused' }),
          entries: [{ kind: 'answer', question: 'Q1', answer: 'A1', fields: [`${moduleId}.${a}`] }],
        })
      )
      const second = await call(base, 'PUT', '/api/instance/modules', {
        modules: { [moduleId]: { fields: { [a]: 'One.', [b]: 'Two.' } } },
        baseVersion: first.stageVersion,
        session: session({ state: 'saved' }),
        entries: [{ kind: 'answer', question: 'Q2', answer: 'A2', fields: [`${moduleId}.${b}`] }, { kind: 'answer', question: 'Q1', answer: 'A1 revised', fields: [`${moduleId}.${a}`], replaces: [`${SESSION}-1`] }],
      })
      assert.equal(second.status, 200, await second.clone().text())
      const log = parseYaml(readFileSync(join(folder, 'interview', `${instance.stage.id}.yaml`), 'utf8'))
      assert.deepEqual(log.entries.map((e) => e.id), [`${SESSION}-1`, `${SESSION}-2`, `${SESSION}-3`])
      assert.equal(log.status.length, 1)
      assert.equal(log.status[0].state, 'saved')
      assert.equal(log.status[0].saves.length, 2)
      // Field `a` was carried unchanged by the second call: it was not drafted again, but its entries are those that now stand.
      assert.deepEqual(log.fields[`${moduleId}.${b}`].entries, [`${SESSION}-2`])
    })
  })
})

describe('Out of date detection on a Stage drafted by an outside agent', () => {
  test('a Field the agent drafted from a Source document is flagged when the document is replaced, and clears when it is redrafted', async () => {
    await withInstance(async (base, folder) => {
      await call(base, 'POST', '/api/instance/sources', { filename: 'Client brief.txt', dataBase64: b64('Five thousand users, by March.'), extractText: true })
      const { instance, moduleId, a, b } = await firstTwoFields(base)
      const keyA = `${moduleId}.${a}`
      const first = await json(
        await call(base, 'PUT', '/api/instance/modules', {
          modules: { [moduleId]: { fields: { [a]: 'Expect 5000 users ([Client brief, p. 1](source:client-brief)).', [b]: 'Hand written.' } } },
          baseVersion: instance.stageVersion,
          session: session({ state: 'saved' }),
          entries: [],
        })
      )
      const log = parseYaml(readFileSync(join(folder, 'interview', `${instance.stage.id}.yaml`), 'utf8'))
      assert.equal(log.fields[keyA].inputs[0].source, 'client-brief')
      assert.ok(log.fields[keyA].inputs[0].fingerprint, 'the cited document is fingerprinted by its text')
      assert.deepEqual((await json(await call(base, 'GET', '/api/instance/out-of-date'))).fields, [])

      await call(base, 'POST', '/api/instance/sources', { filename: 'Client brief v2.txt', dataBase64: b64('Eight thousand users.'), extractText: true, replaces: 'client-brief' })
      const flagged = await json(await call(base, 'GET', '/api/instance/out-of-date'))
      assert.deepEqual(flagged.fields.map((f) => [f.field, f.flags[0].change]), [[keyA, 'replaced']])

      // Redrafting the Field in a later session Save (the agent re-cites the new document) clears the flag; Field `b` was not drafted again.
      await call(base, 'PUT', '/api/instance/modules', {
        modules: { [moduleId]: { fields: { [a]: 'Expect 8000 users ([Client brief v2, p. 1](source:client-brief-v2)).', [b]: 'Hand written.' } } },
        baseVersion: first.stageVersion,
        session: session({ state: 'saved' }),
        entries: [{ kind: 'source-update', fields: [keyA], outcome: 'redraft', source: 'client-brief', change: 'replaced' }],
      })
      assert.deepEqual((await json(await call(base, 'GET', '/api/instance/out-of-date'))).fields, [])
    })
  })
})

describe('Pause', () => {
  test('saves the entries and status alone, in one write, and the session reads as paused', async () => {
    await withInstance(async (base, folder) => {
      const { instance, moduleId, a } = await firstTwoFields(base)
      const res = await call(base, 'PUT', `/api/instance/decisions?stage=${instance.stage.id}`, {
        session: session({ state: 'paused' }),
        entries: [{ kind: 'open-question', question: 'Which card schemes?', fields: [`${moduleId}.${a}`] }],
      })
      assert.equal(res.status, 200, await res.clone().text())
      const log = (await res.json()).log
      assert.equal(log.status[0].state, 'paused')
      assert.equal(log.status[0].lastAiSave, null, 'a Pause with no content is not an AI save of the Stage')
      assert.equal(log.entries[0].recordedBy, 'outside agent')
      // Nothing about the content moved.
      assert.equal((await json(await call(base, 'GET', '/api/instance'))).stageVersion, instance.stageVersion)
      assert.ok(readFileSync(join(folder, 'interview', `${instance.stage.id}.yaml`), 'utf8').includes('outside agent'))
    })
  })
})

describe('guard rails in a session', () => {
  test('advancing is refused until the session saved the Stage with the state "saved", with the in-app AI\'s reason; outside a session it works as before', async () => {
    await withInstance(async (base) => {
      const refused = await call(base, 'POST', `/api/instance/advance-stage?session=${SESSION}`)
      assert.equal(refused.status, 400)
      const body = await refused.json()
      assert.equal(body.code, 'session-guard')
      assert.match(body.error, /advances an Instance only after the architect confirmed the stage summary/)
      // Outside a session the same call is judged by the Gate alone, as today.
      const outside = await call(base, 'POST', '/api/instance/advance-stage')
      assert.equal(outside.status, 400)
      assert.match((await outside.json()).error, /Gate .* has not passed/)
    })
  })
})

describe('a session moves between the browser and an outside agent through the last commit', () => {
  test('started over MCP and paused, it is recapped and taken over by the browser, and the agent\'s entries keep their label', async () => {
    await withInstance(async (base) => {
      const { instance, moduleId, a } = await firstTwoFields(base)
      await call(base, 'PUT', '/api/instance/modules', {
        modules: { [moduleId]: { fields: { [a]: 'A first draft.' } } },
        baseVersion: instance.stageVersion,
        session: session({ state: 'paused' }),
        entries: [
          { kind: 'answer', question: 'Who is it for?', answer: ['Retail customers'], fields: [`${moduleId}.${a}`] },
          { kind: 'open-question', question: 'Which card schemes?' },
        ],
      })
      // What the Interview page reads and works out when it opens the Stage.
      const { log } = await json(await call(base, 'GET', `/api/instance/decisions?stage=${instance.stage.id}`))
      const info = resumeInfo({ logs: { [instance.stage.id]: log }, stageId: instance.stage.id, stageTitle: instance.stage.title, actor: 'a.architect', stages: instance.stages })
      assert.equal(info.resuming, true)
      assert.equal(info.adopt.session, SESSION, 'the browser takes over the agent\'s paused session')
      assert.match(info.recap, /: 1 decision, 1 open question/)

      // The browser carries on as that session, adds its own entry and saves; the agent's entries are untouched.
      const mine = createSessionLog({ stageId: instance.stage.id, now: () => new Date(Date.now() + 60000).toISOString(), who: () => 'a.architect' })
      mine.load(log)
      mine.adopt(info.adopt)
      assert.equal(mine.sessionId, SESSION)
      mine.addFact('Launch is in March', [`${moduleId}.${a}`])
      const delta = mine.delta({ fieldKeys: [`${moduleId}.${a}`], status: { who: 'a.architect', target: 'shape', state: 'saved' }, saving: true })
      const saved = await call(base, 'PUT', '/api/instance/modules', { modules: { [moduleId]: { fields: { [a]: 'A first draft, revised.' } } }, baseVersion: (await json(await call(base, 'GET', '/api/instance'))).stageVersion, decisions: delta })
      assert.equal(saved.status, 200, await saved.clone().text())
      const after = (await json(await call(base, 'GET', `/api/instance/decisions?stage=${instance.stage.id}`))).log
      assert.equal(after.entries.length, 3)
      assert.deepEqual(after.entries.map((e) => e.recordedBy ?? null), ['outside agent', 'outside agent', null], 'only the agent\'s entries carry the label')
      assert.equal(after.status.length, 1, 'one status line for the run')
      assert.equal(after.status[0].state, 'saved')
    })
  })

  test('started in the browser and paused, it is recapped and taken over by an outside agent, which then saves as the same session', async () => {
    await withInstance(async (base) => {
      const { instance, moduleId, a } = await firstTwoFields(base)
      const browser = createSessionLog({ stageId: instance.stage.id, now: () => '2026-11-02T09:00:00.000Z', newSessionId: () => 's-browser', who: () => 'a.architect' })
      browser.addUsage({ type: 'anthropic', model: 'claude-sonnet' }, { inputTokens: 1200, outputTokens: 300 })
      browser.addFact('The users are all retail customers', [`${moduleId}.${a}`])
      const delta = browser.delta({ fieldKeys: [`${moduleId}.${a}`], status: { who: 'a.architect', target: 'shape', state: 'paused' }, saving: true })
      assert.equal((await call(base, 'PUT', `/api/instance/decisions?stage=${instance.stage.id}`, { decisions: delta })).status, 200)

      const brief = await json(await call(base, 'GET', '/api/instance/interview-brief?who=a.architect'))
      assert.equal(brief.recap.adoptable.session, 's-browser')
      assert.equal(brief.recap.adoptable.recordedBy, null)
      assert.match(brief.recap.line, /^Resuming .*: 1 decision/)
      assert.match(brief.brief, /The users are all retail customers/)

      // The agent carries on as that session; the committed log wins, and its entries are numbered on from the browser's.
      const saved = await call(base, 'PUT', '/api/instance/modules', {
        modules: { [moduleId]: { fields: { [a]: 'Retail customers.' } } },
        baseVersion: instance.stageVersion,
        session: session({ id: 's-browser', state: 'done' }),
        entries: [{ kind: 'answer', question: 'Any business customers?', answer: ['No'], fields: [`${moduleId}.${a}`] }],
      })
      assert.equal(saved.status, 200, await saved.clone().text())
      const log = (await json(await call(base, 'GET', `/api/instance/decisions?stage=${instance.stage.id}`))).log
      assert.deepEqual(log.entries.map((e) => [e.session, e.recordedBy ?? null]), [['s-browser', null], ['s-browser', 'outside agent']])
      assert.equal(log.entries[1].id, 's-browser-2', 'numbering continues after the browser\'s entry')
      assert.equal(log.status.length, 1)
      assert.equal(log.status[0].state, 'done')
    })
  })
})

describe('after a review round', () => {
  test('per-thread outcomes recorded by the agent make a Review response list on demand, and with none there is nothing to list', async () => {
    await withInstance(async (base, folder) => {
      const { instance, moduleId, a } = await firstTwoFields(base)
      const empty = await json(await call(base, 'GET', '/api/instance/review-response'))
      assert.equal(empty.rows, 0)
      assert.match(empty.note, /No comment of a Reviewed copy has been answered yet/)

      const saved = await call(base, 'PUT', '/api/instance/modules', {
        modules: { [moduleId]: { fields: { [a]: 'Clearer wording.' } } },
        baseVersion: instance.stageVersion,
        session: session({ state: 'saved' }),
        entries: [
          {
            kind: 'review-answered',
            review: 'r1',
            reviewName: 'HLD.docx',
            keys: ['thread-1'],
            stage: instance.stage.id,
            fields: [`${moduleId}.${a}`],
            outcome: 'revise',
            words: 'The reviewer is right, the old wording was vague.',
            threads: [{ author: 'Alice Reviewer', date: '2026-10-30', text: 'This is vague.' }],
          },
        ],
      })
      assert.equal(saved.status, 200, await saved.clone().text())
      const list = await json(await call(base, 'GET', '/api/instance/review-response'))
      assert.equal(list.rows, 1)
      assert.deepEqual(list.copies, [{ id: 'r1', name: 'HLD.docx', rows: 1 }])
      assert.match(list.filename, /Review response list\.docx$/)
      assert.equal(list.mimeType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      const bytes = Buffer.from(list.docxBase64, 'base64')
      assert.equal(bytes.subarray(0, 2).toString(), 'PK', 'a Word document')
      assert.ok(bytes.includes(Buffer.from('Alice Reviewer')))
      assert.ok(bytes.includes(Buffer.from('The reviewer is right, the old wording was vague.')))
      // Gantry never wrote it anywhere.
      assert.throws(() => readFileSync(join(folder, 'Review response list.docx')))
    })
  })
})
