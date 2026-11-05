// #319 (docs/adr/0072): the browser's half of reading a code repository that an Instance points at as a Source document. The Gantry
// server reads it (POST /api/sources/repository, lib/repositorySource.js) through the Provider clients it already has; this file only asks.
// The architect's own token for the repository is held here and sent the way it is when connecting a workspace: in the browser's credential
// store (web/lib/credential.js), under a key of that repository's own, attached as the request's Basic `Authorization` header. A public
// repository needs none. Nothing here stores anything from the repository.
import { basicAuthHeaderForValue, patForWorkspace, setPatForWorkspace } from './credential.js'
import { SourceDocumentError } from './sourceDocuments.js'
import { repositoryKey } from './sourceRepository.js'

/** Shown when a Local Workspace's Gantry server can't be reached: only the server reads a repository. */
export const REPOSITORY_NEEDS_SERVER = "Reading a code repository needs the Gantry server, which can't be reached right now."

/**
 * #336: shown instead when the Gantry server has answered recently and this one request was cut off, twice: it ran too long for something
 * between the browser and the server (a proxy that gives up, say), or the connection dropped. The server is there; this read failed.
 */
export const REPOSITORY_READ_CUT_OFF = 'This read of the code repository took too long or was cut off on its way from the Gantry server. The server is there: trying it again, or something narrower, usually works.'

/** #336: how long an answer from the Gantry server counts as recent, so that a request cut off after it is not "can't be reached". */
const RECENT_ANSWER_MS = 10 * 60 * 1000
// #336: when the Gantry server last answered a repository request, per `fetch` it was asked through (the browser's own, or a test's).
const lastAnswered = new WeakMap()
// #336: what a proxy in front of the Gantry server answers when it gave up waiting, or couldn't reach it: an answer with no `code` of Gantry's.
const GATEWAY_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524])

/** The architect's token for `repository`, or null when they gave none (a public repository). */
export const repositoryToken = (repository) => patForWorkspace(repositoryKey(repository))

/** Keeps (or, given a blank value, forgets) the architect's token for `repository`. */
export const rememberRepositoryToken = (repository, token) => setPatForWorkspace(repositoryKey(repository), token ?? '')

/**
 * #338: shown when a Repository copy has been preparing for longer than the browser waits for one (the server gives up on a download well
 * before this, so it is a last resort). Only this read failed: the next one picks up where the download has got to.
 */
export const REPOSITORY_STILL_PREPARING = 'Gantry is still preparing its copy of this code repository. Try again in a moment, or something narrower.'

/** #338: how often the browser asks again while the server says a Repository copy is preparing (202). */
export const REPOSITORY_POLL_MS = 3000
/** #338: the longest the browser keeps asking for one call while a copy is preparing. */
const PREPARING_LIMIT_MS = 10 * 60 * 1000

const abandoned = () => new SourceDocumentError('This read of the code repository was stopped.', { code: 'abandoned', status: 499 })

// Waits `ms`, or rejects as abandoned as soon as `signal` aborts.
const pause = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abandoned())
    const done = () => {
      clearTimeout(timer)
      reject(abandoned())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', done)
      resolve()
    }, ms)
    signal?.addEventListener('abort', done, { once: true })
  })

/**
 * Asks the Gantry server to do `action` (`check`, `prepare`, `list`, `read`, `find`, `search` or `compare`) on `repository` with `token`
 * (the architect's own, or null). Resolves the server's answer, or rejects with a `SourceDocumentError` carrying its sentence ("You can't
 * read …").
 * #336: a request that is cut off (no answer at all, or a proxy's answer that it gave up) is asked once more, after `retryWaitMs`. Cut off
 * again, it is refused as `cut-off` when the server has answered recently, and as `server-unreachable` (REPOSITORY_NEEDS_SERVER) when not.
 * #338: while the server answers that its copy of the repository is preparing (202 `{ preparing: true, receivedBytes }`), it is asked
 * again every `pollMs`, and `onPreparing({ receivedBytes, repository })` hears how far the download has got. It is asked again at the
 * commit the server said it is preparing, so that a branch that moves on meanwhile can't start a second download. `signal` abandons the
 * call: nothing more is asked and it rejects as `abandoned`.
 */
