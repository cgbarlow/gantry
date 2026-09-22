// GANTRY_BOOTSTRAP_WORKSPACES (#111, parent #109): an operator declares the workspaces a deployment
// should always have, and `gantry serve` rebuilds those registrations on every boot — the registry
// becomes derived state rather than stored state, so an ephemeral container filesystem stops
// mattering (there is nothing durable left to lose). `lib/workspaceRegistry.js`'s `deriveWorkspaceId`
// is what makes this safe: the same provider/location always derives the same id, across a registry
// file that's been wiped and rebuilt from scratch, so a `GANTRY_WORKSPACE_PATS` entry keyed by that id
// survives a restart with no volume.
//
// This module is deliberately split into two steps a caller composes rather than one that does both:
// `parseBootstrapWorkspaces` turns the env var's raw string into validated declarations (throwing
// before anything is touched), and `applyBootstrapWorkspaces` runs each declaration through the
// find-by-location-or-register-with-derived-id composition `deriveWorkspaceId`'s own doc comment
// describes. `lib/server.js`'s `createServer` is the one real caller of both, in sequence, at boot.
import { PROVIDERS, DEFAULT_PROVIDER } from './provider.js'
import { deriveWorkspaceId, findWorkspaceByLocation, registerWorkspace } from './workspaceRegistry.js'

const ENV_VAR_NAME = 'GANTRY_BOOTSTRAP_WORKSPACES'

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
