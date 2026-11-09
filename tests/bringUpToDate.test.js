import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  UPDATE_CHOICES,
  flagReason,
  landingNote,
  newSinceNote,
  planUpdateRound,
  reciteCandidates,
  reciteValue,
  reopenOutlook,
  resolveUpdateCard,
  returnedToDraftNote,
  stagesToUpdate,
  updateAnswersText,
  updateCards,
  checkingFlagsNote,
  isStaleUpdateSession,
  roundPlanRows,
} from '../web/lib/bringUpToDate.js'
import { planRows } from '../web/lib/interviewRun.js'
import { SOURCE_UPDATE_KIND, findOutOfDateFields } from '../web/lib/outOfDate.js'
import { fingerprintText } from '../web/lib/sourceDocuments.js'
import { choose } from '../web/lib/interviewRounds.js'

// #298 (parent #238, decided in #249): Bring up to date. The pure parts: which flagged Fields a Stage's page can act on and where each change
// lands, the cards, what an answer means, and how an answer clears a flag.

const definition = {
  id: 'd',
  stages: [
    { id: 'shape', title: 'Shape', gate: 'g1', modules: ['background', 'risks'] },
    { id: 'design', title: 'Design', gate: 'g2', modules: ['background', 'solution', 'risks'], readOnlyModules: ['risks'] },
    { id: 'build', title: 'Build', gate: 'g3', modules: ['plan'] },
  ],
  modules: [
    { id: 'background', title: 'Background', fields: [{ id: 'problem', title: 'Problem' }, { id: 'goals', title: 'Goals' }] },
    { id: 'risks', title: 'Risks', fields: [{ id: 'list', title: 'Risk list' }] },
    { id: 'solution', title: 'Solution', fields: [{ id: 'overview', title: 'Overview' }] },
    { id: 'plan', title: 'Plan', fields: [{ id: 'body', title: 'Body' }] },
  ],
}
const stages = definition.stages.map((s) => ({ id: s.id, title: s.title }))
const title = (key) => ({ 'background.problem': 'Background · Problem', 'background.goals': 'Background · Goals', 'risks.list': 'Risks · Risk list', 'solution.overview': 'Solution · Overview', 'plan.body': 'Plan · Body' })[key] ?? key
const stageTitle = (id) => stages.find((s) => s.id === id)?.title ?? id

const replaced = (field, over = {}) => ({ field, cause: 'source', source: 'brief', sourceTitle: 'Client brief', change: 'replaced', since: '2026-11-02T10:00:00.000Z', replacedBy: { id: 'brief-v3', title: 'Client brief v3' }, via: ['cited'], stages: ['shape'], ...over })
const removed = (field, over = {}) => ({ field, cause: 'source', source: 'brief', sourceTitle: 'Client brief', change: 'removed', since: '2026-11-02T10:00:00.000Z', via: ['cited'], stages: ['shape'], ...over })
const earlierField = (field, inputField) => ({ field, cause: 'field', inputField, change: 'changed', via: ['drafted'], stages: ['design'] })
const saved = [
  { id: 'background', status: 'draft', fields: [{ id: 'problem', value: 'Slow claims [Client brief, p. 1](source:brief).' }, { id: 'goals', value: 'Faster.' }] },
  { id: 'risks', status: 'draft', fields: [{ id: 'list', value: ['Risk A [Client brief](source:brief)'] }] },
  { id: 'solution', status: 'draft', fields: [{ id: 'overview', value: 'Build it.' }] },
  { id: 'plan', status: 'draft', fields: [{ id: 'body', value: 'Plan [Client brief](source:brief).' }] },
]
const sources = [
  { id: 'brief', title: 'Client brief', filename: 'brief.md', uploadedAt: '2026-11-01T09:00:00.000Z' },
  { id: 'brief-v3', title: 'Client brief v3', filename: 'brief-v3.md', uploadedAt: '2026-11-02T10:00:00.000Z', replaces: 'brief' },
  { id: 'minutes', title: 'Minutes', filename: 'minutes.md', uploadedAt: '2026-11-01T09:00:00.000Z' },
]