export async function callRepository(action, repository, extra = {}, { token = null, fetchImpl = fetch, retryWaitMs = 500, pollMs = REPOSITORY_POLL_MS, onPreparing, signal } = {}) {
  const auth = basicAuthHeaderForValue(token)
  // #338: the commit a 202 named, which every later poll of this call asks at.
  let preparingCommit = null
  const ask = () =>
    fetchImpl('/api/sources/repository', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
      body: JSON.stringify({ action, repository, ...extra, ...(preparingCommit ? { commit: preparingCommit } : {}) }),
      ...(signal ? { signal } : {}),
    }).then(
      async (res) => {
        const body = await res.json().catch(() => null)
        // A proxy that gave up answers too, but not as Gantry does: the server may never have seen the request.
        if (!res.ok && GATEWAY_STATUSES.has(res.status) && !body?.code) return { cutOff: true, answered: true }
        lastAnswered.set(fetchImpl, Date.now())
        return { res, body: body ?? {} }
      },
      () => ({ cutOff: true, answered: false })
    )
  // One request, asked once more if it is cut off (#336).
  const askOnce = async () => {
    let answer = await ask()
    if (signal?.aborted) throw abandoned()
    if (answer.cutOff) {
      await pause(retryWaitMs, signal)
      const again = await ask()
      if (signal?.aborted) throw abandoned()
      answer = again.cutOff ? { ...again, answered: again.answered || answer.answered } : again
    }
    if (answer.cutOff) {
      const recently = answer.answered || Date.now() - (lastAnswered.get(fetchImpl) ?? -Infinity) < RECENT_ANSWER_MS
      if (recently) throw new SourceDocumentError(REPOSITORY_READ_CUT_OFF, { code: 'cut-off', status: 504 })
      throw new SourceDocumentError(REPOSITORY_NEEDS_SERVER, { code: 'server-unreachable', status: 503 })
    }
    return answer
  }
  const startedAt = Date.now()
  for (;;) {
    if (signal?.aborted) throw abandoned()
    const { res, body } = await askOnce()
    if (res.status === 202 && body.preparing) {
      if (Date.now() - startedAt > PREPARING_LIMIT_MS) throw new SourceDocumentError(REPOSITORY_STILL_PREPARING, { code: 'timed-out', status: 504 })
      if (typeof body.commit === 'string' && body.commit) preparingCommit = body.commit
      onPreparing?.({ receivedBytes: Number(body.receivedBytes) || 0, repository: body.repository ?? null })
      await pause(pollMs, signal)
      continue
    }
    if (!res.ok) throw new SourceDocumentError(body.error ?? `Could not read the repository (${res.status}).`, { code: body.code, status: res.status })
    return body
  }
}

/**
 * A reader for one pointer, with the architect's stored token: `{ prepare(), list({ path, commit, page }), read({ path, commit, lines }),
 * find({ pattern, path, page, commit }), search({ query, regex, path, fileTypes, context, filesOnly, page, commit }), compare(reads) }`.
 * #338: a find or search given the `commit` of its first page reads its later pages at that commit too. What the AI's tools
 * (web/lib/interviewSources.js) and Out of date (web/lib/outOfDateLoad.js) are given. #338: each call waits through "preparing", telling
 * `onPreparing` (the reader's, or one call's own as its second argument, with that call's `signal`).
 */
export function repositoryReaderFor(repository, { fetchImpl = fetch, token, retryWaitMs, pollMs, onPreparing, signal } = {}) {
  const call = (action, extra, own = {}) =>
    callRepository(action, repository, extra, {
      token: token === undefined ? repositoryToken(repository) : token,
      fetchImpl,
      retryWaitMs,
      pollMs,
      onPreparing: own.onPreparing ?? onPreparing,
      signal: own.signal ?? signal,
    })
  return {
    prepare: ({ commit } = {}, own) => call('prepare', { commit }, own),
    list: ({ path, commit, page } = {}, own) => call('list', { path, commit, page }, own),
    read: ({ path, commit, lines } = {}, own) => call('read', { path, commit, lines }, own),
    find: ({ pattern, path, page, commit } = {}, own) => call('find', { pattern, path, page, commit }, own),
    search: ({ query, path, regex, fileTypes, context, filesOnly, page, commit } = {}, own) => call('search', { query, regex, path, fileTypes, context, filesOnly, page, commit }, own),
    compare: (reads, own) => call('compare', { reads }, own),
  }
}
