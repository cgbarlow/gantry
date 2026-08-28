import { statSync } from 'node:fs'
import { join } from 'node:path'
import { localFilesystemStorage as storage } from './storage.js'
import { listWorkspaceIdsInStorageOrder } from './workspaceRegistry.js'
import { listRegisteredSlugsInStorageOrder, resolveInstanceWorkspaceId } from './instanceRegistry.js'

/**
 * The numeric-reference registry (WI200, docs/adr/0024): a short, scoped, sequential integer id for each workspace and each instance, layered additively on top of the real storage keys (`lib/workspaceRegistry.js`'s workspace uuid, `lib/instanceRegistry.js`'s slug) rather than replacing either. Nothing here is ever read back by those two modules, or by anything that resolves a slug/workspace id off disk — this is purely the reverse direction: "given a short number, which real id/slug does it mean", plus the bookkeeping to hand out the next number.
 *
 * Stage numbers are deliberately *not* tracked here at all: per the ADR, a stage's number is just its 1-based position in its own instance's current definition's `stages` array (stage 1 = that definition's first stage) — a value that's already fully determined by data this module has no business duplicating. `stageNumberForStageId`/`stageIdForNumber` below are pure lookups over a caller-supplied `definition`, not persisted state.
 *
 * Workspace numbers are a single global sequence (a workspace has no parent to scope under). Instance numbers restart at 1 within each *scope* — a real workspace's own uuid for an Azure-DevOps-backed instance, or the single shared `LOCAL_SCOPE` bucket every local instance falls into (a local instance has no real workspace of its own to scope under — Workspace, `lib/workspaceRegistry.js`, is an Azure-DevOps-repo concept only).
 *
 * Persisted the same way the other two registries are: one JSON file colocated inside `instancesDir`, read fresh on every call (never cached in memory) so concurrent callers always see the latest persisted state. Not committed to git (see .gitignore) — same as instance-registry.json/workspace-registry.json.
 */

const NUMBER_REGISTRY_FILENAME = 'number-registry.json'

// Every local instance shares this one numbering bucket — never a real workspace id (those are always randomUUID()s, which can never collide with this literal).
export const LOCAL_SCOPE = 'local'

// The reserved workspace *number* a numeric ref uses for the local scope, so a ref's leading `w<N>` segment is always present and unambiguous — real workspace numbers are always >= 1 (assigned sequentially, see getOrAssignWorkspaceNumber), so 0 can never collide with one.
export const LOCAL_WORKSPACE_NUMBER = 0

function registryPathFor(options) {
  const instancesDir = options.instancesDir ?? 'instances'
  return options.numberRegistryPath ?? join(instancesDir, NUMBER_REGISTRY_FILENAME)
}

function readRegistryFile(registryPath) {
  if (!storage.exists(registryPath)) return { workspaces: {}, instances: {} }
  const text = storage.readText(registryPath)
  if (text.trim() === '') return { workspaces: {}, instances: {} }
  const parsed = JSON.parse(text)
  return { workspaces: parsed.workspaces ?? {}, instances: parsed.instances ?? {} }
}

function writeRegistryFile(registryPath, data) {
  storage.writeText(registryPath, JSON.stringify(data, null, 2) + '\n')
}

function nextNumber(map) {
  const used = Object.values(map)
  return used.length ? Math.max(...used) + 1 : 1
}

/**
 * Assigns (on first call) and returns `workspaceId`'s global workspace number — a real Azure DevOps workspace only; see `LOCAL_WORKSPACE_NUMBER` for the reserved number every local instance's ref uses instead. Idempotent: a workspace already numbered just returns its existing number.
 */
export function getOrAssignWorkspaceNumber(workspaceId, options = {}) {
  const registryPath = registryPathFor(options)
  const data = readRegistryFile(registryPath)
  if (Object.hasOwn(data.workspaces, workspaceId)) return data.workspaces[workspaceId]
  const number = nextNumber(data.workspaces)
  data.workspaces[workspaceId] = number
  writeRegistryFile(registryPath, data)
  return number
}