describe('planUpdateRound: which flagged Fields a Stage acts on', () => {
  test('a local or server workspace brings a Field up to date in place, on the Stage where its Module is edited', () => {
    const flags = [replaced('background.problem'), replaced('risks.list')]
    const onShape = planUpdateRound({ flags, definition, pageStageId: 'shape', saved })
    assert.deepEqual(onShape.items.map((i) => [i.key, i.landing.kind]), [['background.problem', 'in-place'], ['risks.list', 'in-place']])
    assert.deepEqual(onShape.elsewhere, [])
    // On Design, Risks is read-only: that Field is asked about on Shape, and nothing is lost.
    const onDesign = planUpdateRound({ flags, definition, pageStageId: 'design', saved })
    assert.deepEqual(onDesign.items.map((i) => i.key), ['background.problem'])
    assert.deepEqual(onDesign.elsewhere, [{ key: 'risks.list', stageId: 'shape' }])
  })

  test('carries each item the saved text, and several flags on one Field make one item', () => {
    const flags = [replaced('background.problem'), earlierField('background.problem', 'risks.list')]
    const { items } = planUpdateRound({ flags, definition, pageStageId: 'shape', saved })
    assert.equal(items.length, 1)
    assert.equal(items[0].flags.length, 2)
    assert.match(items[0].saved, /^Slow claims/)
  })

  test('remote: a Field of an approved Stage whose Module is editable on the current Stage is carried forward', () => {
    const { items } = planUpdateRound({ flags: [replaced('background.problem')], definition, pageStageId: 'design', currentStageId: 'design', remote: true, saved })
    assert.deepEqual(items.map((i) => i.landing), [{ kind: 'carry-forward', stageId: 'shape', awaiting: false }])
  })

  test('remote: a carried-forward change to a Stage awaiting approval goes on its branch, updating its Pull Request', () => {
    const { items } = planUpdateRound({ flags: [replaced('background.problem')], definition, pageStageId: 'design', currentStageId: 'design', remote: true, awaiting: ['design'], saved })
    assert.equal(items[0].landing.kind, 'carry-forward')
    assert.equal(items[0].landing.awaiting, true)
    assert.match(landingNote(items[0].landing, { stageTitle, currentTitle: 'Design' }), /awaiting approval, so the change is saved on its branch and updates its Pull Request/)
  })

  test("remote: a Stage awaiting approval takes the change to its own Field on its own branch", () => {
    const flags = [replaced('solution.overview', { stages: ['design'] })]
    const { items } = planUpdateRound({ flags, definition, pageStageId: 'design', currentStageId: 'design', remote: true, awaiting: ['design'], saved })
    assert.deepEqual(items[0].landing, { kind: 'own-branch', stageId: 'design' })
    assert.match(landingNote(items[0].landing, { stageTitle, currentTitle: 'Design' }), /Design is awaiting approval. A change is saved on its own branch and updates its Pull Request/)
  })

  test('remote: a Field a signed-off Stage owns that the current Stage cannot edit is offered as a re-open when ADR-0026 allows it', () => {
    const { items } = planUpdateRound({ flags: [replaced('risks.list')], definition, pageStageId: 'design', currentStageId: 'design', remote: true, saved })
    assert.deepEqual(items.map((i) => [i.key, i.landing.kind, i.landing.stageId]), [['risks.list', 'reopen', 'shape']])
  })

  test('remote: otherwise it becomes an open question naming the blocker', () => {
    const { items } = planUpdateRound({ flags: [replaced('risks.list')], definition, pageStageId: 'design', currentStageId: 'design', remote: true, inProgress: ['design'], saved })
    assert.equal(items[0].landing.kind, 'open-question')
    assert.match(items[0].landing.blocker, /Design is already in progress/)
    assert.match(items[0].landing.blocker, /ADR-0026/)
  })

  test('remote: a Field of a drafted-ahead Stage is never touched', () => {
    const flags = [replaced('plan.body', { stages: ['build'] })]
    const plan = planUpdateRound({ flags, definition, pageStageId: 'design', currentStageId: 'design', remote: true, saved })
    assert.deepEqual(plan.items, [])
    assert.deepEqual(plan.deferred, [{ key: 'plan.body', stageId: 'build' }])
  })

  test('remote: a page on a drafted-ahead Stage changes nothing: its Fields are left flagged', () => {
    const flags = [replaced('plan.body', { stages: ['build'] }), replaced('background.problem')]
    const plan = planUpdateRound({ flags, definition, pageStageId: 'build', currentStageId: 'design', remote: true, saved })
    assert.deepEqual(plan.items, [])
    assert.deepEqual(plan.deferred, [{ key: 'plan.body', stageId: 'build' }])
  })

  test('items come earliest Stage first', () => {
    const flags = [replaced('solution.overview', { stages: ['design'] }), replaced('background.goals', { stages: ['shape'] }), replaced('background.problem')]
    const { items } = planUpdateRound({ flags, definition, pageStageId: 'design', saved })
    assert.deepEqual(items.map((i) => i.key), ['background.goals', 'background.problem', 'solution.overview'])
  })
})

