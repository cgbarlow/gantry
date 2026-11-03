import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createSourceStore, fingerprintText, replacedBy } from '../web/lib/sourceDocuments.js'
import { fingerprintText as sessionFingerprint } from '../web/lib/interviewSources.js'
import { mergeStage } from '../web/lib/stageVersion.js'
import { loadOutOfDate } from '../web/lib/outOfDateState.js'
import {
  SOURCE_UPDATE_KIND,
  findOutOfDateFields,
  flagsForField,
  lastInterviewAt,
  newSinceLastInterview,
  outOfDateBannerLines,
  outOfDateCountByStage,
  outOfDateFieldNote,
  outOfDateKeys,
} from '../web/lib/outOfDate.js'

// #297 (map #238, decided in #249): which Fields are Out of date because a Source document they drew on changed. The store half (the
// manifest records the "replaces" link and when the text actually changed) is driven over an in-memory folder; the detection is a pure
// function of the manifest, the decisions logs and the saved content.

const bytes = (text) => new TextEncoder().encode(text)
const clock = () => {
  let n = 0
  return () => `2026-11-0${Math.min(9, 1 + n++)}T09:00:00.000Z`
}

function memoryIo() {
  const files = new Map()
  const versions = new Map()
  let counter = 0
  return {
    files,
    async readText(path) {
      return files.has(path) ? { text: new TextDecoder().decode(files.get(path)), version: versions.get(path) } : null
    },
    async readBytes(path) {
      return files.has(path) ? files.get(path) : null
    },
    async writeText(path, text, { ifVersion } = {}) {
      if (ifVersion !== undefined && (versions.get(path) ?? null) !== ifVersion) throw Object.assign(new Error('conflict'), { code: 'STORAGE_CONFLICT' })
      files.set(path, new TextEncoder().encode(text))
      versions.set(path, `v${++counter}`)
    },
    async writeBytes(path, data) {
      files.set(path, data)
      versions.set(path, `v${++counter}`)
    },
    async remove(path) {
      files.delete(path)
      versions.delete(path)
    },
  }
}

describe('the manifest records a replacement and an actual text change', () => {
  test('"This replaces..." is stored on the new document and the older one is left alone and still citable', async () => {
    const store = createSourceStore(memoryIo(), { now: clock() })
    await store.upload({ filename: 'Client brief v2.docx', bytes: bytes('v2'), text: 'old text' })
    const { entry } = await store.upload({ filename: 'Client brief v3.docx', bytes: bytes('v3'), text: 'new text', replaces: 'client-brief-v2' })
    assert.equal(entry.replaces, 'client-brief-v2')
    const { entries } = await store.list()
    const older = entries.find((e) => e.id === 'client-brief-v2')
    assert.equal(older.removedAt, undefined, 'the older document is not removed')
    assert.equal(older.replaces, undefined, 'only the newer document holds the link')
    assert.equal(replacedBy(entries, 'client-brief-v2').id, 'client-brief-v3')
    assert.equal(replacedBy(entries, 'client-brief-v3'), null)
    assert.equal(await store.readText('client-brief-v2'), 'old text', 'the older document stays readable')
  })

  test('replacing a document that is not there, or has been removed, is refused', async () => {
    const store = createSourceStore(memoryIo(), { now: clock() })
    await store.upload({ filename: 'a.md', bytes: bytes('a'), text: 'a' })
    await store.remove('a')
    await assert.rejects(store.upload({ filename: 'b.md', bytes: bytes('b'), replaces: 'a' }), /removed/)
    await assert.rejects(store.upload({ filename: 'b.md', bytes: bytes('b'), replaces: 'nope' }), /No Source document/)
    assert.equal((await store.list()).entries.length, 1, 'a refused upload leaves nothing behind')
  })

  test('an upload that replaces nothing leaves the manifest exactly as before', async () => {
    const store = createSourceStore(memoryIo(), { now: clock() })
    const { entry } = await store.upload({ filename: 'a.md', bytes: bytes('a'), text: 'a' })
    assert.deepEqual(Object.keys(entry), ['id', 'filename', 'title', 'uploadedBy', 'uploadedAt', 'size', 'text'])
  })

  test('reading the text again records a change only when the text really differs', async () => {
    const store = createSourceStore(memoryIo(), { now: clock() })
    await store.upload({ filename: 'a.md', bytes: bytes('a'), text: 'same text' })
    const same = await store.setText('a', 'same text')
    assert.equal(same.textChangedAt, undefined, 'identical text is no change')
    const different = await store.setText('a', 'different text')
    assert.ok(different.textChangedAt, 'different text is a change')
    const again = await store.setText('a', 'different text')
    assert.equal(again.textChangedAt, different.textChangedAt, 'reading the same text again keeps the time of the real change')
  })

  test('the fingerprint is the one the interview records', () => {
    assert.equal(fingerprintText('abc'), sessionFingerprint('abc'))
  })
})

