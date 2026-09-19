/**
 * The Provider model (spec #1, ADR-0037): a Provider is an external *suite* supplying both halves
 * of a remote workspace — the repo holding instance content and the tracker holding its work items.
 * A workspace or library repo names exactly one. This module is the shared, provider-discriminated
 * location shape and validation both `lib/workspaceRegistry.js` and `lib/librarySettings.js` build
 * on — not the capability-interface registry (content store / pull requests / work items / identity)
 * that resolves a provider to real clients, which is a separate, later concern (#2, ADR-0039).
 *
 * Modeled now so Atlassian support could be added later without a schema migration, exactly the
 * reasoning `lib/workspaceRegistry.js` already used for `TICKETING_SYSTEMS`/'jira' — but only
 * 'azure-devops', 'github', (ADR-0041) 'gitlab' and (ADR-0042) 'atlassian' are actually accepted
 * today. `PROVIDERS` is the full modeled enum; `SUPPORTED_PROVIDERS` is the enforcement list — the
 * two now coincide, since atlassian was the last modeled-but-unbuilt provider. Atlassian itself has
 * no registered capabilities yet (`lib/providerRegistry.js` — those land per Atlassian-capability
 * ticket, per #39's task list) — accepting it here only means an `atlassian` location validates and
 * normalizes correctly; a caller that actually needs a live Bitbucket/Jira client still gets
 * `getProviderCapabilities`'s own clear "not registered" error until one exists.
 */

export const PROVIDERS = ['azure-devops', 'github', 'gitlab', 'atlassian']
const SUPPORTED_PROVIDERS = ['azure-devops', 'github', 'gitlab', 'atlassian']
export const DEFAULT_PROVIDER = 'azure-devops'

// Each provider's location fields (ADR-0037; GitLab's own shape decided in ADR-0041; Atlassian's in
// ADR-0042): Azure DevOps keeps organization/project/repository, GitHub takes owner/repository — no
// `project`, so a GitHub record is never required to carry one. GitLab takes namespace/repository:
// `namespace` is GitLab's full group/subgroup path as one opaque string, however many segments deep
// (never split into per-level fields); `repository` deliberately reuses GitHub's key rather than
// GitLab's own "Project" term, which would collide with Azure DevOps's differently-scoped `project`
// field (ADR-0041). The wizard still *labels* the field "Project" to a GitLab user — only this
// internal key is neutral. `baseUrl` is optional on azure-devops/github/gitlab, gating a
// caller-supplied override behind the same per-provider SSRF-allow flag semantics either way
// (ADR-0039) — GitLab's self-hosted CE/EE support (ADR-0041) reuses this same mechanism with no
// schema change of its own.
//
// Atlassian (ADR-0042) is the split-suite exception: `owner`/`repository` reuse GitHub's own keys
// for the Bitbucket Cloud half (`workspace-slug/repo-slug` addresses identically to GitHub's
// `owner/repository`), `jiraSite` holds Jira Cloud's required per-tenant hostname, and
// `jiraProjectKey` stays prefixed rather than bare `project` — a third provider already claiming
// that word for a third different thing. All four fields are required and there is no `baseUrl`:
// Atlassian v1 is Cloud-only, so both products' API hosts are fixed (`api.bitbucket.org`, and each
// tenant's own `jiraSite`) rather than a self-hosted override needing to be gated.
const LOCATION_SCHEMA = {
  'azure-devops': { required: ['organization', 'project', 'repository'], optional: ['baseUrl'] },
  github: { required: ['owner', 'repository'], optional: ['baseUrl'] },
  gitlab: { required: ['namespace', 'repository'], optional: ['baseUrl'] },
  atlassian: { required: ['owner', 'repository', 'jiraSite', 'jiraProjectKey'], optional: [] },
}

/**
 * Throws unless `value` is a provider gantry actually supports today. Exported so any other place a
 * provider value gets set runs the exact same check, mirroring `lib/workspaceRegistry.js`'s prior
 * `assertValidTicketingSystem`.
 */
export function assertValidProvider(value) {
  if (!PROVIDERS.includes(value)) {
    throw new Error(`Unknown provider "${value}" — expected one of: ${PROVIDERS.join(', ')}`)
  }
  if (!SUPPORTED_PROVIDERS.includes(value)) {
    throw new Error(`Provider "${value}" is not supported yet — only ${SUPPORTED_PROVIDERS.join(', ')} is available today`)
  }
}

/**
 * Validates `location` against `provider`'s own required/optional fields and returns a pruned copy
 * holding only the fields that provider actually has, in canonical (required, then optional) key
 * order — a stray field for the wrong provider (e.g. a `project` on a GitHub location) is dropped
 * rather than persisted. `entityLabel` customizes the error message ("A workspace location", "A
 * library repo location", …) the way `lib/workspaceRegistry.js`'s own message did.
 */
export function normalizeProviderLocation(provider, location, { entityLabel = 'A location' } = {}) {
  assertValidProvider(provider)
  const schema = LOCATION_SCHEMA[provider]
  const source = location ?? {}
  const missing = schema.required.filter((key) => !source[key])
  if (missing.length) {
    throw new Error(`${entityLabel} is missing: ${missing.join(', ')}`)
  }
  const normalized = {}
  for (const key of schema.required) normalized[key] = source[key]
  for (const key of schema.optional) {
    if (source[key]) normalized[key] = source[key]
  }
  return normalized
}

/**
 * Tuple-matches two locations under the same provider (ADR-0037: "two workspaces on different
 * providers sharing a repository name are distinct" — callers are expected to have already checked
 * `providerA === providerB` before calling this). `baseUrl` participates in the match, compared as
 * "absent" whether it's `undefined` or omitted, matching every other exact-tuple-match convention
 * already in this codebase (`lib/workspaceRegistry.js`'s prior `findWorkspaceByLocation`).
 */
export function providerLocationsMatch(provider, a, b) {
  const schema = LOCATION_SCHEMA[provider]
  if (!schema) return false
  return [...schema.required, ...schema.optional].every((key) => (a?.[key] ?? undefined) === (b?.[key] ?? undefined))
}

/**
 * A human-readable `provider`-appropriate label for `location` — `owner/repository` for GitHub,
 * `organization/project/repository` for Azure DevOps — used anywhere a repo needs naming in a
 * message or a display row (`lib/definitionHome.js`'s library-repo clash messages,
 * `lib/definitionPromote.js`'s promotion result rows) without that caller needing to know each
 * provider's own field names.
 *
 * Atlassian (ADR-0042) is deliberately described as just `owner/repository` — the Bitbucket half,
 * naming the actual content-store repo the same way GitHub's does — rather than every required
 * field. `jiraSite`/`jiraProjectKey` name Jira's work-item container, not the repo, and every caller
 * of this function (library-repo clash messages, Promote result rows) is describing a repo, so
 * folding Jira's own fields in would misdescribe what's actually being named — consistent with a
 * Library repo (ADR-0036) never touching the Jira half at all (ADR-0042).
 */
export function describeProviderLocation(provider, location) {
  const schema = LOCATION_SCHEMA[provider]
  if (!schema) return String(location?.repository ?? '')
  if (provider === 'atlassian') return [location?.owner, location?.repository].join('/')
  return schema.required.map((key) => location?.[key]).join('/')
}