describe('reopenOutlook: ADR-0026', () => {
  test('only the Stage just before the current one, and only while nothing after it has started', () => {
    assert.deepEqual(reopenOutlook({ stages, currentStageId: 'design', targetId: 'shape' }), { allowed: true, blocker: '' })
    const started = reopenOutlook({ stages, currentStageId: 'design', targetId: 'shape', inProgress: ['design'] })
    assert.equal(started.allowed, false)
    assert.match(started.blocker, /Design is already in progress/)
    const far = reopenOutlook({ stages, currentStageId: 'build', targetId: 'shape' })
    assert.equal(far.allowed, false)
    assert.match(far.blocker, /Design is already in progress/)
    assert.equal(reopenOutlook({ stages, currentStageId: 'design', targetId: 'design' }).allowed, false)
  })
})

describe('stagesToUpdate: stage by stage, in order', () => {
  const flags = [replaced('solution.overview', { stages: ['design'] }), replaced('risks.list'), replaced('background.problem'), replaced('background.goals')]
  test('local and server: each Field on the first Stage where its Module is edited', () => {
    assert.deepEqual(stagesToUpdate({ flags, definition, currentStageId: 'design' }), [{ stageId: 'shape', count: 3 }, { stageId: 'design', count: 1 }])
  })
  test('remote: only the current Stage can be written, so everything is asked there', () => {
    assert.deepEqual(stagesToUpdate({ flags, definition, remote: true, currentStageId: 'design' }), [{ stageId: 'design', count: 4 }])
  })
  test('nothing flagged, nothing to do', () => {
    assert.deepEqual(stagesToUpdate({ flags: [], definition, currentStageId: 'shape' }), [])
  })
})