const brief = { id: 'client-brief', filename: 'Client brief.docx', title: 'Client brief', uploadedAt: '2026-11-01T09:00:00.000Z' }
const modules = [
  { id: 'background', fields: [{ id: 'problem', value: 'The platform must support 5000 users [Client brief](source:client-brief).' }, { id: 'goals', value: 'Grow.' }] },
  { id: 'scope', fields: [{ id: 'in', value: 'Everything.' }, { id: 'notes', value: 'Hand written, no citation.' }] },
]
const draftedLog = (inputs, drafted = '2026-11-02T10:00:00.000Z', extra = {}) => ({
  stage: 'discover',
  status: [{ session: 's1', lastAiSave: drafted }],
  fields: { 'scope.in': { drafted, inputs, entries: [] } },
  entries: [],
  ...extra,
})

describe('which Fields are flagged', () => {
  test('removing a document flags the AI-drafted Fields that list it and the content that cites it, and nothing else', () => {
    const sources = [{ ...brief, removedAt: '2026-11-03T09:00:00.000Z' }]
    const flags = findOutOfDateFields({
      sources,
      logs: { discover: draftedLog([{ source: 'client-brief', title: 'Client brief', range: 'pages 1-2', fingerprint: 'x' }]) },
      modules,
      stageModules: { discover: ['background', 'scope'] },
    })
    assert.deepEqual(outOfDateKeys(flags).sort(), ['background.problem', 'scope.in'])
    const cited = flagsForField(flags, 'background.problem')[0]
    assert.equal(cited.change, 'removed')
    assert.deepEqual(cited.via, ['cited'])
    assert.deepEqual(cited.stages, ['discover'])
    assert.deepEqual(flagsForField(flags, 'scope.in')[0].via, ['drafted'])
    assert.equal(flagsForField(flags, 'background.goals').length, 0)
    assert.equal(flagsForField(flags, 'scope.notes').length, 0)
  })

  test('replacing flags the same Fields and says what replaced the document', () => {
    const sources = [brief, { id: 'client-brief-v3', filename: 'Client brief v3.docx', title: 'Client brief v3', uploadedAt: '2026-11-03T09:00:00.000Z', replaces: 'client-brief' }]
    const flags = findOutOfDateFields({ sources, logs: { discover: draftedLog([{ source: 'client-brief', fingerprint: 'x' }]) }, modules })
    assert.deepEqual(outOfDateKeys(flags).sort(), ['background.problem', 'scope.in'])
    assert.equal(flags[0].change, 'replaced')
    assert.deepEqual(flags[0].replacedBy, { id: 'client-brief-v3', title: 'Client brief v3' })
    assert.match(outOfDateFieldNote([flags[0]]), /Client brief was replaced by Client brief v3/)
  })

  test('re-extracting flags only when the text changed (the manifest only records a real change)', () => {
    const logs = { discover: draftedLog([{ source: 'client-brief', fingerprint: 'x' }]) }
    assert.deepEqual(findOutOfDateFields({ sources: [brief], logs, modules }), [], 'identical text: nothing is flagged')
    const changed = findOutOfDateFields({ sources: [{ ...brief, textChangedAt: '2026-11-03T09:00:00.000Z' }], logs, modules })
    assert.deepEqual(outOfDateKeys(changed).sort(), ['background.problem', 'scope.in'])
    assert.equal(changed[0].change, 're-extracted')
  })

  test('a new document that replaces nothing flags nothing and is marked New since last interview', () => {
    const fresh = { id: 'minutes', filename: 'Minutes.md', title: 'Minutes', uploadedAt: '2026-11-04T09:00:00.000Z' }
    const logs = { discover: draftedLog([{ source: 'client-brief', fingerprint: 'x' }]) }
    assert.deepEqual(findOutOfDateFields({ sources: [brief, fresh], logs, modules }), [])
    assert.deepEqual(newSinceLastInterview([brief, fresh], logs).map((s) => s.id), ['minutes'])
  })

  test('New since last interview needs an interview, ignores replacements and removed documents, and ends at the next AI save', () => {
    const fresh = { id: 'minutes', filename: 'Minutes.md', title: 'Minutes', uploadedAt: '2026-11-04T09:00:00.000Z' }
    assert.deepEqual(newSinceLastInterview([fresh], {}), [], 'no interview has run: nothing is "new since" it')
    const logs = { discover: draftedLog([], '2026-11-02T10:00:00.000Z') }
    assert.equal(lastInterviewAt(logs), '2026-11-02T10:00:00.000Z')
    assert.deepEqual(newSinceLastInterview([{ ...fresh, replaces: 'client-brief' }, { ...fresh, id: 'gone', removedAt: '2026-11-05T09:00:00.000Z' }], logs), [])
    assert.deepEqual(newSinceLastInterview([fresh], { discover: draftedLog([], '2026-11-06T10:00:00.000Z') }), [], 'a later interview has read it')
    assert.deepEqual(newSinceLastInterview([{ ...fresh, uploadedAt: '2026-11-01T00:00:00.000Z' }], logs), [], 'uploaded before the interview')
  })

  test('drafting the Field again after the change clears its flag', () => {
    const sources = [{ ...brief, removedAt: '2026-11-03T09:00:00.000Z' }]
    const redrafted = draftedLog([{ source: 'client-brief', fingerprint: 'x' }], '2026-11-04T10:00:00.000Z')
    const flags = findOutOfDateFields({ sources, logs: { discover: redrafted }, modules })
    assert.equal(flagsForField(flags, 'scope.in').length, 0, 'redrafted after the change')
    assert.equal(flagsForField(flags, 'background.problem').length, 1, 'content that only cites it is not redrafted')
  })

  test("the architect's answer (a source-update entry made after the change) clears just that Field and document", () => {
    const sources = [{ ...brief, removedAt: '2026-11-03T09:00:00.000Z' }]
    const answered = draftedLog([{ source: 'client-brief', fingerprint: 'x' }], '2026-11-02T10:00:00.000Z', {
      entries: [{ id: 'u1', kind: SOURCE_UPDATE_KIND, at: '2026-11-03T12:00:00.000Z', source: 'client-brief', fields: ['background.problem'], outcome: 'keep' }],
    })
    const flags = findOutOfDateFields({ sources, logs: { discover: answered }, modules })
    assert.deepEqual(outOfDateKeys(flags), ['scope.in'])
    const early = draftedLog([{ source: 'client-brief', fingerprint: 'x' }], '2026-11-02T10:00:00.000Z', {
      entries: [{ id: 'u0', kind: SOURCE_UPDATE_KIND, at: '2026-11-03T08:00:00.000Z', source: 'client-brief', fields: ['background.problem'] }],
    })
    assert.equal(findOutOfDateFields({ sources, logs: { discover: early }, modules }).length, 2, 'an answer made before the change does not count')
  })

  test('the most serious unanswered change from a document is the one reported', () => {
    const entry = { ...brief, removedAt: '2026-11-06T09:00:00.000Z', textChangedAt: '2026-11-03T09:00:00.000Z' }
    const logs = { discover: draftedLog([{ source: 'client-brief', fingerprint: 'x' }]) }
    assert.equal(findOutOfDateFields({ sources: [entry], logs, modules })[0].change, 'removed')
  })

  test('a draft that drew on another Field is flagged once that Field is no longer what it saw', () => {
    const logs = {
      design: {
        stage: 'design',
        fields: { 'scope.in': { drafted: '2026-11-02T10:00:00.000Z', inputs: [{ field: 'background.goals', title: 'Goals', range: null, fingerprint: fingerprintText('Grow.') }] } },
        entries: [],
      },
    }
    assert.deepEqual(findOutOfDateFields({ sources: [], logs, modules }), [], 'the Field is as the draft saw it')
    const changed = modules.map((m) => (m.id === 'background' ? { ...m, fields: [m.fields[0], { id: 'goals', value: 'Grow, but slower.' }] } : m))
    const flags = findOutOfDateFields({ sources: [], logs, modules: changed })
    assert.equal(flags.length, 1)
    assert.deepEqual({ field: flags[0].field, cause: flags[0].cause, inputField: flags[0].inputField }, { field: 'scope.in', cause: 'field', inputField: 'background.goals' })
    assert.deepEqual(findOutOfDateFields({ sources: [], logs, modules: changed.slice(1) }), [], 'a Field whose content is not known is not guessed at')
  })

  test('the banner, the Field mark and the run plan read from the flags', () => {
    const sources = [brief, { id: 'client-brief-v3', filename: 'v3.docx', title: 'Client brief v3', uploadedAt: '2026-11-03T09:00:00.000Z', replaces: 'client-brief' }]
    const flags = findOutOfDateFields({
      sources,
      logs: { discover: draftedLog([{ source: 'client-brief', fingerprint: 'x' }]) },
      modules,
      stageModules: { discover: ['background', 'scope'], design: ['scope'] },
    })
    const [line] = outOfDateBannerLines(flags)
    assert.equal(line.text, '2 Fields drew on Client brief, now replaced by Client brief v3')
    assert.equal(line.count, 2)
    assert.deepEqual(outOfDateCountByStage(flags), { discover: 2 })
    assert.equal(outOfDateBannerLines([flags[0]])[0].text, '1 Field drew on Client brief, now replaced by Client brief v3')
  })
})

