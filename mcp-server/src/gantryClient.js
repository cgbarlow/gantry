// The single HTTP client wrapping calls to a target `gantry serve` instance's `/api/*` (docs/adr/0043).
// Every tool goes through `request()` exclusively — nothing else in this package talks HTTP directly.

const CLASSIFY_CACHE_TTL_MS = 30_000

/**
 * Creates a client bound to one `gantry serve` deployment. `workspacePats` is the parsed
 * `GANTRY_MCP_WORKSPACE_PATS` map (workspace id -> PAT), read once at startup and held only here.
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
      // #188: never follow a redirect — fetch re-sends a POST as a GET after a 301/302, which turned
      // create_instance into a silent instance listing. A redirecting base URL is a misconfiguration
      // the operator has to see.
      redirect: 'manual',
    })
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      const target = location ? new URL(location, url).href : '(no Location header)'
      return {
        ok: false,
        status: res.status,
        body: {
          error: `gantry serve redirected ${method} ${url.href} to ${target} — not followed, since a redirect can turn a write into a read. Set GANTRY_MCP_BASE_URL to the address gantry serve answers on directly.`,
        },
      }
    }
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
            envVar: 'GANTRY_MCP_WORKSPACE_PATS',
            message: `No Personal Access Token is configured for Provider-backed workspace "${workspaceId}". Add an entry for it to the GANTRY_MCP_WORKSPACE_PATS env var and restart the MCP server.`,
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
   *   exist yet and so isn't in `GANTRY_MCP_WORKSPACE_PATS`.
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

  // #189: gantry serve only learns a Provider-backed workspace's instances when something lists it
  // with a credential that can read it — and its registry starts empty again after every restart of
  // an ephemeral host. The browser always sends one; this server's unscoped calls
  // (`list_instances`, slug lookup) never did, so those instances stayed invisible here until a
  // browser happened to list them. This lists once with each configured workspace PAT, which makes
  // gantry serve discover (and register) that workspace's instances, and returns every row seen.
  // Throttled like the classification cache, so a burst of lookups discovers once.
  let discoveryCache = null // { at, rows }
  async function discoverProviderInstances({ includeArchived = false, force = false } = {}) {
    const now = Date.now()
    if (!force && !includeArchived && discoveryCache && now - discoveryCache.at < CLASSIFY_CACHE_TTL_MS) return discoveryCache.rows
    const pats = [...new Set(Object.values(workspacePats).filter(Boolean))]
    const listings = await Promise.all(
      pats.map((pat) =>
        rawFetch('/api/instances', {
          query: includeArchived ? { archived: '1' } : undefined,
          authorization: 'Basic ' + Buffer.from(':' + pat, 'utf8').toString('base64'),
        })
      )
    )
    const rows = listings.flatMap((res) => (res.ok && Array.isArray(res.body) ? res.body : []))
    if (!includeArchived) discoveryCache = { at: now, rows }
    return rows
  }

  return { request, invalidateClassification, discoverProviderInstances }
}

/**
 * Resolves the workspace id (and canonical `scope` addressing token) an instance slug lives in —
 * every instance-scoped tool needs this *before* it can attach the right credential via
 * `request()`'s own `workspaceId`, since a slug alone doesn't say which workspace/PAT it needs.
 * Wraps `GET /api/instance/workspace` (an unscoped, no-PAT-required lookup — see that route's own
 * doc comment in lib/server.js), forwarding whichever of `slug`/`scope`/`ref` the caller has (the
 * same three-way query contract every instance route shares, `resolveSlugParam` in lib/server.js).
 *
 * Returns the raw `{ ok, status, body }` shape `request()` always returns — callers check `.ok`
 * before trusting `.body.workspaceId` (`null` for a local/unknown instance, a real workspace id for
 * a Provider-backed one) exactly as they would any other `gantryClient.request()` result.
 */
export async function resolveInstanceWorkspace({ gantryClient, slug, scope, ref } = {}) {
  const query = {}
  if (slug !== undefined) query.slug = slug
  if (scope !== undefined) query.scope = scope
  if (ref !== undefined) query.ref = ref
  const res = await gantryClient.request({ path: '/api/instance/workspace', query })
  // #189: `null` means local *or* not yet known to gantry serve — a Provider-backed instance nothing
  // has listed with a credential since its last restart. Discover, then ask once more.
  const unresolved = res.ok && res.body?.workspaceId == null && scope === undefined
  if (!unresolved || !gantryClient.discoverProviderInstances) return res
  await gantryClient.discoverProviderInstances()
  return gantryClient.request({ path: '/api/instance/workspace', query })
}