describe('updateCards', () => {
  const cardsFor = (flags, over = {}) => {
    const plan = planUpdateRound({ flags, definition, pageStageId: 'shape', saved, ...over.plan })
    return updateCards({ items: plan.items, sources, fieldTitle: title, stageTitle, pageStageTitle: 'Shape', ...over })
  }

  test('a changed or replaced document: keep or redraft, redraft recommended, citing the document', () => {
    const [card] = cardsFor([replaced('background.problem')])
    assert.equal(card.id, 'update:background.problem')
    assert.equal(card.type, 'update')
    assert.deepEqual(card.options.map((o) => o.label), ['Keep', 'Redraft'])
    assert.deepEqual(card.recommended, ['Redraft'])
    assert.deepEqual(card.selected, ['Redraft'])
    assert.equal(card.allowOther, false)
    assert.match(card.question, /Background · Problem: Client brief was replaced by Client brief v3/)
    assert.deepEqual(card.source, { document: 'brief', title: 'Client brief', location: null })
    assert.equal(card.field, 'background.problem')
  })

  test('a re-read document reads the same way', () => {
    const [card] = cardsFor([replaced('background.problem', { change: 're-extracted', replacedBy: undefined })])
    assert.match(card.question, /Client brief was read again with different text/)
    assert.deepEqual(card.options.map((o) => o.label), ['Keep', 'Redraft'])
  })

  test('a removed document: keep, re-cite and redraft without it; re-cite is pre-selected when another document supports the content', () => {
    // The Minutes are not cited by this Field, but the newer Client brief replaced the removed one, so it supports the content.
    const [card] = cardsFor([removed('background.problem')])
    assert.deepEqual(card.options.map((o) => o.label), ['Keep', 'Re-cite to Client brief v3', 'Re-cite to Minutes', 'Redraft without it'])
    assert.deepEqual(card.recommended, ['Re-cite to Client brief v3'])
    assert.match(card.options[0].description, /shows "removed"/)
    assert.match(card.why, /already supports/)
    assert.deepEqual(card.update.recite.map((c) => c.id), ['brief-v3', 'minutes'])
  })

  test('a removed document with nothing known to support the content: redraft without it is recommended, re-cite is still offered', () => {
    const lonely = [{ id: 'brief', title: 'Client brief', filename: 'b.md', removedAt: '2026-11-02T10:00:00.000Z' }, { id: 'minutes', title: 'Minutes', filename: 'm.md' }]
    const plan = planUpdateRound({ flags: [removed('background.problem')], definition, pageStageId: 'shape', saved })
    const [card] = updateCards({ items: plan.items, sources: lonely, fieldTitle: title, stageTitle, pageStageTitle: 'Shape' })
    assert.deepEqual(card.recommended, ['Redraft without it'])
    assert.ok(card.options.some((o) => o.label === 'Re-cite to Minutes'))
    assert.match(card.why, /No other document is known to support/)
  })

  test('a document the Field already drew on or cites also supports it', () => {
    const lonely = [{ id: 'brief', title: 'Client brief', filename: 'b.md', removedAt: '2026-11-02T10:00:00.000Z' }, { id: 'minutes', title: 'Minutes', filename: 'm.md' }]
    const logs = { shape: { fields: { 'background.problem': { drafted: '2026-11-01T10:00:00.000Z', inputs: [{ source: 'brief' }, { source: 'minutes' }] } } } }
    const plan = planUpdateRound({ flags: [removed('background.problem')], definition, pageStageId: 'shape', saved })
    const [card] = updateCards({ items: plan.items, sources: lonely, logs, fieldTitle: title, stageTitle, pageStageTitle: 'Shape' })
    assert.deepEqual(card.recommended, ['Re-cite to Minutes'])
  })

  test('a Field flagged because an earlier Field changed is keep or redraft, keep recommended', () => {
    const plan = planUpdateRound({ flags: [earlierField('solution.overview', 'background.problem')], definition, pageStageId: 'design', saved })
    const [card] = updateCards({ items: plan.items, sources, fieldTitle: title, stageTitle, pageStageTitle: 'Design' })
    assert.deepEqual(card.options.map((o) => o.label), ['Keep', 'Redraft'])
    assert.deepEqual(card.recommended, ['Keep'])
    assert.match(card.question, /Background · Problem has changed since this was drafted/)
    assert.equal(card.source, null)
  })

  test('a Field that cannot be changed from here: re-open recommended when allowed, otherwise an open question', () => {
    const reopen = planUpdateRound({ flags: [replaced('risks.list')], definition, pageStageId: 'design', currentStageId: 'design', remote: true, saved })
    const [a] = updateCards({ items: reopen.items, sources, fieldTitle: title, stageTitle, pageStageTitle: 'Design' })
    assert.deepEqual(a.options.map((o) => o.label), ['Re-open Shape', 'Log an open question'])
    assert.deepEqual(a.recommended, ['Re-open Shape'])
    assert.match(a.header, /cannot change here/)
    const blocked = planUpdateRound({ flags: [replaced('risks.list')], definition, pageStageId: 'design', currentStageId: 'design', remote: true, inProgress: ['design'], saved })
    const [b] = updateCards({ items: blocked.items, sources, fieldTitle: title, stageTitle, pageStageTitle: 'Design' })
    assert.deepEqual(b.options.map((o) => o.label), ['Log an open question', 'Leave it flagged'])
    assert.deepEqual(b.recommended, ['Log an open question'])
    assert.match(b.why, /Design is already in progress/)
  })

  test('a carried-forward Field says where the change lands, and that it changes approved content', () => {
    const [card] = cardsFor([replaced('background.problem')], { plan: { pageStageId: 'design', currentStageId: 'design', remote: true }, pageStageTitle: 'Design' })
    assert.match(card.update.note, /^Shape is approved\. A change is carried forward: it is made on Design, where this Module can be edited/)
    assert.match(card.update.note, /changes approved content, so it is re-approved with Design/)
  })

  test('one card per Field, however many flags it has', () => {
    const cards = cardsFor([replaced('background.problem'), earlierField('background.problem', 'risks.list'), replaced('background.goals')])
    assert.deepEqual(cards.map((c) => c.field), ['background.goals', 'background.problem'])
    const two = cards.find((c) => c.field === 'background.problem')
    assert.equal(two.update.flags.length, 2)
    assert.match(two.question, /Client brief was replaced by Client brief v3; Risks · Risk list has changed/)
  })
})

