// #310 (map #238): the example's Reviewed copy. It is a real Gantry render of the Full SOAP, as it read before the reviewers' comments
// were answered, with four comments and one tracked change added the way Word adds them, by two fictitious reviewers. The comments were
// then answered (the answers are in the Stage's decisions log) and the example's Modules carry the resulting wording, so the copy is what
// "came back", not what the Instance says today.
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDefinitionForInstance, readInstance } from '../../lib/instance.js'
import { buildFieldIndex, placeReview, readReviewedCopy } from '../../web/lib/reviewedCopy.js'
import { reviewManifestEntry } from '../../web/lib/reviewManifest.js'
import { unzip, zip } from '../../tests/helpers/reviewedCopyFixture.js'

export const REVIEW_ID = '3f6a1c52-8d47-4b19-a0e3-6b2d9c71f504'
export const REVIEW_ARTEFACT = 'soap-full'
export const REVIEW_STAGE = 'shape'
export const REVIEW_NAME = 'Kiwi Cover Mutual - Full Solution on a Page (reviewed).docx'
export const REVIEW_DATE = '2026-03-24T16:05:00.000Z'

const AROHA = 'Aroha Kingi'
const WIREMU = 'Wiremu Ellis'

// What the example's wording was when the Full SOAP was rendered: the wording the answers to the comments changed, put back.
const BEFORE = [
  { file: 'background.md', from: ' only two contractors hold mainframe skills [Client brief, p. 1](source:client-brief).', to: ' only two contractors hold mainframe skills.' },
  { file: 'dependencies.md', from: 'retention rules by 15 May 2026, before', to: 'retention rules before' },
  { file: 'open-questions.md', from: /^\| Q6: .*\n/m, to: '' },
  { file: 'open-questions.md', from: '; Q6 came out of a review comment', to: '' },
]

// The comments, in the order they sit in the document. `find` is text unique to the paragraph that holds the anchor.
const COMMENTS = [
  { id: 0, author: AROHA, date: '2026-03-24T10:05:00Z', text: 'Where does the 12.4 days come from? Please say so in the document.', find: 'Median time to payment is 12.4 working days', anchor: 'Median time to payment is 12.4 working days' },
  { id: 1, author: WIREMU, date: '2026-03-24T14:30:00Z', text: 'Do we know when the bank’s payment API sandbox will be ready?', find: 'Treasury must complete the BIBIT contract variation', anchor: 'Treasury must complete the BIBIT contract variation for real-time claims payment' },
  {
    id: 2,
    author: WIREMU,
    date: '2026-03-24T14:32:00Z',
    text: 'Records Management should give a date for the retention rules.',
    find: 'Treasury must complete the BIBIT contract variation',
    anchor: 'Records Management must confirm retention rules',
    insert: { text: ' by 15 May 2026,', date: '2026-03-24T14:33:00Z' },
  },
  { id: 3, author: AROHA, date: '2026-03-24T11:20:00Z', text: 'Is Treasury’s sign-off counted in the size for Payments? M looks small.', find: 'Reconciliation and Treasury sign-off add elapsed time', anchor: 'Reconciliation and Treasury sign-off add elapsed time' },
]

const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const runOf = (text) => (text === '' ? '' : `<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`)

// Splits the one run that holds `find` into plain runs, comment ranges and a tracked insertion, as Word saves them.
function markParagraph(xml, find, comments) {
  const marker = esc(find)
  const hits = [...xml.matchAll(/<w:r><w:t xml:space="preserve">([^<]*)<\/w:t><\/w:r>/g)].filter((m) => m[1].includes(marker))
  if (hits.length !== 1) throw new Error(`Expected one run holding "${find}", found ${hits.length}.`)
  const [whole, text] = hits[0]
  let rest = text
  let out = ''
  for (const comment of comments) {
    const at = rest.indexOf(esc(comment.anchor))
    if (at === -1) throw new Error(`"${comment.anchor}" is not in the run holding "${find}".`)
    out += runOf(rest.slice(0, at).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))
    const anchor = esc(comment.anchor)
    const insert = comment.insert
      ? `<w:ins w:id="${100 + comment.id}" w:author="${esc(comment.author)}" w:date="${comment.insert.date}">${runOf(comment.insert.text)}</w:ins>`
      : ''
    out += `<w:commentRangeStart w:id="${comment.id}"/><w:r><w:t xml:space="preserve">${anchor}</w:t></w:r>${insert}<w:commentRangeEnd w:id="${comment.id}"/><w:r><w:commentReference w:id="${comment.id}"/></w:r>`
    rest = rest.slice(at + anchor.length)
  }
  out += runOf(rest.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))
  return xml.replace(whole, out)
}

