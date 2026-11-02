import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_TOKENS, addTokens, cacheShare, formatTokens, hasTokens, tokenBreakdown, tokensOfLog, tokensOfModels, tokensOfUsage, totalTokens } from '../web/lib/tokenUsage.js'
import { applyDecisionsDelta, emptyDecisionsLog, parseDecisionsLog, serializeDecisionsLog } from '../web/lib/decisionsLog.js'
import { createSessionLog } from '../web/lib/interviewLog.js'
import { runStartStage } from '../web/lib/interviewRun.js'

// #294 (parent #238, ADR-0064 as amended by #255): tokens the architect sees, never money.

test('tokens add up across the models a Stage used, and a model that reported none counts for nothing', () => {
  const models = [
    { type: 'anthropic', model: 'claude-x', inputTokens: 1000, cachedTokens: 600, outputTokens: 50 },
    { type: 'openai', model: 'gpt-x', inputTokens: 200, cachedTokens: 0, outputTokens: 20 },
    { type: 'anthropic', model: 'agent', tokens: 'not reported' },
  ]
  assert.deepEqual(tokensOfModels(models), { input: 1200, cached: 600, output: 70 })
  assert.deepEqual(tokensOfModels(undefined), EMPTY_TOKENS)
  assert.deepEqual(tokensOfUsage({ inputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 1, outputTokens: 2 }), { input: 5, cached: 3, output: 2 })
  assert.deepEqual(addTokens({ input: 1, cached: 1, output: 1 }, undefined), { input: 1, cached: 1, output: 1 })
})

test('a Stage total is every session on the Stage, leaving out the one still going (it is counted from memory)', () => {
  const log = {
    status: [
      { session: 's-a', models: [{ inputTokens: 100, cachedTokens: 40, outputTokens: 10 }] },
      { session: 's-b', models: [{ inputTokens: 300, cachedTokens: 0, outputTokens: 30 }, { inputTokens: 50, cachedTokens: 50, outputTokens: 5 }] },
    ],
  }
  assert.deepEqual(tokensOfLog(log), { input: 450, cached: 90, output: 45 })
  assert.deepEqual(tokensOfLog(log, { exceptSession: 's-b' }), { input: 100, cached: 40, output: 10 })
  assert.deepEqual(tokensOfLog(null), EMPTY_TOKENS)
})

test('the share of input read from cache is a whole percentage, and there is none without input', () => {
  assert.equal(cacheShare({ input: 1000, cached: 720, output: 5 }), 72)
  assert.equal(cacheShare({ input: 3, cached: 1, output: 0 }), 33)
  assert.equal(cacheShare({ input: 0, cached: 0, output: 9 }), null)
  assert.equal(cacheShare({ input: 10, cached: 99, output: 0 }), 100, 'never more than all of it')
})

test('tokens are said in words: "610k tokens", with no money figure anywhere', () => {
  assert.equal(formatTokens(0), '0 tokens')
  assert.equal(formatTokens(1), '1 token')
  assert.equal(formatTokens(850), '850 tokens')
  assert.equal(formatTokens(1234), '1.2k tokens')
  assert.equal(formatTokens(2000), '2k tokens')
  assert.equal(formatTokens(610_400), '610k tokens')
  assert.equal(formatTokens(1_250_000), '1.3M tokens')
  assert.equal(totalTokens({ input: 600_000, cached: 500_000, output: 10_000 }), 610_000)
  for (const n of [0, 5, 999, 123456, 98765432]) assert.doesNotMatch(formatTokens(n), /[$£€]|\bUSD\b|\bcost\b/i)
})

test('the hover breakdown gives input, cached and output tokens and the share read from cache', () => {
  assert.equal(tokenBreakdown({ input: 1_000_000, cached: 720_000, output: 12_345 }), 'Input 1,000,000 tokens, cached 720,000, output 12,345. 72% of input read from cache.')
  assert.equal(tokenBreakdown({ input: 0, cached: 0, output: 0 }), 'Input 0 tokens, cached 0, output 0.')
  assert.doesNotMatch(tokenBreakdown({ input: 10, cached: 5, output: 1 }), /[$£€]|cost/i)
  assert.equal(hasTokens({ input: 0, cached: 0, output: 0 }), false)
  assert.equal(hasTokens({ input: 1, cached: 0, output: 0 }), true)
})

test('the session log keeps one line per model with its own input, cached and output tokens, and the file keeps them through a resume', () => {
  const log = createSessionLog({ stageId: 'shape', newSessionId: () => 's-1', who: () => 'a.architect' })
  const claude = { type: 'anthropic', model: 'claude-x', key: 'sk-ant-SECRET0123456789', address: 'https://private.example.com', name: 'My own' }
  const gpt = { type: 'openai', model: 'gpt-x' }
  log.addUsage(claude, { inputTokens: 800, cacheReadTokens: 600, cacheWriteTokens: 100, outputTokens: 40 })
  log.addUsage(claude, { inputTokens: 900, cacheReadTokens: 800, cacheWriteTokens: 0, outputTokens: 20 })
  log.addUsage(gpt, { inputTokens: 100, cacheReadTokens: 0, outputTokens: 5 })
  const delta = log.delta({ status: { state: 'saved' } })
  assert.deepEqual(delta.status.models, [
    { type: 'anthropic', model: 'claude-x', inputTokens: 1700, cachedTokens: 1400, outputTokens: 60 },
    { type: 'openai', model: 'gpt-x', inputTokens: 100, cachedTokens: 0, outputTokens: 5 },
  ])

  // Committed, then read back by another browser: the totals are in the file, and no key or address got in.
  const written = serializeDecisionsLog(applyDecisionsDelta(emptyDecisionsLog('shape'), delta, 'shape'))
  assert.doesNotMatch(written, /SECRET|private\.example|My own/)
  const readBack = parseDecisionsLog(written, 'shape')
  assert.deepEqual(tokensOfLog(readBack), { input: 1800, cached: 1400, output: 65 })
  assert.deepEqual(readBack.status[0].models.map((m) => [m.type, m.model]), [['anthropic', 'claude-x'], ['openai', 'gpt-x']])
})

test("a run's start Stage is the earliest Stage its last Save named, so a resumed run adds up what it already used", () => {
  const STAGES = [{ id: 'one' }, { id: 'two' }, { id: 'three' }, { id: 'four' }]
  const log = { status: [{ session: 'x', state: 'saved', target: 'four', stages: { two: 'done', three: 'saved', four: 'waiting' } }] }
  assert.equal(runStartStage(STAGES, log, 'three'), 'two')
  assert.equal(runStartStage(STAGES, { status: [{ session: 'x' }] }, 'three'), 'three')
  assert.equal(runStartStage(STAGES, null, 'three'), 'three')
})