describe('what an answer means', () => {
  const [changed, removedCard] = (() => {
    const plan = planUpdateRound({ flags: [replaced('background.goals'), removed('background.problem')], definition, pageStageId: 'shape', saved })
    return updateCards({ items: plan.items, sources, fieldTitle: title, stageTitle, pageStageTitle: 'Shape' })
  })()
  const pick = (card, label) => choose(card, label)

  test('each choice resolves to an outcome', () => {
    assert.equal(resolveUpdateCard(pick(changed, 'Keep')).outcome, 'keep')
    assert.equal(resolveUpdateCard(pick(changed, 'Redraft')).outcome, 'redraft')
    assert.equal(resolveUpdateCard(pick(removedCard, 'Redraft without it')).outcome, 'redraft-without')
    const recite = resolveUpdateCard(removedCard)
    assert.equal(recite.outcome, 're-cite')
    assert.deepEqual(recite.reciteTo, { id: 'brief-v3', title: 'Client brief v3' })
  })

  test('the blocked choices resolve too', () => {
    const plan = planUpdateRound({ flags: [replaced('risks.list')], definition, pageStageId: 'design', currentStageId: 'design', remote: true, saved })
    const [card] = updateCards({ items: plan.items, sources, fieldTitle: title, stageTitle, pageStageTitle: 'Design' })
    const reopen = resolveUpdateCard(card)
    assert.deepEqual([reopen.outcome, reopen.stageId], ['reopen', 'shape'])
    assert.equal(resolveUpdateCard(pick(card, 'Log an open question')).outcome, 'open-question')
  })

  test('the AI is told only what it must do', () => {
    const text = updateAnswersText(
      [resolveUpdateCard(pick(changed, 'Redraft')), resolveUpdateCard(removedCard), resolveUpdateCard(pick(removedCard, 'Redraft without it')), resolveUpdateCard(pick(changed, 'Keep'))],
      { fieldTitle: title }
    )
    assert.match(text, /background\.goals \(Background · Goals\): REDRAFT\./)
    assert.match(text, /RE-CITED by Gantry to Client brief v3\. Nothing for you to do/)
    assert.match(text, /REDRAFT WITHOUT source:brief/)
    assert.match(text, /KEPT as it is\. Do not propose a change/)
    assert.match(text, /keep \/ use your version \/ merge card/)
  })

  test('re-citing rewrites the citations of the removed document and no others', () => {
    const to = { id: 'brief-v3', title: 'Client brief v3' }
    assert.equal(reciteValue('Slow [Client brief, p. 1](source:brief) and [Minutes](source:minutes).', 'brief', to), 'Slow [Client brief v3](source:brief-v3) and [Minutes](source:minutes).')
    assert.deepEqual(reciteValue(['A [Client brief](source:brief)', 'B'], 'brief', to), ['A [Client brief v3](source:brief-v3)', 'B'])
    assert.equal(reciteValue('Code `[x](source:brief)` stays.', 'brief', to), 'Code `[x](source:brief)` stays.')
  })

  test('reciteCandidates puts the successor first, then documents the Field already drew on', () => {
    const item = { key: 'background.problem', saved: 'A [Minutes](source:minutes)' }
    const found = reciteCandidates({ item, sources, removedId: 'brief' })
    assert.deepEqual(found.map((c) => [c.id, c.supported]), [['brief-v3', true], ['minutes', true]])
  })
})

describe('words', () => {
  test('flagReason', () => {
    assert.equal(flagReason(replaced('x')), 'Client brief was replaced by Client brief v3')
    assert.equal(flagReason(removed('x')), 'Client brief was removed')
    assert.equal(flagReason(earlierField('x', 'a.b'), (k) => `<${k}>`), '<a.b> has changed since this was drafted')
  })

  test('newSinceNote asks for a check against saved content and for cards only where it adds or contradicts', () => {
    assert.equal(newSinceNote([]), '')
    const note = newSinceNote([{ id: 'w', title: 'Workshop' }, { id: 'm', filename: 'm.md' }])
    assert.match(note, /New since the last interview: "Workshop", "m\.md"\./)
    assert.match(note, /only where a document adds to or contradicts something already saved/)
  })

  test('returnedToDraftNote says why', () => {
    const note = returnedToDraftNote({ moduleTitle: 'Background', fieldTitles: ['Background · Problem'], cause: 'because Client brief was replaced by Client brief v3' })
    assert.match(note, /^Background was agreed and is back to draft\./)
    assert.match(note, /because Client brief was replaced by Client brief v3/)
    assert.match(note, /Only a person marks a Module agreed/)
  })
})

