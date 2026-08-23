import { join } from 'node:path'
import { localFilesystemStorage as storage } from './storage.js'
import { listInstanceSlugs } from './instance.js'

/**
 * The instance *registry* — not to be confused with `lib/registry.js`'s
 * `listRegistry` (the dashboard-facing "every instance enriched with
 * definition/stage/status/assignee" listing). This module answers a narrower,
 * lower-level question: "where does this slug's data live" — locally on
 * disk, or in a specific Azure DevOps organization/project/repository —
 * not anything about that instance's content. `listRegistry` is a
 * *consumer* of this module, not a synonym for it.
 *
 * Per docs describing #88/#89: this registry is the *sole* source of truth
 * gantry consults to route a request for a given slug. A local instance's
 * own `instance.yaml` never needs to say so (there is nothing to write —
 * absence from an `azureDevOps` entry just means local); an Azure-DevOps-
 * backed instance's `instance.yaml` does carry its own descriptive
 * `azureDevOps` field (written by `createInstance`, #85), but that field is
 * purely descriptive and is never read back by this module — there is no
 * reconciliation between the two.
 *
 * The registry file lives inside `instancesDir` (one level down from what
 * `docs/adr/0008` describes as "sibling to instancesDir/definitionsDir" —
 * colocating it with the directory it indexes instead keeps every test's
 * already-unique scratch `instancesDir` naturally isolated, with no risk of
 * two unrelated test runs sharing one registry file the way a location
 * derived from instancesDir's *parent* directory would for `os.tmpdir()`-
 * based scratch dirs). It is application state, not source data — never
 * committed to git (see .gitignore).
 */

const REGISTRY_FILENAME = 'instance-registry.json'

function registryPathFor(options) {
  const instancesDir = options.instancesDir ?? 'instances'
  return options.registryPath ?? join(instancesDir, REGISTRY_FILENAME)
}

// Reads the raw slug -> location map off disk, tolerating a registry file
// that doesn't exist yet (a brand new instancesDir, or the very first call
// against this repo) — that's not an error, just an empty registry.
function readRegistryFile(registryPath) {
  if (!storage.exists(registryPath)) return {}
  const text = storage.readText(registryPath)
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

function writeRegistryFile(registryPath, entries) {
  storage.writeText(registryPath, JSON.stringify(entries, null, 2) + '\n')
}

function assertValidLocation(location) {
  if (!location || typeof location !== 'object') {
    throw new Error('A registry location must be an object')
  }
  if (location.kind === 'local') {
    return
  }
  if (location.kind === 'azureDevOps') {
    const missing = ['organization', 'project', 'repository'].filter((key) => !location[key])
    if (missing.length) {
      throw new Error(`An "azureDevOps" registry location is missing: ${missing.join(', ')}`)
    }
    return
  }
  throw new Error(`Unknown registry location kind "${location?.kind}" — expected "local" or "azureDevOps"`)
}

// Any instance.yaml found on disk via directory-scan with no existing
// registry entry gets one auto-added here — so every pre-existing local
// instance (the examples/demo-cli/demo-web fixtures, anything made via
// `gantry new`, any test's temp instance) keeps working with zero migration
// step, exactly as #89's spec requires. Runs on every read (resolve/list),
// not just once, since a local instance can be created by any of several
// code paths (`createInstance`, a test writing instance.yaml directly,
// etc.) that don't necessarily go through `registerInstance` themselves.
function loadWithBackfill(options) {
  const instancesDir = options.instancesDir ?? 'instances'
  const registryPath = registryPathFor(options)
  const entries = readRegistryFile(registryPath)

  let changed = false
  for (const slug of listInstanceSlugs(instancesDir)) {
    if (!(slug in entries)) {
      entries[slug] = { kind: 'local' }
      changed = true
    }
  }

  if (changed) {
    writeRegistryFile(registryPath, entries)
  }

  return { entries, registryPath }
}

/**
 * Resolves a slug's location: `{ kind: 'local' }` or `{ kind: 'azureDevOps',
 * organization, project, repository, baseUrl? }`. `undefined` if the slug
 * is neither already registered nor found on disk (an unknown instance).
 */
export function resolveInstanceLocation(slug, options = {}) {
  const { entries } = loadWithBackfill(options)
  return entries[slug]
}

/**
 * Registers (or overwrites) `slug`'s location. `location` must be `{ kind:
 * 'local' }` or `{ kind: 'azureDevOps', organization, project, repository,
 * baseUrl? }` — anything else throws rather than silently persisting a
 * location no other part of the registry knows how to interpret.
 */
export function registerInstance(slug, location, options = {}) {
  assertValidLocation(location)
  // Runs the same backfill a plain resolve/list would — registering one new
  // instance shouldn't skip auto-backfilling every other instance already
  // sitting on disk with no entry of its own yet.
  const { entries, registryPath } = loadWithBackfill(options)
  entries[slug] = location
  writeRegistryFile(registryPath, entries)
}

/**
 * Every known entry, sorted by slug: `[{ slug, location }, ...]`. Includes
 * both registered-directly entries and anything auto-backfilled from disk.
 */
export function listRegisteredInstances(options = {}) {
  const { entries } = loadWithBackfill(options)
  return Object.keys(entries)
    .sort()
    .map((slug) => ({ slug, location: entries[slug] }))
}
