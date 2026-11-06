// #294 (parent #238, docs/adr/0064 as amended by #255): what the architect sees about tokens during an AI interview. Tokens only, never
// money, and no budgets or limits: the Interview page's rail shows this session's tokens, the Stage's earlier sessions' and how full the
// conversation is (#348), the run plan shows each Stage's total, and the decisions log's status block keeps each model's input, cached
// and output tokens so a session resumed in another browser keeps its totals. The numbers are what each AI Provider reports; this file
// only adds them up and says them in words.
//
// A total is `{ input, cached, output }`. `input` is ALL the input, cached or not (web/lib/aiAdapters.js makes the two wire formats
// agree), so "the share of input read from cache" is `cached / input`. Pure: no DOM, no network.

export const EMPTY_TOKENS = Object.freeze({ input: 0, cached: 0, output: 0 })

const count = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Math.round(Number(n)) : 0)

/** One status-block model line (`{ inputTokens, cachedTokens, outputTokens }`, or `tokens: 'not reported'`) as a total. */
export function tokensOfModel(line) {
  if (!line || typeof line !== 'object') return { ...EMPTY_TOKENS }
  return { input: count(line.inputTokens), cached: count(line.cachedTokens), output: count(line.outputTokens) }
}

export function addTokens(a, b) {
  return { input: count(a?.input) + count(b?.input), cached: count(a?.cached) + count(b?.cached), output: count(a?.output) + count(b?.output) }
}

/** The total of a list of status-block model lines. */
export function tokensOfModels(models) {
  return (Array.isArray(models) ? models : []).reduce((sum, line) => addTokens(sum, tokensOfModel(line)), { ...EMPTY_TOKENS })
}

/** A session's usage as the AI client counts it (`{ inputTokens, cacheReadTokens, outputTokens }`) as a total. */
export function tokensOfUsage(usage) {
  return { input: count(usage?.inputTokens), cached: count(usage?.cacheReadTokens), output: count(usage?.outputTokens) }
}

/**
 * Everything a Stage's committed decisions log says was used on it: every session's status entry, except `exceptSession`'s (a session
 * still going counts its own, in full, from memory, so its older committed line must not be counted twice) and those in `exceptSessions`
 * (#348: the sessions a Start this stage over ended in this browser, also counted from memory).
 */
export function tokensOfLog(log, { exceptSession = null, exceptSessions = [] } = {}) {
  const entries = Array.isArray(log?.status) ? log.status : []
  const skip = new Set([exceptSession, ...exceptSessions].filter(Boolean))
  return entries.filter((s) => !skip.has(s.session)).reduce((sum, s) => addTokens(sum, tokensOfModels(s.models)), { ...EMPTY_TOKENS })
}

/**
 * #348: the Tokens block's figures for the Stage the interview is on. `log` is the Stage's committed decisions log; `session` and `tokens`
 * are the running session's id and what it has used since it began or was last started over; `ended` (`[{ session, tokens }]`) is the
 * sessions a Start this stage over ended in this browser. `thisSession` is the running session alone; `earlier` is everything else the
 * Stage used (the log's other sessions, and the ended ones from memory, their committed lines being older); `stage` is the two together,
 * the run plan's total for the Stage. In a browser with no session running, everything in the log is `earlier`.
 */
export function stageTokenFigures(log, { session = null, tokens = EMPTY_TOKENS, ended = [] } = {}) {
  const endedList = Array.isArray(ended) ? ended : []
  const committed = tokensOfLog(log, { exceptSession: session, exceptSessions: endedList.map((e) => e.session) })
  const earlier = endedList.reduce((sum, e) => addTokens(sum, e.tokens), committed)
  const thisSession = addTokens(EMPTY_TOKENS, tokens)
  return { thisSession, earlier, stage: addTokens(earlier, thisSession) }
}

export const hasTokens = (t) => count(t?.input) + count(t?.output) > 0

/** A whole percentage of the input that was read from the cache, or null when there was no input. */
export function cacheShare(t) {
  const input = count(t?.input)
  if (!input) return null
  return Math.min(100, Math.round((count(t?.cached) / input) * 100))
}

/** "850 tokens", "610k tokens", "1.2M tokens": the size of a total in words, input and output together. */
export function formatTokens(n) {
  const value = count(n)
  const trim = (x) => String(Math.round(x * 10) / 10).replace(/\.0$/, '')
  if (value < 1000) return `${value} ${value === 1 ? 'token' : 'tokens'}`
  if (value < 10_000) return `${trim(value / 1000)}k tokens`
  if (value < 1_000_000) return `${Math.round(value / 1000)}k tokens`
  return `${trim(value / 1_000_000)}M tokens`
}

/**
 * #348: how full the AI's conversation is, for the Tokens block's Context: `tokens` is the input the AI Provider reported for the last
 * call (what counts against the model's limit), `window` the model's context window. "120k of 1M (12%)", or "120k tokens" where the window
 * is not known. '' when there is no call to measure.
 */
export function formatContext(context) {
  const tokens = count(context?.tokens)
  if (!tokens) return ''
  const window = count(context?.window)
  if (!window) return formatTokens(tokens)
  const share = (tokens / window) * 100
  const short = (n) => formatTokens(n).replace(/ tokens?$/, '')
  return `${short(tokens)} of ${short(window)} (${share > 0 && share < 1 ? '<1' : Math.round(share)}%)`
}

/** What a total is called in the rail and the run plan: input and output together. */
export const totalTokens = (t) => count(t?.input) + count(t?.output)

/** The hover text for a total: input, cached and output tokens, and the share of input read from cache. */
export function tokenBreakdown(t) {
  const fmt = (n) => count(n).toLocaleString('en-US')
  const share = cacheShare(t)
  return [`Input ${fmt(t?.input)} tokens`, `cached ${fmt(t?.cached)}`, `output ${fmt(t?.output)}`].join(', ') + (share === null ? '.' : `. ${share}% of input read from cache.`)
}