describe('only answering a card clears a flag (web/lib/outOfDate.js)', () => {
  const sourcesOnDisk = [
    { id: 'brief', title: 'Client brief', filename: 'brief.md', uploadedAt: '2026-11-01T09:00:00.000Z' },
    { id: 'brief-v3', title: 'Client brief v3', filename: 'brief-v3.md', uploadedAt: '2026-11-02T10:00:00.000Z', replaces: 'brief' },
  ]
  const modules = [{ id: 'background', fields: [{ id: 'problem', value: 'Slow [Client brief](source:brief).' }] }]
  const find = (entries, extra = {}) => findOutOfDateFields({ sources: sourcesOnDisk, logs: { shape: { stage: 'shape', fields: {}, entries, ...extra } }, modules })
  const update = (over) => ({ id: 'u1', kind: SOURCE_UPDATE_KIND, at: '2026-11-02T12:00:00.000Z', source: 'brief', fields: ['background.problem'], outcome: 'keep', ...over })

  test('a flagged Field stays flagged until its card is answered, and then it is not', () => {
    assert.deepEqual(find([]).map((f) => f.field), ['background.problem'])
    assert.deepEqual(find([update()]), [])
  })

  test('an answer about one Field does not clear another, and one about another document does not clear this one', () => {
    assert.equal(find([update({ fields: ['background.goals'] })]).length, 1)
    assert.equal(find([update({ source: 'minutes' })]).length, 1)
  })

  test('an answer made before the change does not clear it', () => {
    assert.equal(find([update({ at: '2026-11-02T08:00:00.000Z' })]).length, 1)
  })

  test('a Field flagged for an earlier Field is cleared by keep, until that earlier Field changes again', () => {
    const logs = (entries) => ({
      design: {
        stage: 'design',
        fields: { 'solution.overview': { drafted: '2026-11-01T10:00:00.000Z', inputs: [{ field: 'background.problem', fingerprint: 'old' }], entries: [] } },
        entries,
      },
    })
    const content = (problem) => [{ id: 'background', fields: [{ id: 'problem', value: problem }] }, { id: 'solution', fields: [{ id: 'overview', value: 'x' }] }]
    const flagsFor = (entries, problem) => findOutOfDateFields({ sources: [], logs: logs(entries), modules: content(problem) })
    assert.equal(flagsFor([], 'Version two').length, 1)
    const kept = { id: 'u2', kind: SOURCE_UPDATE_KIND, at: '2026-11-02T12:00:00.000Z', inputField: 'background.problem', inputFingerprint: fingerprintText('Version two'), fields: ['solution.overview'], outcome: 'keep' }
    assert.deepEqual(flagsFor([kept], 'Version two'), [])
    assert.equal(flagsFor([kept], 'Version three').length, 1, 'a later change flags it again')
  })
})

describe('the decisions log shows what was decided', () => {
  test('a source-update entry reads as the decision it records, naming what triggered it', async () => {
    const { describeEntry } = await import('../web/lib/decisionsLogPanel.js')
    const entry = (over) => ({ id: 'u', kind: 'source-update', source: 'brief', sourceTitle: 'Client brief', change: 'replaced', replacedBy: 'Client brief v3', fields: ['background.problem'], ...over })
    assert.equal(describeEntry(entry({ outcome: 'keep' }), { fieldTitle: title }), 'Background · Problem kept as it is: Client brief was replaced by Client brief v3')
    assert.match(describeEntry(entry({ outcome: 'redraft' }), { fieldTitle: title }), /to be redrafted/)
    assert.match(describeEntry(entry({ outcome: 'redraft-without', change: 'removed', replacedBy: undefined }), { fieldTitle: title }), /redrafted without Client brief: Client brief was removed/)
    assert.match(describeEntry(entry({ outcome: 're-cite', reciteTo: 'Workshop notes' }), { fieldTitle: title }), /re-cited to Workshop notes/)
    assert.match(describeEntry(entry({ outcome: 'open-question' }), { fieldTitle: title }), /could not be changed here and is an open question/)
    assert.match(describeEntry({ id: 'u', kind: 'source-update', inputField: 'risks.list', change: 'changed', outcome: 'keep', fields: ['solution.overview'] }, { fieldTitle: title }), /Solution · Overview kept as it is: Risks · Risk list changed/)
    assert.equal(describeEntry({ id: 'r', kind: 'returned-to-draft', module: 'background', note: 'Background was agreed and is back to draft.' }), 'Background was agreed and is back to draft.')
  })

  test('both kinds are known to the log and count as decisions', async () => {
    const { ENTRY_KINDS, logSummary } = await import('../web/lib/decisionsLog.js')
    assert.ok(ENTRY_KINDS.includes('source-update') && ENTRY_KINDS.includes('returned-to-draft'))
    const summary = logSummary({ entries: [{ id: 'u', kind: 'source-update', fields: ['a.b'] }, { id: 'r', kind: 'returned-to-draft', fields: ['a.b'] }] })
    assert.equal(summary.latest.length, 2)
  })
})

test('UPDATE_CHOICES are the labels the cards use', () => {
  assert.deepEqual(Object.values(UPDATE_CHOICES), ['Keep', 'Redraft', 'Redraft without it', 'Log an open question', 'Leave it flagged'])
})