function commentsXml() {
  const body = COMMENTS.map((c) => {
    const initials = c.author.split(' ').map((w) => w[0]).join('')
    return `<w:comment w:id="${c.id}" w:author="${esc(c.author)}" w:date="${c.date}" w:initials="${initials}"><w:p><w:pPr><w:pStyle w:val="CommentText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:annotationRef/></w:r><w:r><w:t xml:space="preserve">${esc(c.text)}</w:t></w:r></w:p></w:comment>`
  }).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${body}</w:comments>`
}

/** Renders the Full SOAP from the "before" wording and marks it up. Returns `{ id, name, bytes, entry, read, placed, threads }`. */
export async function buildReviewedCopy({ instanceDir, slug, root = process.cwd() }) {
  const scratch = mkdtempSync(join(tmpdir(), 'gantry-example-review-'))
  try {
    const workspace = join(scratch, 'examples')
    cpSync(instanceDir, join(workspace, slug), { recursive: true })
    rmSync(join(workspace, slug, 'out'), { recursive: true, force: true })
    for (const change of BEFORE) {
      const path = join(workspace, slug, 'modules', change.file)
      const text = readFileSync(path, 'utf8')
      const next = text.replace(change.from, change.to)
      if (next === text) throw new Error(`The "before" change for ${change.file} did not apply; the example's wording has moved on.`)
      writeFileSync(path, next)
    }
    execFileSync('node', [join(root, 'bin/gantry.js'), 'render', slug, REVIEW_ARTEFACT, '--workspaces-dir', workspace], { stdio: ['ignore', 'ignore', 'inherit'] })
    const out = join(workspace, slug, 'out')
    const file = readdirSync(out).find((name) => name.endsWith('.docx'))
    const parts = unzip(readFileSync(join(out, file)))
    let xml = parts['word/document.xml'].toString('utf8')
    const groups = new Map()
    for (const comment of COMMENTS) groups.set(comment.find, [...(groups.get(comment.find) ?? []), comment])
    for (const [find, comments] of groups) xml = markParagraph(xml, find, comments)
    parts['word/document.xml'] = xml
    parts['word/comments.xml'] = commentsXml()
    const bytes = zip(parts, { compress: true })

    const read = await readReviewedCopy(bytes)
    const definition = loadDefinitionForInstance(readInstance(slug, { instancesDir: workspace })) // the version the example is pinned to (#359)
    const fieldIndex = buildFieldIndex([...definition.modules].flatMap(([moduleId, spec]) => spec.fields.map((f) => ({ moduleId, moduleTitle: spec.title, fieldId: f.id, fieldTitle: f.title }))))
    const placed = placeReview(read, { fieldIndex })
    const fieldOf = new Map()
    for (const group of placed.groups) {
      if (group.kind !== 'field') continue
      const key = `${group.field.moduleId}.${group.field.fieldId}`
      for (const thread of group.threads) fieldOf.set(thread.id, key)
    }
    if (read.threads.length !== COMMENTS.length || read.threads.some((t) => !fieldOf.has(t.id))) throw new Error('The Reviewed copy did not read back as four placed comment threads.')
    const entry = { ...reviewManifestEntry({ id: REVIEW_ID, read, name: REVIEW_NAME, date: REVIEW_DATE, size: bytes.length }) }
    return { id: REVIEW_ID, name: REVIEW_NAME, bytes, entry, read, fieldOf }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

export function writeReviewedCopy(instanceDir, copy, answered) {
  const dir = join(instanceDir, 'reviews')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${copy.id}.docx`), copy.bytes)
  return { ...copy.entry, commentsAnswered: answered }
}