/** Read-only lookup of `workspaceId`'s number — `undefined` if it's never been assigned one. */
export function resolveWorkspaceNumber(workspaceId, options = {}) {
  return readRegistryFile(registryPathFor(options)).workspaces[workspaceId]
}

/** The reverse of `getOrAssignWorkspaceNumber`/`resolveWorkspaceNumber` — the workspace id a given number resolves to, or `undefined` if unknown. */
export function resolveWorkspaceIdByNumber(number, options = {}) {
  const { workspaces } = readRegistryFile(registryPathFor(options))
  const match = Object.entries(workspaces).find(([, n]) => n === number)
  return match?.[0]
}

/**
 * Assigns (on first call) and returns `slug`'s instance number, scoped within `scopeKey` (a real workspace id, or `LOCAL_SCOPE`). Idempotent, same as `getOrAssignWorkspaceNumber`.
 */
export function getOrAssignInstanceNumber(scopeKey, slug, options = {}) {
  const registryPath = registryPathFor(options)
  const data = readRegistryFile(registryPath)
  const scope = data.instances[scopeKey] ?? {}
  if (Object.hasOwn(scope, slug)) return scope[slug]
  const number = nextNumber(scope)
  scope[slug] = number
  data.instances[scopeKey] = scope
  writeRegistryFile(registryPath, data)
  return number
}

/** Read-only lookup of `slug`'s instance number within `scopeKey` — `undefined` if never assigned. */
export function resolveInstanceNumber(scopeKey, slug, options = {}) {
  return readRegistryFile(registryPathFor(options)).instances[scopeKey]?.[slug]
}

/** The reverse of `getOrAssignInstanceNumber`/`resolveInstanceNumber` — the slug a given number resolves to within `scopeKey`, or `undefined` if unknown. */
export function resolveSlugByNumber(scopeKey, number, options = {}) {
  const scope = readRegistryFile(registryPathFor(options)).instances[scopeKey] ?? {}
  const match = Object.entries(scope).find(([, n]) => n === number)
  return match?.[0]
}

/** The instance-numbering scope a slug's own registry location resolves to: a real workspace id for an Azure-DevOps-backed instance, or the shared `LOCAL_SCOPE` bucket for a local one (or a slug the instance registry has never seen — treated as local, matching `resolveInstanceWorkspaceId`'s own "`null` for local-or-unknown" contract). */
export function scopeKeyForSlug(slug, options = {}) {
  return resolveInstanceWorkspaceId(slug, options) ?? LOCAL_SCOPE
}

/**
 * `slug`'s numeric references, assigning them on first call: `{ workspaceNumber, instanceNumber }`. `workspaceNumber` is `LOCAL_WORKSPACE_NUMBER` for a local instance, or that instance's real workspace's own global number otherwise. This is the one function every route/UI surface that needs to show or link to an instance's numeric ref should call — it assigns lazily (mirroring `lib/instanceRegistry.js`'s own "any instance found with no registry entry gets one on next read" convention), so an instance created before this feature shipped, or through a path that doesn't yet know about numeric refs (e.g. the CLI's `gantry new`), still gets numbered correctly the first time anything asks.
 */
export function instanceNumbersFor(slug, options = {}) {
  const scopeKey = scopeKeyForSlug(slug, options)
  const instanceNumber = getOrAssignInstanceNumber(scopeKey, slug, options)
  const workspaceNumber =
    scopeKey === LOCAL_SCOPE ? LOCAL_WORKSPACE_NUMBER : getOrAssignWorkspaceNumber(scopeKey, options)
  return { workspaceNumber, instanceNumber }
}

/** Canonical text form of an instance's numeric reference: `w<workspaceNumber>i<instanceNumber>`, e.g. `w2i3`. */
export function formatInstanceRef({ workspaceNumber, instanceNumber }) {
  return `w${workspaceNumber}i${instanceNumber}`
}

