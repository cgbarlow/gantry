import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { decisionsLogCounts, referenceToggleState, referenceView } from '../web/lib/referenceView.js'

// #320: the pure part of the editor's Sources & decisions toggle: what it counts and when it has nothing to show.
// tests/referenceView.playwright.test.js covers the toggle in the editor on a local and a server workspace.

describe('the Sources & decisions toggle', () => {
  test('starts off', () => {
    assert.equal(referenceView.value, false)
  })

  test('counts unanswered review comment threads plus open questions', () => {
    assert.deepEqual(referenceToggleState({ sourcesOffered: true, review: { copies: 2, unanswered: 3 }, decisions: { total: 5, open: 2 } }), { count: 5, disabled: false })
    assert.equal(referenceToggleState({ sourcesOffered: true }).count, 0, 'nothing read yet counts nothing')
  })

  test('is disabled only when no panel has anything to show', () => {
    assert.equal(referenceToggleState({ sourcesOffered: false, review: { copies: 0, unanswered: 0 }, decisions: { total: 0, open: 0 } }).disabled, true)
    assert.equal(referenceToggleState({}).disabled, true)
    assert.equal(referenceToggleState({ sourcesOffered: true }).disabled, false, 'the Source documents panel always has its upload')
    assert.equal(referenceToggleState({ review: { copies: 1, unanswered: 0 } }).disabled, false, 'a Reviewed copy with every thread answered still shows')
    assert.equal(referenceToggleState({ review: { copies: 0, unanswered: 0, error: true } }).disabled, false, "the panel says it couldn't list the copies")
    assert.equal(referenceToggleState({ decisions: { total: 1, open: 0 } }).disabled, false)
  })
})

describe("a Stage's decisions log as the toggle counts it", () => {
  test('every entry, and the open questions still standing', () => {
    assert.deepEqual(decisionsLogCounts(null), { total: 0, open: 0 })
    assert.deepEqual(decisionsLogCounts({ entries: [] }), { total: 0, open: 0 })
    const log = {
      entries: [
        { id: 'q-1', kind: 'open-question', question: 'Who pays?' },
        { id: 'q-2', kind: 'open-question', question: 'When?' },
        { id: 'a-1', kind: 'answer', question: 'When?', answer: 'Q3', resolves: 'q-2' },
        { id: 'f-1', kind: 'fact', words: 'The sponsor is Ana.' },
      ],
    }
    assert.deepEqual(decisionsLogCounts(log), { total: 4, open: 1 }, 'the question an answer closed is no longer open')
  })
})