// #357: Bring up to date from the editor's banner always lands on a page with something to do.
describe('#357: Bring up to date always gives a way to answer every flagged Field', () => {
  const codeChanged = (field, stage) => ({ field, cause: 'source', source: 'gantry', sourceTitle: 'gantry', change: 'code-changed', paths: ['package.json'], head: 'h2', via: ['drafted'], stages: [stage] })

  test('a local workspace asks about code-changed Fields of an earlier, done Stage on that Stage, in place: none is deferred or sent elsewhere', () => {
    // The Instance is on Build; Shape's and Design's Fields drew on files of a code repository that have since changed.
    const flags = [codeChanged('background.problem', 'shape'), codeChanged('background.goals', 'design'), codeChanged('solution.overview', 'design'), codeChanged('plan.body', 'build')]
    const shape = planUpdateRound({ flags, definition, pageStageId: 'shape', currentStageId: 'build', saved })
    assert.deepEqual(shape.items.map((i) => [i.key, i.landing.kind]), [['background.problem', 'in-place'], ['background.goals', 'in-place']])
    assert.deepEqual(shape.deferred, [])
    assert.deepEqual(shape.elsewhere.map((e) => [e.key, e.stageId]), [['solution.overview', 'design'], ['plan.body', 'build']])
    const design = planUpdateRound({ flags: flags.filter((f) => !f.field.startsWith('background.')), definition, pageStageId: 'design', currentStageId: 'build', saved })
    assert.deepEqual(design.items.map((i) => i.key), ['solution.overview'])
    // And the Stages to work through, in order, cover every one of them.
    assert.deepEqual(stagesToUpdate({ flags, definition, currentStageId: 'build' }), [{ stageId: 'shape', count: 2 }, { stageId: 'design', count: 1 }, { stageId: 'build', count: 1 }])
  })

  test('isStaleUpdateSession: a session with nothing open and nothing unsaved is stale, so the page starts afresh from the flags as they are now', () => {
    const snap = (over) => ({ phase: 'waiting', round: null, clash: null, drafts: {}, decisions: { pending: 0 }, update: { answered: true }, ...over })
    // Answered and saved (still in this tab), or every card left flagged: nothing to do here any more.
    assert.equal(isStaleUpdateSession(snap()), true)
    // A working copy with no round and no record of the round at all (the AI's turn ended, or an older copy): nothing to press.
    assert.equal(isStaleUpdateSession(snap({ update: null })), true)
    assert.equal(isStaleUpdateSession(snap({ update: { answered: false }, decisions: { pending: 2 } })), true)
    // Something to carry on: a round or a keep / use / merge card open, the AI at work, or answers waiting to be saved.
    assert.equal(isStaleUpdateSession(snap({ phase: 'kickoff', update: null })), false)
    assert.equal(isStaleUpdateSession(snap({ phase: 'asking', round: { id: 1, cards: [] } })), false)
    assert.equal(isStaleUpdateSession(snap({ clash: { field: 'a.b' } })), false)
    assert.equal(isStaleUpdateSession(snap({ phase: 'working' })), false)
    assert.equal(isStaleUpdateSession(snap({ phase: 'error' })), false)
    assert.equal(isStaleUpdateSession(snap({ decisions: { pending: 3 } })), false)
    assert.equal(isStaleUpdateSession(snap({ drafts: { 'a.b': { value: 'x' } } })), false)
    assert.equal(isStaleUpdateSession(null), false)
  })

  test('checkingFlagsNote says what is being checked, naming the code repositories being compared', () => {
    assert.equal(checkingFlagsNote('SOAP'), 'Checking which Fields on SOAP are Out of date…')
    assert.equal(checkingFlagsNote('SOAP', ['gantry']), 'Checking which Fields on SOAP are Out of date: the Gantry server is comparing the files they drew on in gantry with its branch now…')
    assert.equal(checkingFlagsNote('SOAP', ['gantry', 'billing-api']), 'Checking which Fields on SOAP are Out of date: the Gantry server is comparing the files they drew on in gantry and billing-api with their branches now…')
  })
})

