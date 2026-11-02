import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// #292 (parent #238, decided in #240): how the AI reads Source documents that are large, scanned or pictures. These are the
// pure rules: what goes how for an AI Provider, the reader the AI calls on a catalogue, the inputs a draft carries, and the
// wire formats that carry a PDF.
const { MAX_ATTACHMENT_BYTES, MAX_IMAGE_BYTES, MAX_READ_CHARS, READ_TOOL, accessForBrief, attachmentNote, describeInput, extractReadBlocks, fingerprintText, inputsForDraft, loadAttachments, pageSpans, pagesSummary, planSourceAccess, providerReadsImages, providerTakesPdfs, readSourceText, runReadCall, sourcesForBrief, stripReadBlocks } =
  await import('../web/lib/interviewSources.js')
const { buildChatRequest } = await import('../web/lib/aiAdapters.js')
const { buildInterviewBrief } = await import('../web/lib/interviewBrief.js')
const { loadInterviewSkills } = await import('../web/lib/interviewSkills.js')
const { createSourceStore, normalizeSourceEntry, parseSourceManifest, stringifySourceManifest } = await import('../web/lib/sourceDocuments.js')

const prov = (type, over = {}) => ({ id: type, type, model: 'm', address: 'http://x', key: 'k', test: { status: 'passed', readsImages: false, questionCards: 'native' }, ...over })
const sees = (type, over = {}) => prov(type, { test: { status: 'passed', readsImages: true, questionCards: 'native' }, ...over })

const pdfText = (n) => Array.from({ length: n }, (_, i) => `## Page ${i + 1}\n\nPage ${i + 1} says ${'word '.repeat(40)}`).join('\n\n')

const doc = (id, filename, over = {}) => ({ id, filename, title: id, size: 1000, ...over })

// ---------- what goes how ----------

test('which AI Providers take PDFs and pictures', () => {
  assert.equal(providerTakesPdfs(prov('anthropic')), true)
  assert.equal(providerTakesPdfs(prov('openai')), true)
  assert.equal(providerTakesPdfs(prov('ollama')), false)
  assert.equal(providerTakesPdfs(prov('lmstudio')), false)
  assert.equal(providerTakesPdfs(prov('custom')), false)
  // OpenRouter hands the PDF to the model itself, so the model has to see.
  assert.equal(providerTakesPdfs(prov('openrouter')), false)
  assert.equal(providerTakesPdfs(sees('openrouter')), true)
  assert.equal(providerReadsImages(sees('ollama')), true)
  assert.equal(providerReadsImages(prov('ollama')), false)
  assert.equal(providerReadsImages({ type: 'ollama' }), false, 'an untested AI Provider is not sent pictures')
  assert.equal(providerReadsImages({ type: 'ollama', test: { readsImages: null } }), false, 'an unsure one is not either')
})

