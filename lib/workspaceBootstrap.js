// GANTRY_BOOTSTRAP_WORKSPACES (#111, parent #109): an operator declares the workspaces a deployment
// should always have, and `gantry serve` rebuilds those registrations on every boot — the registry
// becomes derived state rather than stored state, so an ephemeral container filesystem stops
// mattering (there is nothing durable left to lose). `lib/workspaceRegistry.js`'s `deriveWorkspaceId`
// is what makes this safe: the same provider/location always derives the same id, across a registry
// file that's been wiped and rebuilt from scratch, so a `GANTRY_MCP_WORKSPACE_PATS` entry keyed by that id
// survives a restart with no volume.
//
// This module is deliberately split into two steps a caller composes rather than one that does both:
// `parseBootstrapWorkspaces` turns the env var's raw string into validated declarations (throwing
// before anything is touched), and `applyBootstrapWorkspaces` runs each declaration through the
// find-by-location-or-register-with-derived-id composition `deriveWorkspaceId`'s own doc comment
// describes. `lib/server.js`'s `createServer` is the one real caller of both, in sequence, at boot.
//
// GANTRY_SHARED_WORKSPACE_PATS (#121, parent #109, docs/adr/0047 — a rename superseding docs/adr/0046's
// boot-time-only, discovery-only scope; see that ADR for the old name and why it no longer applies) is a
// `{ workspaceId: pat }` map with
// two distinct uses, both opt-in and off by default (unset parses to `{}` and neither runs): first, the
// boot-time discovery this module still performs below (`discoverBootstrapPatInstances`, unchanged in
// what it does — a workspace with a matching entry has its instances discovered once at startup, so
// `GET /api/instances` is already populated before any browser request arrives). Second — the actual
// point of the rename — `lib/registry.js`'s `listRegistry` reads this same parsed map at *request* time
// now too: a request that carries no credential of its own for a shared workspace still gets that
// workspace's rows, built with its entry here instead. That second use is what makes the setting a
// genuine access-control decision rather than a startup convenience, which is exactly why it can no
// longer carry a name that reads like one — see docs/adr/0047 for the full reasoning.
import { PROVIDERS, DEFAULT_PROVIDER } from './provider.js'
import { deriveWorkspaceId, findWorkspaceByLocation, registerWorkspace } from './workspaceRegistry.js'
import { backfillProviderInstances } from './instanceRegistry.js'

const ENV_VAR_NAME = 'GANTRY_BOOTSTRAP_WORKSPACES'
const PATS_ENV_VAR_NAME = 'GANTRY_SHARED_WORKSPACE_PATS'

/**
 * Parses and validates `GANTRY_BOOTSTRAP_WORKSPACES`'s raw string value into an array of workspace
 * declarations (`{ provider?, location, owner?, id? }` each) — mirroring
 * `mcp-server/src/credentials.js`'s `parseWorkspacePats` fail-loud style for its own env var: one
 * actionable line naming `GANTRY_BOOTSTRAP_WORKSPACES`, no stack trace, thrown before anything is
 * registered.
 *
 * Unset or blank (`undefined`, `null`, whitespace-only) returns `[]` — a no-op, not an error, the same
 * convention `parseWorkspacePats` uses for its own empty case.
 *
 * Validation here is deliberately shallow — invalid JSON, not a JSON array, an entry naming an unknown
 * `provider`, or an entry missing its `location` altogether. A `location` that's present but missing
 * one of *its own* required fields (e.g. a GitHub location with no `repository`) is left for
 * `applyBootstrapWorkspaces` to discover via `registerWorkspace`'s own validation — this function's job
 * is catching the shapes that would otherwise crash the composition below outright, not re-implementing
 * `lib/provider.js`'s per-provider schema.
 */