describe('#358: in Bring up to date the run plan lists the Stages to work through, not a target and beyond it', () => {
  const stages = [
    { id: 'shape', title: 'Shape' },
    { id: 'soap', title: 'SOAP' },
    { id: 'hld', title: 'High-level Design' },
    { id: 'dd', title: 'Detailed Design' },
    { id: 'build', title: 'Build' },
  ]
  // What the normal run plan says on SOAP, whose target is itself: SOAP is "waiting · target" and everything after it is struck through.
  const normal = planRows({ stages, currentStageId: 'soap', targetStageId: 'soap', instanceStageId: 'soap' })
  const toDo = [{ stageId: 'soap', count: 2 }, { stageId: 'hld', count: 15 }, { stageId: 'dd', count: 6 }]
  const view = (rows) => rows.map((r) => [r.id, r.state, r.note, r.count, r.target])

  test('every Stage with Out of date Fields is part of the round, with its count; the one on screen is current; the rest are plain', () => {
    assert.equal(normal.find((r) => r.id === 'soap').note, 'waiting · target')
    assert.equal(normal.find((r) => r.id === 'hld').state, 'beyond')
    assert.deepEqual(view(roundPlanRows({ rows: normal, pageStageId: 'soap', toDo })), [
      ['shape', 'plain', '', 0, false],
      ['soap', 'current', 'bringing up to date', 2, false],
      ['hld', 'to-do', 'to bring up to date', 15, false],
      ['dd', 'to-do', 'to bring up to date', 6, false],
      ['build', 'plain', '', 0, false],
    ])
  })

  test("once the page's round is saved it reads done, and on the next Stage's page the earlier one stays done and the next is current", () => {
    // Saved on SOAP: its flags have cleared, so it is no longer in the list to work through.
    const saved = roundPlanRows({ rows: normal, pageStageId: 'soap', toDo: toDo.slice(1), saved: true })
    assert.deepEqual(saved.find((r) => r.id === 'soap').state, 'done')
    assert.deepEqual(saved.find((r) => r.id === 'soap').note, 'done')
    assert.deepEqual(saved.find((r) => r.id === 'hld').state, 'to-do')
    // Next: High-level Design, opened from SOAP's saved card.
    const onHld = planRows({ stages, currentStageId: 'hld', targetStageId: 'hld', instanceStageId: 'soap' })
    assert.deepEqual(view(roundPlanRows({ rows: onHld, pageStageId: 'hld', toDo: toDo.slice(1), done: ['soap'] })), [
      ['shape', 'plain', '', 0, false],
      ['soap', 'done', 'done', 0, false],
      ['hld', 'current', 'bringing up to date', 15, false],
      ['dd', 'to-do', 'to bring up to date', 6, false],
      ['build', 'plain', '', 0, false],
    ])
    // A Stage saved earlier that has been flagged again since is back in the list to work through.
    assert.equal(roundPlanRows({ rows: onHld, pageStageId: 'hld', toDo, done: ['soap'] }).find((r) => r.id === 'soap').state, 'to-do')
    // The page's own Stage, saved earlier and opened again with nothing flagged, is done too.
    assert.equal(roundPlanRows({ rows: normal, pageStageId: 'soap', toDo: toDo.slice(1), done: ['soap'] }).find((r) => r.id === 'soap').state, 'done')
  })

  test('the page on a Stage with nothing flagged says so, rather than that it is bringing it up to date', () => {
    const row = roundPlanRows({ rows: normal, pageStageId: 'soap', toDo: toDo.slice(1) }).find((r) => r.id === 'soap')
    assert.deepEqual([row.state, row.note, row.count], ['current', 'nothing Out of date', 0])
    // #357: until the check for the page's Stage has answered, nothing is known, so the row says it is checking.
    const checking = roundPlanRows({ rows: normal, pageStageId: 'soap', toDo: toDo.slice(1), checking: true }).find((r) => r.id === 'soap')
    assert.deepEqual([checking.state, checking.note], ['current', 'checking…'])
  })

  test("a Provider's Pull Request is still shown: a Stage awaiting approval or queued for it keeps that state, its link and Check status", () => {
    const remote = { pullRequests: { soap: { id: 7, url: 'https://example.test/pr/7' } }, queued: { hld: true } }
    const rows = planRows({ stages, currentStageId: 'hld', targetStageId: 'dd', instanceStageId: 'soap', remote })
    const round = roundPlanRows({ rows, pageStageId: 'hld', toDo: [{ stageId: 'hld', count: 4 }] })
    const soap = round.find((r) => r.id === 'soap')
    assert.deepEqual([soap.state, soap.note, soap.pullRequest, soap.checkable], ['awaiting-approval', 'awaiting approval', { id: 7, url: 'https://example.test/pr/7' }, true])
    assert.deepEqual(view(round).slice(2), [
      ['hld', 'current', 'bringing up to date', 4, false],
      ['dd', 'plain', '', 0, false],
      ['build', 'plain', '', 0, false],
    ])
  })

  test('review comments use the same plan, in their own words', () => {
    const rows = roundPlanRows({ rows: normal, pageStageId: 'soap', toDo: [{ stageId: 'soap', count: 1 }, { stageId: 'dd', count: 2 }], words: 'review' })
    assert.deepEqual(view(rows).slice(1, 4), [
      ['soap', 'current', 'working through comments', 1, false],
      ['hld', 'plain', '', 0, false],
      ['dd', 'to-do', 'comments to work through', 2, false],
    ])
    assert.equal(roundPlanRows({ rows: normal, pageStageId: 'soap', toDo: [], words: 'review' }).find((r) => r.id === 'soap').note, 'no comments here')
  })
})