// `w<N>` (workspace only), `w<N>i<M>` (workspace + instance), or `w<N>i<M>s<K>` (+ stage) — the stage segment is accepted here so a fully-qualified numeric URL can name all three in one token, even though this module never persists a stage number itself (see this file's own doc comment).
const REF_RE = /^w(\d+)(?:i(\d+))?(?:s(\d+))?$/i

/** Parses a numeric reference string into `{ workspaceNumber, instanceNumber, stageNumber }` (the latter two `null` when the ref doesn't specify them) — or `null` if `ref` isn't a numeric reference at all (e.g. a legacy slug), so callers can tell "not a numeric ref" apart from "a numeric ref naming an unknown workspace/instance". */
export function parseInstanceRef(ref) {
  const match = typeof ref === 'string' ? REF_RE.exec(ref.trim()) : null
  if (!match) return null
  return {
    workspaceNumber: Number(match[1]),
    instanceNumber: match[2] !== undefined ? Number(match[2]) : null,
    stageNumber: match[3] !== undefined ? Number(match[3]) : null,
  }
}

/**
 * Resolves a numeric reference (a string per `parseInstanceRef`'s grammar, or an already-parsed `{ workspaceNumber, instanceNumber? }`) to the real slug it names — "default to first" (ADR-0024 decision #1/WI200 acceptance criteria): a workspace-only ref (no instance number) resolves to that workspace's instance number 1. `undefined` if the ref doesn't parse, or names a workspace/instance number nothing has ever been assigned.
 */
export function resolveSlugForRef(ref, options = {}) {
  const parsed = typeof ref === 'string' ? parseInstanceRef(ref) : ref
  if (!parsed) return undefined
  const instanceNumber = parsed.instanceNumber ?? 1

  const scopeKey =
    parsed.workspaceNumber === LOCAL_WORKSPACE_NUMBER
      ? LOCAL_SCOPE
      : resolveWorkspaceIdByNumber(parsed.workspaceNumber, options)
  if (scopeKey) {
    const slug = resolveSlugByNumber(scopeKey, instanceNumber, options)
    if (slug) return slug
  }

  // A miss here can genuinely mean "no such workspace/instance" — but it can just as easily mean
  // "this workspace/instance exists on disk/in a registry, but nothing has ever assigned it a
  // number yet" (a number is only ever assigned lazily, on first read/list — see this file's own
  // doc comment). Rather than make every caller of a fresh, never-yet-listed instance's numeric
  // URL fail with a false "unknown reference", run the one-time backfill once and retry before
  // giving up for real — cheap (idempotent, only fills genuine gaps) and self-healing.
  backfillNumberRegistry(options)
  const backfilledScopeKey =
    parsed.workspaceNumber === LOCAL_WORKSPACE_NUMBER
      ? LOCAL_SCOPE
      : resolveWorkspaceIdByNumber(parsed.workspaceNumber, options)
  if (!backfilledScopeKey) return undefined
  return resolveSlugByNumber(backfilledScopeKey, instanceNumber, options)
}

/** A definition's own stage order determines a stage's number — 1-based position in `definition.stages` (stage 1 = that definition's first stage). `undefined` if `stageId` isn't one of `definition`'s stages. */
export function stageNumberForStageId(definition, stageId) {
  const index = definition.stages.findIndex((s) => s.id === stageId)
  return index === -1 ? undefined : index + 1
}

/** The reverse of `stageNumberForStageId` — the stage id at 1-based position `number` in `definition.stages`, or `undefined` for an out-of-range number ("default to first" — a caller wanting the default stage should pass `1`, not omit this call). */
export function stageIdForNumber(definition, number) {
  return definition.stages[number - 1]?.id
}

