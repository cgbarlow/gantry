import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DecisionsLogError, applyDecisionsDelta, emptyDecisionsLog, parseDecisionsLog, serializeDecisionsLog, sessionStatus } from '../web/lib/decisionsLog.js'
import { UNSAVED_ADVANCE_REFUSAL, advanceRefusal, approvalRefusal, citedBy, labelEntries, parseSession, planSessionDecisions } from '../lib/outsideAgentSession.js'
import { writtenFields } from '../lib/stageFieldsWritten.js'
import { findOutOfDateFields } from '../web/lib/outOfDate.js'
import { fingerprintText } from '../web/lib/sourceDocuments.js'

// #307 (docs/adr/0067): the part of an outside agent's interview session that is pure: the session it says it is in, the entries stamped
// "recorded by an outside agent", the session status (the model it reports, tokens "not reported"), the `fields` section rebuilt from the
// content's citations and the entries that name each Field, and the guard rails Gantry enforces for an agent in a session.

const NOW = '2026-11-02T10:00:00.000Z'
const session = (extra = {}) => parseSession({ id: 's-a1', runUntil: 'shape', state: 'in-progress', model: 'claude-opus-4-1', who: 'a.architect', ...extra })

describe('parseSession', () => {
  test('keeps the session the agent says it is in, and defaults the state', () => {
    assert.deepEqual(parseSession({ id: 's-a1', runUntil: 'shape', model: 'claude-opus-4-1' }), {
      id: 's-a1', runUntil: 'shape', state: 'in-progress', model: 'claude-opus-4-1', who: '', artefact: null, stages: undefined, instructions: null,
    })
  })

  test('refuses a missing or unusable id, and a state Gantry does not know', () => {
    assert.throws(() => parseSession(undefined), (err) => err instanceof DecisionsLogError && err.code === 'session-required')
    assert.throws(() => parseSession({ state: 'paused' }), /needs an "id"/)
    assert.throws(() => parseSession({ id: 'has space' }), /needs an "id"/)
    assert.throws(() => parseSession({ id: 's-a1', state: 'sleeping' }), (err) => err.code === 'bad-session-state' && /awaiting-approval/.test(err.message))
  })

  test('a model name that could be a key or an address reads as unknown', () => {
    assert.equal(parseSession({ id: 's-1', model: 'https://example.test/m' }).model, 'unknown')
    assert.equal(parseSession({ id: 's-1', model: 'sk-abcdefghijkl' }).model, 'unknown')
    assert.equal(parseSession({ id: 's-1' }).model, 'unknown')
  })
})

