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

/** The architect's token for `repository`, or null when they gave none (a public repository). */
export const repositoryToken = (repository) => patForWorkspace(repositoryKey(repository))

/** Keeps (or, given a blank value, forgets) the architect's token for `repository`. */
export const rememberRepositoryToken = (repository, token) => setPatForWorkspace(repositoryKey(repository), token ?? '')

/**
 * Asks the Gantry server to do `action` (`check`, `list`, `read`, `search` or `compare`) on `repository` with `token` (the architect's own,
 * or null). Resolves the server's answer, or rejects with a `SourceDocumentError` carrying its sentence ("You can't read …").
 */
export async function callRepository(action, repository, extra = {}, { token = null, fetchImpl = fetch } = {}) {
  const auth = basicAuthHeaderForValue(token)
  let res
  try {
    res = await fetchImpl('/api/sources/repository', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
      body: JSON.stringify({ action, repository, ...extra }),
    })
  } catch {
    throw new SourceDocumentError(REPOSITORY_NEEDS_SERVER, { code: 'server-unreachable', status: 503 })
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new SourceDocumentError(body.error ?? `Could not read the repository (${res.status}).`, { code: body.code, status: res.status })
  return body
}

/**
 * A reader for one pointer, with the architect's stored token: `{ list({ path, commit }), read({ path, commit }), search({ query, path }),
 * compare(reads) }`. What the AI's tools (web/lib/interviewSources.js) and Out of date (web/lib/outOfDateLoad.js) are given.
 */
export function repositoryReaderFor(repository, { fetchImpl = fetch, token } = {}) {
  const call = (action, extra) => callRepository(action, repository, extra, { token: token === undefined ? repositoryToken(repository) : token, fetchImpl })
  return {
    list: ({ path, commit } = {}) => call('list', { path, commit }),
    read: ({ path, commit } = {}) => call('read', { path, commit }),
    search: ({ query, path } = {}) => call('search', { query, path }),
    compare: (reads) => call('compare', { reads }),
  }
}