// Best-effort creation-order proxy for a local instance during backfill (ADR-0024 decision #6): the instance directory's own filesystem timestamp. Prefers birthtime (true creation time) where the filesystem reports one; falls back to mtime (most filesystems' `birthtime` is unreliable/unset, in which case Node reports it equal to `ctime` — still a far closer proxy than alphabetical-by-slug). A directory that's vanished between listing and stat (a race with something else touching instancesDir) sorts last rather than throwing, so backfill can't fail outright over one such instance.
function localInstanceOrderKey(instancesDir, slug) {
  try {
    const stat = statSync(join(instancesDir, slug))
    return stat.birthtimeMs || stat.mtimeMs
  } catch {
    return Infinity
  }
}

/**
 * One-time (but safe to call more than once — every assignment below is itself idempotent, "only fill in what's missing") backfill for every workspace/instance that predates this feature: assigns each a numeric reference using a best-effort creation-order proxy (ADR-0024 decision #6) rather than alphabetical-by-slug/by-id.
 *
 * Workspaces are numbered in `workspace-registry.json`'s own raw key order (`listWorkspaceIdsInStorageOrder`) — a registry entry carries no timestamp of its own, but a plain JS object (and the JSON `.stringify`/`.parse` round-trip backing this file) preserves non-numeric-string key insertion order, so a workspace registered earlier still appears earlier here; this is the closest available proxy for real creation order.
 *
 * Instances are numbered per scope (see this file's own doc comment): local instances are ordered by their own directory's filesystem timestamp (`localInstanceOrderKey`) — a real, per-entity creation-order signal, unlike the shared registry file every instance's *entry* lives in — while each real workspace's own instances fall back to `instance-registry.json`'s raw key order (`listRegisteredSlugsInStorageOrder`), for the same "no per-entry timestamp available" reason workspaces do.
 *
 * Returns the number of workspaces and instances newly assigned a number by this call (both `0` on a fully-backfilled registry, so a caller — e.g. the `gantry backfill-numeric-refs` CLI command — can report "nothing to do").
 */
export function backfillNumberRegistry(options = {}) {
  const instancesDir = options.instancesDir ?? 'instances'
  const registryPath = registryPathFor(options)
  const data = readRegistryFile(registryPath)

  let workspacesAssigned = 0
  for (const workspaceId of listWorkspaceIdsInStorageOrder({ instancesDir })) {
    if (!Object.hasOwn(data.workspaces, workspaceId)) {
      data.workspaces[workspaceId] = nextNumber(data.workspaces)
      workspacesAssigned++
    }
  }

  const slugs = listRegisteredSlugsInStorageOrder({ instancesDir })
  const localSlugs = []
  const remoteSlugs = []
  for (const slug of slugs) {
    const workspaceId = resolveInstanceWorkspaceId(slug, { instancesDir })
    if (workspaceId) remoteSlugs.push({ slug, workspaceId })
    else localSlugs.push(slug)
  }

  let instancesAssigned = 0
  const orderedLocalSlugs = [...localSlugs].sort(
    (a, b) => localInstanceOrderKey(instancesDir, a) - localInstanceOrderKey(instancesDir, b)
  )
  for (const slug of orderedLocalSlugs) {
    const scope = data.instances[LOCAL_SCOPE] ?? {}
    if (!Object.hasOwn(scope, slug)) {
      scope[slug] = nextNumber(scope)
      data.instances[LOCAL_SCOPE] = scope
      instancesAssigned++
    }
  }

  // Remote slugs keep instance-registry.json's own raw key order (its own best-effort creation-order proxy, same reasoning as the workspace loop above) *within* each workspace scope — the order slugs of different workspaces happen to interleave in that one shared file has no bearing on any one workspace's own instance numbering.
  for (const { slug, workspaceId } of remoteSlugs) {
    const scope = data.instances[workspaceId] ?? {}
    if (!Object.hasOwn(scope, slug)) {
      scope[slug] = nextNumber(scope)
      data.instances[workspaceId] = scope
      instancesAssigned++
    }
  }

  writeRegistryFile(registryPath, data)
  return { workspacesAssigned, instancesAssigned }
}