export function parseBootstrapWorkspaces(raw) {
  if (raw === undefined || raw === null || raw.trim() === '') return []

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`${ENV_VAR_NAME} must be valid JSON: ${err.message}`)
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${ENV_VAR_NAME} must be a JSON array of workspace declarations`)
  }

  parsed.forEach((entry, index) => {
    const isObject = entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    const provider = (isObject ? entry.provider : undefined) ?? DEFAULT_PROVIDER
    if (!PROVIDERS.includes(provider)) {
      throw new Error(
        `${ENV_VAR_NAME} entry ${index} has unknown provider "${provider}" — expected one of: ${PROVIDERS.join(', ')}`
      )
    }
    const location = isObject ? entry.location : undefined
    if (location === undefined || location === null) {
      throw new Error(`${ENV_VAR_NAME} entry ${index} is missing required field "location"`)
    }
  })

  return parsed
}

/**
 * Applies already-parsed declarations (`parseBootstrapWorkspaces`'s own return shape) against the
 * workspace registry, idempotently: for each declaration this runs the exact find-by-location-or-
 * register-with-derived-id composition `lib/workspaceRegistry.js`'s `deriveWorkspaceId` doc comment
 * describes — `findWorkspaceByLocation` first, and only `registerWorkspace` with a derived id when
 * nothing is found. An existing workspace at that location, however it was originally created, is
 * returned unchanged and never re-keyed; calling this twice against the same registry registers
 * nothing new the second time.
 *
 * A declaration's own `id` (when present) overrides the derived one — passed straight through as
 * `registerWorkspace`'s `options.id` only in the "nothing found" branch, exactly as an explicit id
 * flows through `registerWorkspace` itself.
 *
 * `options` is forwarded to every registry call (`instancesDir`, or a direct
 * `workspaceRegistryPath`/test override) — the same options shape every `lib/workspaceRegistry.js`
 * function already takes.
 *
 * Returns the applied workspaces' own public records, in declaration order — not currently consumed by
 * `createServer` (the boot step runs for effect), but useful to a caller (or a test) that wants to
 * assert on what got registered without a second registry read.
 */
export function applyBootstrapWorkspaces(declarations, options = {}) {
  return declarations.map((declaration) => {
    const provider = declaration.provider ?? DEFAULT_PROVIDER
    const { location, owner } = declaration

    const existing = findWorkspaceByLocation({ provider, location }, options)
    if (existing) return existing

    const id = declaration.id ?? deriveWorkspaceId(provider, location)
    return registerWorkspace({ provider, location, owner }, { ...options, id })
  })
}

/**
 * Parses and validates `GANTRY_SHARED_WORKSPACE_PATS`'s raw string value into a `{ workspaceId: pat }`
 * map (#121, parent #109, docs/adr/0047 — a renamed, widened-scope `parseBootstrapPats`; see
 * docs/adr/0046 for the superseded name and scope) — the same shape and the same fail-loud validation style as
 * `mcp-server/src/credentials.js`'s `parseWorkspacePats` for its own, differently-scoped env var
 * (`GANTRY_MCP_WORKSPACE_PATS`, read by the separate MCP server process, docs/adr/0043). This is a
 * deliberate duplication, not a shared import: the two live in different packages (`lib/` here,
 * `mcp-server/src/` there) that this codebase does not import across, so the validation logic and
 * message tone are mirrored by hand rather than factored into a shared dependency neither package
 * currently has.
 *
 * Unset or blank (`undefined`, `null`, whitespace-only) returns `{}` — a no-op, not an error, the same
 * convention `parseWorkspacePats`/`parseBootstrapWorkspaces` both use for their own empty case. This is
 * what keeps `GANTRY_SHARED_WORKSPACE_PATS` off by default: an operator who never sets it gets back an
 * empty map, so neither boot-time discovery (`discoverBootstrapPatInstances` below) nor request-time
 * shared-credential row-building (`lib/registry.js`'s `listRegistry`) has anything to resolve, and a
 * workspace stays exactly as unshared as it is today.
 */
export function parseSharedWorkspacePats(raw) {
  if (raw === undefined || raw === null || raw.trim() === '') return {}

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`${PATS_ENV_VAR_NAME} must be valid JSON: ${err.message}`)
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${PATS_ENV_VAR_NAME} must be a JSON object mapping workspace id to PAT`)
  }

  for (const [workspaceId, pat] of Object.entries(parsed)) {
    if (typeof pat !== 'string' || pat === '') {
      throw new Error(`${PATS_ENV_VAR_NAME} entry for workspace "${workspaceId}" must be a non-empty string`)
    }
  }

  return parsed
}

/**
 * For each already-applied bootstrap workspace (`applyBootstrapWorkspaces`'s own return shape) that
 * has a matching entry in `pats` (`parseSharedWorkspacePats`'s own return shape), runs
 * `lib/instanceRegistry.js`'s `backfillProviderInstances` immediately — scoped to that one workspace
 * id only (`options.workspaceId`), never the whole registry, so this boot-time credential's blast
 * radius stays the single workspace it was declared for. This is what makes `GET /api/instances`
 * already populated for that workspace before any browser request arrives — one of two things this
 * same `GANTRY_SHARED_WORKSPACE_PATS` entry now buys (#121, parent #109, docs/adr/0047); the other,
 * request-time row-building with no viewer credential at all, is `lib/registry.js`'s `listRegistry`
 * reading this same parsed map directly, not through this function.
 *
 * A workspace with no matching `pats` entry is left entirely alone — unaffected, and still discovered
 * normally the first time a real request carries a usable credential for it (#112). A workspace whose
 * boot PAT is rejected, expired, or simply can't reach its repo degrades the identical way: caught and
 * logged by `backfillProviderInstances` itself (by workspace id only — the PAT is never part of that
 * message), never thrown back to this function's caller. `lib/server.js`'s own caller additionally
 * never awaits this as a group before calling `.listen()` — the same fire-and-forget posture as its
 * existing startup library-repo refresh — so one slow or unreachable Provider host can never delay
 * this server actually starting.
 *
 * Returns a `Promise` that resolves once every matched workspace's discovery attempt has settled
 * (success or logged failure) — never rejects itself, purely for a caller (or a test) that wants to
 * `await` the batch rather than assert on side effects alone.
 */
export function discoverBootstrapPatInstances(workspaces, pats, options = {}) {
  return Promise.all(
    workspaces
      .filter((workspace) => typeof pats[workspace.id] === 'string')
      .map((workspace) =>
        backfillProviderInstances({ ...options, pat: pats[workspace.id], workspaceId: workspace.id }).catch((err) => {
          console.error(
            `lib/workspaceBootstrap.js: skipping boot-time instance discovery for workspace "${workspace.id}" — ${err.message}`
          )
        })
      )
  )
}