describe('the Save check taking the other side\'s version (ADR-0068)', () => {
  test('a later AI draft that drew on the Field is flagged once theirs is taken', () => {
    const payload = (goals) => ({ background: { status: 'draft', owner: '', fields: { goals }, layout: [{ field: 'goals' }] } })
    const settled = mergeStage({ base: payload('Grow.'), mine: payload('Grow.'), theirs: payload('Grow, but slower.') })
    assert.equal(settled.payloads.background.fields.goals, 'Grow, but slower.', 'only the saved side changed: theirs is taken')
    const logs = { design: { stage: 'design', fields: { 'scope.in': { drafted: '2026-11-02T10:00:00.000Z', inputs: [{ field: 'background.goals', fingerprint: fingerprintText('Grow.') }] } }, entries: [] } }
    const taken = Object.entries(settled.payloads).map(([id, p]) => ({ id, fields: p.fields }))
    const flags = findOutOfDateFields({ sources: [], logs, modules: [...taken, modules[1]] })
    assert.deepEqual(outOfDateKeys(flags), ['scope.in'])
    assert.equal(flags[0].cause, 'field')
    const kept = mergeStage({ base: payload('Grow.'), mine: payload('Grow.'), theirs: payload('Grow.') })
    assert.deepEqual(findOutOfDateFields({ sources: [], logs, modules: [...Object.entries(kept.payloads).map(([id, p]) => ({ id, fields: p.fields })), modules[1]] }), [])
  })
})