test('a picture goes only to a model that reads images, and is unreadable otherwise', () => {
  const sources = [doc('whiteboard', 'whiteboard.png'), doc('photo', 'photo.JPG'), doc('anim', 'anim.gif'), doc('web', 'web.webp')]
  const yes = planSourceAccess({ sources, provider: sees('ollama') })
  assert.deepEqual([...yes.values()].map((a) => a.how), ['attach', 'attach', 'attach', 'attach'])
  assert.deepEqual([...yes.values()].map((a) => a.mediaType), ['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
  const no = planSourceAccess({ sources, provider: prov('ollama') })
  assert.deepEqual([...no.values()].map((a) => a.how), ['unreadable', 'unreadable', 'unreadable', 'unreadable'])
  assert.match(no.get('whiteboard').reason, /can't read images/)
})

test('a PDF with a text layer goes as text, even to a provider that takes PDFs', () => {
  const plan = planSourceAccess({ sources: [doc('spec', 'spec.pdf', { text: pdfText(3) })], provider: prov('anthropic') })
  assert.equal(plan.get('spec').how, 'text')
})

test('a scanned PDF (no text) goes as a PDF to a provider that takes them, and is unreadable otherwise', () => {
  const sources = [doc('scan', 'scan.pdf')]
  assert.equal(planSourceAccess({ sources, provider: prov('anthropic') }).get('scan').how, 'attach')
  assert.equal(planSourceAccess({ sources, provider: prov('openai') }).get('scan').how, 'attach')
  assert.equal(planSourceAccess({ sources, provider: sees('openrouter') }).get('scan').how, 'attach')
  const lost = planSourceAccess({ sources, provider: prov('ollama') }).get('scan')
  assert.equal(lost.how, 'unreadable')
  assert.match(lost.reason, /scanned PDF/)
  assert.equal(planSourceAccess({ sources, provider: prov('openrouter') }).get('scan').how, 'unreadable', 'OpenRouter with a text-only model cannot take the PDF natively')
})

test('Read visually sends the PDF itself where it can, and falls back to its text where it cannot', () => {
  const sources = [doc('diagram', 'diagram.pdf', { text: pdfText(2), readVisually: true })]
  const sent = planSourceAccess({ sources, provider: prov('anthropic') }).get('diagram')
  assert.deepEqual([sent.how, sent.kind, sent.mediaType], ['attach', 'pdf', 'application/pdf'])
  const fallback = planSourceAccess({ sources, provider: prov('ollama') }).get('diagram')
  assert.equal(fallback.how, 'text')
  assert.match(fallback.note, /marked Read visually/)
  // A scan marked visual on a provider that can't take it has nothing to fall back to.
  const scan = planSourceAccess({ sources: [doc('s', 's.pdf', { readVisually: true })], provider: prov('ollama') }).get('s')
  assert.equal(scan.how, 'unreadable')
})

test('other documents with text go as text; a removed one is left out; an empty one is unreadable', () => {
  const plan = planSourceAccess({
    sources: [doc('brief', 'brief.docx', { text: 'x' }), doc('gone', 'gone.docx', { text: 'x', removedAt: 'now' }), doc('blank', 'blank.xlsx')],
    provider: prov('anthropic'),
  })
  assert.equal(plan.get('brief').how, 'text')
  assert.equal(plan.has('gone'), false)
  assert.equal(plan.get('blank').how, 'unreadable')
})

test('nothing too big is sent: one picture over the limit, or originals over the total', () => {
  const big = planSourceAccess({ sources: [doc('huge', 'huge.png', { size: MAX_IMAGE_BYTES + 1 })], provider: sees('anthropic') })
  assert.equal(big.get('huge').how, 'unreadable')
  assert.match(big.get('huge').reason, /over the 5\.0 MB/)
  const each = Math.floor(MAX_ATTACHMENT_BYTES / 2) + 1
  const plan = planSourceAccess({ sources: [doc('a', 'a.pdf', { size: each }), doc('b', 'b.pdf', { size: each })], provider: prov('anthropic') })
  assert.equal(plan.get('a').how, 'attach')
  assert.equal(plan.get('b').how, 'unreadable')
  assert.match(plan.get('b').reason, /past the 15 MB/)
})

test('an attached document has its text left out of the brief, and is described to it', () => {
  const sources = [doc('diagram', 'diagram.pdf', { text: pdfText(1), readVisually: true }), doc('brief', 'brief.md', { text: 'hello' })]
  const plan = planSourceAccess({ sources, provider: prov('anthropic') })
  const forBrief = sourcesForBrief(sources, plan)
  assert.equal(forBrief[0].text, undefined)
  assert.equal(forBrief[1].text, 'hello')
  assert.deepEqual(accessForBrief(plan).diagram, { how: 'attach', kind: 'pdf' })
})

// ---------- attaching ----------

test('the originals to attach are loaded once, as base64, and a missing file is reported', async () => {
  const sources = [doc('pic', 'pic.png'), doc('scan', 'scan.pdf'), doc('lost', 'lost.png')]
  const plan = planSourceAccess({ sources, provider: sees('anthropic') })
  let loads = 0
  const bytes = { pic: new Uint8Array([1, 2, 3]), scan: new Uint8Array([4, 5, 6]) }
  const loadBytes = async (id) => {
    loads++
    return bytes[id] ?? null
  }
  const cache = new Map()
  const loaded = await loadAttachments({ sources, plan, loadBytes, cache })
  assert.equal(loaded.images.length, 1)
  assert.equal(loaded.images[0].data, Buffer.from([1, 2, 3]).toString('base64'))
  assert.equal(loaded.documents[0].mediaType, 'application/pdf')
  assert.equal(loaded.documents[0].filename, 'scan.pdf')
  assert.match(loaded.problems.lost, /could not be read/)
  await loadAttachments({ sources, plan, loadBytes, cache })
  assert.equal(loads, 3, 'each file is read once; the second call is from the cache')
  assert.match(attachmentNote(loaded), /image 1 is Source document `pic`/)
  assert.match(attachmentNote(loaded), /PDF 1 is Source document `scan`/)
  assert.equal(attachmentNote({ images: [], documents: [] }), '')
})

test('a PDF is a document block on Anthropic and a file part on the OpenAI format, and OpenRouter sets its engine', () => {
  const message = { role: 'user', text: 'Read this', images: [{ mediaType: 'image/png', data: 'AAA' }], documents: [{ filename: 'scan.pdf', mediaType: 'application/pdf', data: 'BBB' }] }
  const anthropic = buildChatRequest(prov('anthropic', { address: 'https://api.anthropic.com' }), { messages: [message] })
  assert.deepEqual(
    anthropic.body.messages[0].content.map((b) => b.type),
    ['image', 'document', 'text']
  )
  assert.deepEqual(anthropic.body.messages[0].content[1].source, { type: 'base64', media_type: 'application/pdf', data: 'BBB' })

  const openai = buildChatRequest(prov('openai', { address: 'https://api.openai.com/v1' }), { messages: [message] })
  assert.deepEqual(
    openai.body.messages[0].content.map((b) => b.type),
    ['text', 'image_url', 'file']
  )
  assert.deepEqual(openai.body.messages[0].content[2].file, { filename: 'scan.pdf', file_data: 'data:application/pdf;base64,BBB' })
  assert.equal(openai.body.plugins, undefined)

  const router = buildChatRequest(sees('openrouter', { address: 'https://openrouter.ai/api/v1' }), { messages: [message] })
  assert.deepEqual(router.body.plugins, [{ id: 'file-parser', pdf: { engine: 'native' } }])
  const plain = buildChatRequest(sees('openrouter', { address: 'https://openrouter.ai/api/v1' }), { messages: [{ role: 'user', text: 'hi' }] })
  assert.equal(plain.body.plugins, undefined, 'no PDF, no plugin')
})

// ---------- the reader ----------

const longText = [
  '# Handbook',
  '',
  'Intro text.',
  '',
  '## Scope',
  '',
  'The scope is claims. '.repeat(10),
  '',
  '### Out of scope',
  '',
  'Payments are out.',
  '',
  '## Risks',
  '',
  'There are risks.',
].join('\n')

test('reading a part of a document: by pages, by section, by characters, or from the start', () => {
  const pdf = pdfText(5)
  const pages = readSourceText(pdf, 'pages 2-3')
  assert.equal(pages.ok, true)
  assert.equal(pages.label, 'pages 2–3')
  assert.match(pages.text, /^## Page 2/)
  assert.match(pages.text, /Page 3 says/)
  assert.doesNotMatch(pages.text, /Page 4/)
  assert.equal(readSourceText(pdf, 'page 4').label, 'page 4')
  assert.equal(readSourceText(pdf, 'Pages: 5').label, 'page 5')
  assert.equal(readSourceText(pdf, 'pages 5-4').label, 'pages 4–5')

  const section = readSourceText(longText, 'section: Scope')
  assert.equal(section.label, 'section "Scope"')
  assert.match(section.text, /^## Scope/)
  assert.match(section.text, /Out of scope/, 'a section runs through its sub-sections')
  assert.doesNotMatch(section.text, /There are risks/)
  assert.equal(readSourceText(longText, 'risks').label, 'section "Risks"')
  assert.equal(readSourceText(longText, 'section: "Out of scope"').text, '### Out of scope\n\nPayments are out.')

  const chars = readSourceText(longText, '0-10')
  assert.equal(chars.text, '# Handbook')
  assert.equal(chars.label, 'characters 0–10')
  assert.equal(readSourceText(longText, 'characters 3-7').text, 'andb')

  const start = readSourceText(longText, undefined)
  assert.equal(start.from, 0)
  assert.equal(start.to, longText.length)
  assert.equal(start.truncated, false)
})

test('a read that asks for something the document does not have says what it does have', () => {
  assert.match(readSourceText(longText, 'pages 2').error, /no pages/)
  assert.match(readSourceText(pdfText(3), 'pages 9').error, /pages 1–3/)
  const noSection = readSourceText(longText, 'section: Budget')
  assert.equal(noSection.ok, false)
  assert.match(noSection.error, /Handbook \/ Scope/)
  assert.match(readSourceText(longText, '50-10').error, /empty/)
  assert.match(readSourceText('no headings here', 'section: x').error, /no headings/)
})

test('one read is capped, and says where to carry on', () => {
  const text = 'a'.repeat(MAX_READ_CHARS * 2 + 5)
  const first = readSourceText(text, '')
  assert.equal(first.truncated, true)
  assert.equal(first.to, MAX_READ_CHARS)
  const call = runReadCall({ id: 'big' }, { lookup: () => ({ id: 'big', title: 'Big', text }), access: { how: 'text' } })
  assert.equal(call.ok, true)
  assert.match(call.content, new RegExp(`Carry on with range "${MAX_READ_CHARS}-${MAX_READ_CHARS * 2}"`))
  assert.match(call.content, /^\[Big · characters 0–30,000 · characters 0–30,000 of 60,005\]/)
  const next = readSourceText(text, `${MAX_READ_CHARS}-${MAX_READ_CHARS * 2}`)
  assert.equal(next.truncated, false)
})

test('a read call: the text back to the AI, and the read recorded as an input', () => {
  const sources = { handbook: { id: 'handbook', title: 'Handbook', filename: 'handbook.docx', text: longText }, scan: { id: 'scan', title: 'Scan', filename: 'scan.pdf' }, pic: { id: 'pic', title: 'Pic', filename: 'pic.png' } }
  const lookup = (id) => sources[id]
  const ok = runReadCall({ id: 'handbook', range: 'section: Risks' }, { lookup, access: { how: 'text' } })
  assert.equal(ok.ok, true)
  assert.match(ok.content, /^\[Handbook · section "Risks"/)
  assert.match(ok.content, /There are risks/)
  assert.deepEqual({ ...ok.read, fingerprint: undefined }, { source: 'handbook', title: 'Handbook', range: 'section "Risks"', fingerprint: undefined, chars: ok.read.chars })
  assert.equal(ok.read.fingerprint, fingerprintText(readSourceText(longText, 'section: Risks').text))

  const whole = runReadCall({ id: 'handbook' }, { lookup, access: { how: 'text' } })
  assert.equal(whole.read.range, null, 'a read of the whole document has no range')

  const missing = runReadCall({ id: 'nope' }, { lookup, access: undefined })
  assert.equal(missing.ok, false)
  assert.match(missing.content, /no Source document "nope"/)
  assert.match(runReadCall({ id: 'scan' }, { lookup, access: { how: 'attach', kind: 'pdf' } }).content, /attached to the first message as a PDF/)
  assert.match(runReadCall({ id: 'pic' }, { lookup, access: { how: 'unreadable', reason: "it is a picture and this model can't read images" } }).content, /can't read images/)
  assert.equal(runReadCall({ id: 'handbook', range: 'pages 3' }, { lookup, access: { how: 'text' } }).ok, false)
})

test('the text fallback asks to read in a fenced block, and the block is hidden from the screen', () => {
  const text = 'Let me look.\n\n```gantry-read\n{"id":"brief","range":"pages 1-2"}\n```\n\n```gantry-read\n[{"id":"costs"}]\n```\n\nBad:\n```gantry-read\nnot json\n```'
  const { reads, errors } = extractReadBlocks(text)
  assert.deepEqual(reads, [{ id: 'brief', range: 'pages 1-2' }, { id: 'costs', range: undefined }])
  assert.equal(errors.length, 1)
  assert.match(errors[0], /not valid JSON/)
  assert.equal(stripReadBlocks(text).startsWith('Let me look.'), true)
  assert.doesNotMatch(stripReadBlocks(text), /gantry-read/)
  assert.equal(stripReadBlocks('Reading now\n```gantry-read\n{"id":'), 'Reading now', 'a block still being written is hidden too')
  assert.equal(READ_TOOL.name, 'read_source_document')
  assert.deepEqual(READ_TOOL.parameters.required, ['id'])
})

// ---------- inputs ----------

test('a draft\'s inputs are the reads before it and the documents it cites', () => {
  const sources = [
    { id: 'brief', title: 'Client brief', text: 'The brief.' },
    { id: 'costs', title: 'Costs', text: 'The costs.' },
  ]
  const reads = [
    { source: 'brief', title: 'Client brief', range: 'pages 3–5', fingerprint: 'aaa' },
    { source: 'brief', title: 'Client brief', range: 'pages 3–5', fingerprint: 'aaa' },
  ]
  const inputs = inputsForDraft({ reads, value: 'Claims are slow [Client brief, p. 4](source:brief) and cost $5 [Costs](source:costs).', sources })
  assert.deepEqual(inputs.map(describeInput), ['Client brief (pages 3–5)', 'Costs'])
  assert.equal(inputs[1].fingerprint, fingerprintText('The costs.'))
  assert.deepEqual(inputsForDraft({ reads: [], value: 'plain', sources }), [])
  assert.deepEqual(inputsForDraft({ reads: [], value: ['a [x](source:ghost)'], sources }), [], 'a citation of an unknown document is not an input')
  assert.notEqual(fingerprintText('a'), fingerprintText('b'))
  assert.equal(fingerprintText('a'), fingerprintText('a'))
  assert.equal(pagesSummary(pdfText(3)), 'pages 1–3')
  assert.equal(pageSpans(pdfText(3)).length, 3)
})

// ---------- the brief ----------

const SKILLS_DIR = new URL('../web/interview-skills/', import.meta.url)
const skills = await loadInterviewSkills((path) => readFileSync(new URL(path, SKILLS_DIR), 'utf8'))
const definition = {
  id: 'd',
  stages: [{ id: 's', title: 'S', gate: 'g', modules: ['m'] }],
  artefacts: [{ id: 'a', title: 'A', gate: 'g', requires: ['m.f'] }],
  modules: [{ id: 'm', title: 'M', fields: [{ id: 'f', title: 'F', type: 'markdown' }] }],
}

test('the brief lists a catalogue with sizes and pages, tells the AI how to read, and marks each document with no text', () => {
  const sources = [
    doc('handbook', 'handbook.pdf', { text: pdfText(40) }),
    doc('scan', 'scan.pdf'),
    doc('pic', 'pic.png'),
    doc('visual', 'visual.pdf', { text: pdfText(2), readVisually: true }),
  ]
  const plan = planSourceAccess({ sources, provider: prov('anthropic') })
  const brief = buildInterviewBrief({ definition, stageId: 's', skills, sources: sourcesForBrief(sources, plan), contextWindow: 2000, readerTool: true, sourceAccess: accessForBrief(plan) })
  assert.equal(brief.sources.mode, 'catalogue')
  assert.deepEqual(brief.sources.attached.sort(), ['scan', 'visual'])
  assert.deepEqual(brief.sources.unreadable, ['pic'])
  assert.match(brief.text, /read_source_document\(id, range\)/)
  assert.match(brief.text, /\*\*handbook\*\* \(id `handbook`, handbook\.pdf.*characters, pages 1–40/)
  assert.match(brief.text, /scan\.pdf\): attached to the first message as the PDF itself/)
  assert.match(brief.text, /visual\.pdf\): attached to the first message as the PDF itself/)
  assert.match(brief.text, /pic\.png\): UNREADABLE \(it is a picture and this model can't read images\)/)
  assert.doesNotMatch(brief.text, /Page 1 says/, 'a catalogue carries none of the text')
})

test('the brief, when everything fits, carries the text whole and still lists what it cannot show', () => {
  const sources = [doc('brief', 'brief.md', { text: 'The insurer wants faster claims.' }), doc('pic', 'pic.png')]
  const plan = planSourceAccess({ sources, provider: sees('anthropic') })
  const brief = buildInterviewBrief({ definition, stageId: 's', skills, sources: sourcesForBrief(sources, plan), contextWindow: 200000, readerTool: true, sourceAccess: accessForBrief(plan) })
  assert.equal(brief.sources.mode, 'whole')
  assert.match(brief.text, /The insurer wants faster claims\./)
  assert.match(brief.text, /pic\.png\): attached to the first message as a picture/)
  const asText = buildInterviewBrief({ definition, stageId: 's', skills, sources: [doc('pic', 'pic.png')], contextWindow: 200000, sourceAccess: accessForBrief(planSourceAccess({ sources: [doc('pic', 'pic.png')], provider: prov('ollama') })) })
  assert.match(asText.text, /None of the documents has text to show here/)
})

test('a Read visually note reaches the AI when the provider cannot take the PDF', () => {
  const sources = [doc('diagram', 'diagram.pdf', { text: pdfText(1), readVisually: true })]
  const plan = planSourceAccess({ sources, provider: prov('ollama') })
  const brief = buildInterviewBrief({ definition, stageId: 's', skills, sources: sourcesForBrief(sources, plan), contextWindow: 200000, sourceAccess: accessForBrief(plan) })
  assert.match(brief.text, /Note: diagram \(id `diagram`\) is marked Read visually, but this AI Provider doesn't take PDFs, so its text is used\./)
  assert.match(brief.text, /Page 1 says/)
})

// ---------- Read visually is kept in the manifest ----------

function memoryIo() {
  const files = new Map()
  const versions = new Map()
  return {
    files,
    async readText(path) {
      const v = files.get(path)
      return typeof v === 'string' ? { text: v, version: String(versions.get(path)) } : null
    },
    async readBytes(path) {
      const v = files.get(path)
      return v instanceof Uint8Array ? v : null
    },
    async writeText(path, text) {
      files.set(path, text)
      versions.set(path, (versions.get(path) ?? 0) + 1)
    },
    async writeBytes(path, bytes) {
      files.set(path, bytes)
    },
    async remove(path) {
      files.delete(path)
    },
  }
}

test('Read visually is kept on the manifest entry only while it is on, and only a PDF can have it', async () => {
  const io = memoryIo()
  const store = createSourceStore(io, { now: () => '2026-11-02T00:00:00.000Z' })
  const pdf = (await store.upload({ filename: 'plan.pdf', bytes: new Uint8Array([1]), text: pdfText(1) })).entry
  const word = (await store.upload({ filename: 'notes.docx', bytes: new Uint8Array([1]), text: 'x' })).entry

  assert.equal(pdf.readVisually, undefined)
  const on = await store.setReadVisually(pdf.id, true)
  assert.equal(on.readVisually, true)
  assert.match(io.files.get('sources/manifest.yaml'), /readVisually: true/)
  assert.equal((await store.list()).entries.find((e) => e.id === pdf.id).readVisually, true)

  // Re-reading its text, or renaming it, leaves the choice alone.
  await store.setText(pdf.id, pdfText(2))
  await store.rename(pdf.id, 'The plan')
  assert.equal((await store.list()).entries.find((e) => e.id === pdf.id).readVisually, true)

  const off = await store.setReadVisually(pdf.id, false)
  assert.equal(off.readVisually, undefined)
  assert.doesNotMatch(io.files.get('sources/manifest.yaml'), /readVisually/)

  await assert.rejects(() => store.setReadVisually(word.id, true), (err) => err.code === 'not-a-pdf' && err.status === 400)
  await assert.rejects(() => store.setReadVisually('nope', true), (err) => err.code === 'not-found')
})

test('the manifest round-trips Read visually and an old manifest is unchanged', () => {
  const entry = { id: 'a', filename: 'a.pdf', title: 'A', uploadedBy: '', size: 1, readVisually: true }
  assert.deepEqual(parseSourceManifest(stringifySourceManifest([entry]))[0].readVisually, true)
  assert.equal('readVisually' in normalizeSourceEntry({ ...entry, readVisually: false }), false)
  assert.equal('readVisually' in normalizeSourceEntry({ ...entry, readVisually: 'yes' }), false, 'only a true boolean counts')
})
