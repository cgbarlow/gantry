// The single HTTP client wrapping calls to a target `gantry serve` instance's `/api/*` (docs/adr/0043).
// Every tool goes through `request()` exclusively — nothing else in this package talks HTTP directly.

const CLASSIFY_CACHE_TTL_MS = 30_000

/**
 * Creates a client bound to one `gantry serve` deployment. `workspacePats` is the parsed
 * `GANTRY_WORKSPACE_PATS` map (workspace id -> PAT), read once at startup and held only here.
 */
export function createGantryClient({ baseUrl, workspacePats = {}, fetchImpl = fetch }) {
  if (!baseUrl) throw new Error('createGantryClient requires a baseUrl')

  let classifyCache = null // { at, providerBacked: Set<id>, serverHosted: Set<id> }

  async function rawFetch(path, { method = 'GET', query, body, authorization } = {}) {
    const url = new URL(path, baseUrl)
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
      }
    }
    const headers = {}
    if (authorization) headers['authorization'] = authorization
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetchImpl(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let parsedBody = null
    if (text) {
      try {
        parsedBody = JSON.parse(text)
      } catch {
        parsedBody = text
      }
    }
    return { ok: res.ok, status: res.status, body: parsedBody }
  }

  // Classifies every workspace id gantry serve currently knows about as Provider-backed
  // (`GET /api/workspaces`) or server-directory (`GET /api/server-workspaces`), cached briefly so
  // repeated tool calls in the same operator session don't re-fetch both lists every time.
  async function loadClassification() {
    const now = Date.now()
    if (classifyCache && now - classifyCache.at < CLASSIFY_CACHE_TTL_MS) return classifyCache

    const [workspacesRes, serverWorkspacesRes] = await Promise.all([
      rawFetch('/api/workspaces', { query: { archived: '1' } }),
      rawFetch('/api/server-workspaces'),
    ])

    const providerBacked = new Set((Array.isArray(workspacesRes.body) ? workspacesRes.body : []).map((w) => w.id))
    const serverHosted = new Set((Array.isArray(serverWorkspacesRes.body) ? serverWorkspacesRes.body : []).map((w) => w.id))

    classifyCache = { at: now, providerBacked, serverHosted }
    return classifyCache
  }

  function invalidateClassification() {
    classifyCache = null
  }

  // Resolves the credential (if any) a call touching `workspaceId` should carry, without ever
  // exposing a PAT to the caller. Returns `{ authorization }` (possibly `undefined`, for a
  // server-directory workspace) or `{ error }` — a structured, actionable payload naming the
  // workspace and the expected env var — for a missing PAT or an unknown workspace id.
  async function resolveCredential(workspaceId) {
    const { providerBacked, serverHosted } = await loadClassification()

    if (providerBacked.has(workspaceId)) {
      const pat = workspacePats[workspaceId]
      if (!pat) {
        return {
          error: {
            error: 'missing_workspace_pat',
            workspace: workspaceId,
            envVar: 'GANTRY_WORKSPACE_PATS',
            message: `No Personal Access Token is configured for Provider-backed workspace "${workspaceId}". Add an entry for it to the GANTRY_WORKSPACE_PATS env var and restart the MCP server.`,
          },
        }
      }
      return { authorization: 'Basic ' + Buffer.from(':' + pat, 'utf8').toString('base64') }
    }

    if (serverHosted.has(workspaceId)) {
      return { authorization: undefined }
    }

    return {
      error: {
        error: 'workspace_not_found',
        workspace: workspaceId,
        message: `No workspace "${workspaceId}" was found (checked both Provider-backed and server-directory workspaces).`,
      },
    }
  }

  /**
   * Makes a call against `gantry serve`'s `/api/*`.
   *
   * - `workspaceId` omitted/null: no credential resolution at all (e.g. `list_workspaces` itself,
   *   or a repo-check that runs before any workspace exists).
   * - `workspaceId` given: resolves the credential per `resolveCredential` above and attaches it
   *   automatically. Never hits `path` when that resolution fails — the caller gets `credentialError`
   *   back instead, so a missing/rejected PAT never reaches the actual action.
   * - `patOverride`: bypasses credential resolution and attaches this PAT directly — the one seam
   *   `check_repo`/`create_workspace` need, since they validate a PAT for a workspace that doesn't
   *   exist yet and so isn't in `GANTRY_WORKSPACE_PATS`.
   */
  async function request({ workspaceId, path, method = 'GET', query, body, patOverride } = {}) {
    let authorization
    if (patOverride !== undefined) {
      authorization = 'Basic ' + Buffer.from(':' + patOverride, 'utf8').toString('base64')
    } else if (workspaceId !== undefined && workspaceId !== null) {
      const resolved = await resolveCredential(workspaceId)
      if (resolved.error) return { ok: false, status: 0, credentialError: resolved.error }
      authorization = resolved.authorization
    }
    return rawFetch(path, { method, query, body, authorization })
  }

  return { request, invalidateClassification }
}