describe('loading what detection needs, in any workspace kind', () => {
  const listed = (entries) => ({ list: async () => ({ entries }) })
  const stages = [{ id: 'discover' }, { id: 'design' }]

  test('a workspace with no documents reads nothing else', async () => {
    const result = await loadOutOfDate({ sourceStore: listed([]), decisionsStore: { read: async () => assert.fail('no log is read') }, stages, currentStageId: 'discover', currentModules: [], loadStageModules: async () => assert.fail('no Stage is read') })
    assert.deepEqual(result.flags, [])
  })

  test('with nothing changed it reads no other Stage', async () => {
    const result = await loadOutOfDate({ sourceStore: listed([brief]), decisionsStore: null, stages, currentStageId: 'discover', currentModules: modules, loadStageModules: async () => assert.fail('no Stage is read') })
    assert.deepEqual(result.flags, [])
  })

  test('a remote workspace (no readable log yet) still flags the content that cites a removed document, across Stages', async () => {
    const result = await loadOutOfDate({
      sourceStore: listed([{ ...brief, removedAt: '2026-11-03T09:00:00.000Z' }]),
      decisionsStore: null,
      stages,
      currentStageId: 'discover',
      currentModules: [modules[1]],
      loadStageModules: async (stage) => (stage.id === 'design' ? [modules[0]] : []),
    })
    assert.deepEqual(outOfDateKeys(result.flags), ['background.problem'])
    assert.deepEqual(result.flags[0].stages, ['design'])
    assert.deepEqual(result.newSince, [])
  })

  test('a log that cannot be read does not hide the rest', async () => {
    const result = await loadOutOfDate({
      sourceStore: listed([{ ...brief, removedAt: '2026-11-03T09:00:00.000Z' }]),
      decisionsStore: { read: async (stageId) => (stageId === 'design' ? Promise.reject(new Error('unreadable')) : draftedLog([{ source: 'client-brief', fingerprint: 'x' }])) },
      stages,
      currentStageId: 'discover',
      currentModules: modules,
      loadStageModules: async () => [],
    })
    assert.deepEqual(outOfDateKeys(result.flags).sort(), ['background.problem', 'scope.in'])
  })
})