describe('labelEntries', () => {
  test('stamps each entry with the session, a numbered id, the time and the outside-agent label, whatever the agent put there', () => {
    const entries = labelEntries(
      [
        { kind: 'answer', question: 'Q1', answer: 'A1', fields: ['m.f'], recordedBy: 'the architect', agentModel: 'forged', session: 's-other', who: 'someone else' },
        { kind: 'fact', words: 'We launch in March', fields: ['m.f'] },
      ],
      { session: session(), log: emptyDecisionsLog('shape'), now: NOW }
    )
    assert.deepEqual(entries.map((e) => e.id), ['s-a1-1', 's-a1-2'])
    for (const entry of entries) {
      assert.equal(entry.recordedBy, 'outside agent')
      assert.equal(entry.agentModel, 'claude-opus-4-1')
      assert.equal(entry.session, 's-a1')
      assert.equal(entry.who, 'a.architect')
      assert.equal(entry.at, NOW)
    }
  })

  test('numbering carries on after the session\'s highest number already in the log, and an id the agent gave is kept', () => {
    const log = { ...emptyDecisionsLog(), entries: [{ id: 's-a1-1', kind: 'fact', words: 'x', session: 's-a1' }, { id: 's-a1-7', kind: 'fact', words: 'y', session: 's-a1' }, { id: 's-b-9', kind: 'fact', words: 'z', session: 's-b' }] }
    const [a, b] = labelEntries([{ kind: 'open-question', question: 'Q?' }, { id: 'mine-1', kind: 'open-question', question: 'Q2?' }], { session: session(), log, now: NOW })
    assert.equal(a.id, 's-a1-8')
    assert.equal(b.id, 'mine-1')
  })

  test('refuses what the log cannot take: an unknown kind, model-change, a missing part, a bad Field, a link to nothing', () => {
    const run = (entry, log = emptyDecisionsLog()) => labelEntries([entry], { session: session(), log, now: NOW })
    assert.throws(() => run({ kind: 'wibble' }), /does not know/)
    assert.throws(() => run({ kind: 'model-change' }), /Gantry's own/)
    assert.throws(() => run({ kind: 'fact', fields: ['m.f'] }), /needs "words"/)
    assert.throws(() => run({ kind: 'answer', question: 'Q' }), /"answer"/)
    assert.throws(() => run({ kind: 'saved-content', fields: ['m.f'], choice: 'maybe' }), /keep, replace or merge/)
    assert.throws(() => run({ kind: 'open-question', question: 'Q', fields: ['no-dot'] }), /module\.field/)
    assert.throws(() => run({ kind: 'answer', question: 'Q', answer: 'A', replaces: ['s-a1-99'] }), /not in this Stage's decisions log/)
    assert.throws(() => labelEntries('nope'.split(''), { session: session(), log: emptyDecisionsLog(), now: NOW }), /must be an object/)
  })

  test('an entry may replace one in the same call, or already in the log', () => {
    const log = { ...emptyDecisionsLog(), entries: [{ id: 's-b-1', kind: 'answer', question: 'Q', answer: 'A', session: 's-b' }] }
    const entries = labelEntries([{ kind: 'answer', question: 'Q', answer: 'B', replaces: ['s-b-1'] }, { kind: 'answer', question: 'Q', answer: 'C', replaces: ['s-a1-1'] }], { session: session(), log, now: NOW })
    assert.equal(entries.length, 2)
  })
})

describe('planSessionDecisions', () => {
  const doc = { id: 'client-brief', title: 'Client brief', filename: 'Client brief.txt', text: 'Five thousand users, by March.' }
  const modules = { background: { fields: { problem: 'Expect 5000 users ([Client brief, p. 1](source:client-brief)).', scope: 'Retail only.' } } }

  test('is the status, the rebuilt Fields and the labelled entries a Save writes', () => {
    const planned = planSessionDecisions({
      session: session({ state: 'saved' }),
      entries: [{ kind: 'answer', question: 'Who is it for?', answer: ['Retail'], fields: ['background.scope'] }],
      log: emptyDecisionsLog('shape'),
      written: ['background.problem', 'background.scope'],
      modules,
      sources: [doc],
      saved: true,
      now: NOW,
    })
    assert.equal(planned.entryCount, 1)
    const { status, fields, entries } = planned.decisions
    assert.equal(entries[0].recordedBy, 'outside agent')
    assert.equal(status.session, 's-a1')
    assert.equal(status.state, 'saved')
    assert.equal(status.target, 'shape')
    assert.equal(status.lastAiSave, NOW)
    assert.deepEqual(status.saves, [NOW])
    assert.equal(status.recordedBy, 'outside agent')
    assert.deepEqual(status.models, [{ type: 'outside-agent', model: 'claude-opus-4-1', tokens: 'not reported' }])
    // The Fields section: a citation is an input fingerprinted by the document's text; the entries that name a Field are listed on it.
    assert.deepEqual(fields['background.problem'].inputs, [{ source: 'client-brief', title: 'Client brief', range: null, fingerprint: fingerprintText(doc.text) }])
    assert.deepEqual(fields['background.problem'].entries, [])
    assert.deepEqual(fields['background.scope'].entries, ['s-a1-1'])
    assert.equal(fields['background.scope'].drafted, NOW)
  })

  test('the status round-trips through the file with "not reported" and the label intact', () => {
    const planned = planSessionDecisions({ session: session(), log: emptyDecisionsLog('shape'), saved: true, now: NOW })
    const written = serializeDecisionsLog(applyDecisionsDelta(emptyDecisionsLog('shape'), planned.decisions, 'shape'))
    const [status] = parseDecisionsLog(written, 'shape').status
    assert.deepEqual(status.models, [{ type: 'outside-agent', model: 'claude-opus-4-1', tokens: 'not reported' }])
    assert.equal(status.recordedBy, 'outside agent')
    // Written again (a later Save by anyone) it is still "not reported": the tokens are never turned into zeros.
    assert.deepEqual(parseDecisionsLog(serializeDecisionsLog(parseDecisionsLog(written, 'shape')), 'shape').status[0].models[0], { type: 'outside-agent', model: 'claude-opus-4-1', tokens: 'not reported' })
  })

  test('a Pause with no content leaves the last AI save alone; a later Save adds to the list of saves', () => {
    const first = applyDecisionsDelta(emptyDecisionsLog('shape'), planSessionDecisions({ session: session({ state: 'saved' }), log: emptyDecisionsLog('shape'), saved: true, now: '2026-11-02T09:00:00.000Z' }).decisions, 'shape')
    const pause = planSessionDecisions({ session: session({ state: 'paused' }), log: first, saved: false, now: NOW })
    assert.equal(pause.decisions.status.state, 'paused')
    assert.equal(pause.decisions.status.lastAiSave, '2026-11-02T09:00:00.000Z')
    assert.deepEqual(pause.decisions.status.saves, ['2026-11-02T09:00:00.000Z'])
    assert.deepEqual(pause.decisions.fields, {}, 'a Pause drafts nothing')
    const second = planSessionDecisions({ session: session({ state: 'saved' }), log: first, saved: true, now: NOW })
    assert.deepEqual(second.decisions.status.saves, ['2026-11-02T09:00:00.000Z', NOW])
  })

  test('an entry the agent records for a Field whose draft was redrafted replaces the earlier one, and the Field lists only the standing entry', () => {
    const first = applyDecisionsDelta(
      emptyDecisionsLog('shape'),
      planSessionDecisions({ session: session(), entries: [{ kind: 'answer', question: 'Who?', answer: 'Retail', fields: ['background.scope'] }], log: emptyDecisionsLog('shape'), written: ['background.scope'], modules, saved: true, now: '2026-11-02T09:00:00.000Z' }).decisions,
      'shape'
    )
    const second = planSessionDecisions({ session: session(), entries: [{ kind: 'answer', question: 'Who?', answer: 'Everyone', fields: ['background.scope'], replaces: ['s-a1-1'] }], log: first, written: ['background.scope'], modules, saved: true, now: NOW })
    assert.deepEqual(second.decisions.fields['background.scope'].entries, ['s-a1-2'])
  })
})

describe('Out of date detection on a Field the agent drafted', () => {
  test('a draft that cites a document is flagged when the document is replaced, and is not after it is redrafted', () => {
    const doc = { id: 'client-brief', title: 'Client brief', filename: 'brief.txt', text: 'Five thousand users.' }
    const log = applyDecisionsDelta(
      emptyDecisionsLog('shape'),
      planSessionDecisions({
        session: session(),
        log: emptyDecisionsLog('shape'),
        written: ['background.problem'],
        modules: { background: { fields: { problem: 'Expect 5000 users ([Client brief, p. 1](source:client-brief)).' } } },
        sources: [doc],
        saved: true,
        now: '2026-11-02T09:00:00.000Z',
      }).decisions,
      'shape'
    )
    const saved = [{ id: 'background', fields: [{ id: 'problem', value: 'Expect 5000 users ([Client brief, p. 1](source:client-brief)).' }] }]
    const sources = [
      { id: 'client-brief', title: 'Client brief', filename: 'brief.txt' },
      { id: 'client-brief-v2', title: 'Client brief v2', filename: 'brief-v2.txt', replaces: 'client-brief', uploadedAt: '2026-11-02T09:30:00.000Z' },
    ]
    const found = findOutOfDateFields({ sources, logs: { shape: log }, modules: saved })
    assert.deepEqual(found.map((f) => [f.field, f.change, f.source]), [['background.problem', 'replaced', 'client-brief']])
    // The record alone (the Field's text no longer cites it) still flags it: the record is what the agent drafted from.
    const redrafted = applyDecisionsDelta(log, planSessionDecisions({ session: session(), log, written: ['background.problem'], modules: { background: { fields: { problem: 'x' } } }, saved: true, now: '2026-11-02T10:00:00.000Z' }).decisions, 'shape')
    assert.deepEqual(findOutOfDateFields({ sources, logs: { shape: redrafted }, modules: [{ id: 'background', fields: [{ id: 'problem', value: 'Eight thousand users.' }] }] }), [])
  })

  test('citedBy lists the documents the written Fields cite, once each', () => {
    assert.deepEqual(citedBy(['m.a', 'm.b'], { m: { fields: { a: '[x](source:one) and [y](source:two)', b: '[z](source:one)', c: '[w](source:three)' } } }).sort(), ['one', 'two'])
  })
})

describe('writtenFields', () => {
  const current = { m: { status: 'draft', owner: '', fields: { a: 'Same', b: 'Old' }, layout: [{ field: 'a' }, { field: 'b' }, { field: 'c' }] } }
  test('names the Fields a Save puts content in that the Stage did not hold: new, or different; not the ones it merely carries', () => {
    assert.deepEqual(writtenFields(current, { m: { fields: { a: 'Same', b: 'New', c: 'Fresh', d: '' } } }), ['m.b', 'm.c'])
  })
  test('a Module the Stage holds nothing of yet has every non-empty Field written', () => {
    assert.deepEqual(writtenFields({}, { n: { fields: { x: 'One', y: '' } } }), ['n.x'])
  })
})

describe('guard rails', () => {
  const log = (state, lastAiSave) => ({ ...emptyDecisionsLog('shape'), status: [sessionStatus({ session: 's-a1', who: 'a', state, lastAiSave })] })

  test('an AI never passes a Gate on a workspace whose Stages move on by Pull Request', () => {
    const reason = advanceRefusal({ providerBacked: true, log: log('saved', NOW), sessionId: 's-a1', stageTitle: 'SOAP' })
    assert.match(reason, /never passes a Gate: a Gate that needs approval or review stops it/)
    assert.match(reason, /"SOAP" moves on only when its Pull Request is approved and merged/)
  })

  test('on a local or server workspace it advances only after the session saved the Stage with the state "saved"', () => {
    assert.equal(advanceRefusal({ providerBacked: false, log: log('saved', NOW), sessionId: 's-a1', stageTitle: 'SOAP' }), null)
    assert.equal(advanceRefusal({ providerBacked: false, log: log('paused', NOW), sessionId: 's-a1', stageTitle: 'SOAP' }), UNSAVED_ADVANCE_REFUSAL('SOAP'))
    assert.equal(advanceRefusal({ providerBacked: false, log: log('saved', NOW), sessionId: 's-other', stageTitle: 'SOAP' }), UNSAVED_ADVANCE_REFUSAL('SOAP'), 'another session\'s save is not this one\'s')
    assert.match(UNSAVED_ADVANCE_REFUSAL('SOAP'), /A Pause or "Save and stop here" leaves the Instance on its Stage/)
  })

  test('it asks for approval only for a Stage the session has saved', () => {
    assert.equal(approvalRefusal({ log: log('awaiting-approval', NOW), sessionId: 's-a1', stageTitle: 'SOAP' }), null)
    assert.match(approvalRefusal({ log: log('in-progress', null), sessionId: 's-a1', stageTitle: 'SOAP' }), /asks for approval only after the architect confirmed the stage summary and the session saved "SOAP"/)
    assert.match(approvalRefusal({ log: emptyDecisionsLog('shape'), sessionId: 's-a1', stageTitle: 'SOAP' }), /has not saved it yet/)
  })
})
