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
 * Asks the Gantry server to do `action` (`check`, `list`, `read`, `search` or `compare`) on `repository` with `token` (the architect's own,
 * or null). Resolves the server's answer, or rejects with a `SourceDocumentError` carrying its sentence ("You can't read …").
 * #336: a request that is cut off (no answer at all, or a proxy's answer that it gave up) is asked once more, after `retryWaitMs`. Cut off
 * again, it is refused as `cut-off` when the server has answered recently, and as `server-unreachable` (REPOSITORY_NEEDS_SERVER) when not.
 */
export async function callRepository(action, repository, extra = {}, { token = null, fetchImpl = fetch, retryWaitMs = 500 } = {}) {
  const auth = basicAuthHeaderForValue(token)
  const ask = () =>
    fetchImpl('/api/sources/repository', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
      body: JSON.stringify({ action, repository, ...extra }),
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
  let answer = await ask()
  if (answer.cutOff) {
    await new Promise((resolve) => setTimeout(resolve, retryWaitMs))
    const again = await ask()
    answer = again.cutOff ? { ...again, answered: again.answered || answer.answered } : again
  }
  if (answer.cutOff) {
    const recently = answer.answered || Date.now() - (lastAnswered.get(fetchImpl) ?? -Infinity) < RECENT_ANSWER_MS
    if (recently) throw new SourceDocumentError(REPOSITORY_READ_CUT_OFF, { code: 'cut-off', status: 504 })
    throw new SourceDocumentError(REPOSITORY_NEEDS_SERVER, { code: 'server-unreachable', status: 503 })
  }
  const { res, body } = answer
  if (!res.ok) throw new SourceDocumentError(body.error ?? `Could not read the repository (${res.status}).`, { code: body.code, status: res.status })
  return body
}

/**
 * A reader for one pointer, with the architect's stored token: `{ list({ path, commit }), read({ path, commit }), search({ query, path }),
 * compare(reads) }`. What the AI's tools (web/lib/interviewSources.js) and Out of date (web/lib/outOfDateLoad.js) are given.
 */
export function repositoryReaderFor(repository, { fetchImpl = fetch, token, retryWaitMs } = {}) {
  const call = (action, extra) => callRepository(action, repository, extra, { token: token === undefined ? repositoryToken(repository) : token, fetchImpl, retryWaitMs })
  return {
    list: ({ path, commit } = {}) => call('list', { path, commit }),
    read: ({ path, commit } = {}) => call('read', { path, commit }),
    search: ({ query, path } = {}) => call('search', { query, path }),
    compare: (reads) => call('compare', { reads }),
  }
}
