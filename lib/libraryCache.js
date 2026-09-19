import { join, resolve, sep } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { stringify as stringifyYAML } from 'yaml'
import { listAzureDevOpsDefinitions, loadAzureDevOpsDefinition } from './definitionAzureDevOps.js'
import { listGitHubDefinitions, loadGitHubDefinition } from './definitionGitHub.js'
import { listGitLabDefinitions, loadGitLabDefinition } from './definitionGitLab.js'
import { buildDefinitionYamlObject, buildModuleYamlObject } from './definition.js'
import { localFilesystemStorage as storage } from './storage.js'

/**
 * WI #386 (Feature #380 phase 6, ADR-0036): the on-disk cache of what each configured library repo
 * currently holds. Reusing the Azure-DevOps-repo-reading machinery WI #383 already built
 * (`lib/definitionAzureDevOps.js`, itself built on `lib/azureDevOpsClient.js`) rather than inventing a
 * second way to read a `definitions/` folder over the network. #19 (ADR-0037, ADR-0039) adds the
 * equivalent GitHub-repo-reading machinery (`lib/definitionGitHub.js`/`lib/githubClient.js`) and
 * dispatches `refreshLibraryRepo` to whichever one a given repo's own `provider` names — one mirror
 * directory format regardless of which provider produced it, so every downstream reader
 * (`lib/definition.js` et al.) stays provider-blind.
 *
 * Deliberately **materialized as a real local `definitions/`-shaped directory**
 * (`<instancesDir>/library-cache/<repoId>/definitions/<id>/<version>/definition.yaml` +
 * `modules/*.yaml`, laid out identically to the packaged library and every server workspace's own
 * `definitions/` folder), not a bespoke JSON blob a caller would need its own reader for. This is
 * `lib/definitionHome.js`'s own "a `definitionsDir` string ... don't care what it's a path *into*"
 * reuse principle, one home further: `lib/definition.js`'s entire local-filesystem machinery
 * (`loadDefinition`, `listDefinitions`, `listVersionNumbers`, gate/status evaluation, rendering,
 * instance creation — every existing `:id`-keyed route) works against a library repo's cached
 * content completely unchanged, the moment `lib/definitionHome.js`'s `findDefinitionHomeDefinitionsDir`
 * knows to look here as a third tier after the packaged library and every server workspace. That is
 * also exactly what makes "instances pinned to a library-repo definition keep working from the cache
 * if the repo is unreachable" true with no special-casing anywhere on the read path: those routes
 * were never reading the network in the first place, only this mirror directory.
 *
 * "Cached on disk; re-read at startup, when a repo is added, and on an explicit Refresh button — no
 * polling, no TTL" (WI #386, ADR-0036): this module never fetches anything on its own initiative —
 * every read here is triggered by a caller (`lib/server.js`, at exactly those three moments).
 *
 * A refresh is a wholesale rebuild of that one repo's own mirror directory (delete, then recreate
 * from what was just read) — this directory is 100% derived from the repo's own current content,
 * never hand-edited, so there's no incremental-diff state to preserve, and a definition removed
 * from the repo since the last refresh correctly disappears from the mirror (and so from the
 * server library) too. `refreshLibraryRepo` only replaces the mirror **after** a fully successful
 * read — a network failure partway through (a rejected PAT, a dropped connection, Azure DevOps
 * itself erroring) leaves the previous mirror completely untouched, which is what makes "a repo
 * that's currently unreachable simply keeps whatever it last successfully cached" true: a stale
 * mirror is still a mirror.
 *
 * Only a definition's current **latest published** version is cached (never every draft/version
 * history) — matching WI #386's "viewable, copyable-from, clonable" scope, which only ever needs
 * one snapshot of the content, not the full version history `lib/definitionAzureDevOps.js` itself
 * can read. A definition with no published version at all (draft-only, in someone's own library
 * repo) is skipped — there is nothing a read-only server library caller could do with a draft.
 *
 * Known gap, not fixed here: a library repo definition's artefact templates and reference `.docx`
 * files are not mirrored (`lib/definitionAzureDevOps.js` itself doesn't read those yet — its own doc
 * comment lists this as left for a later phase). A cloned copy of a library-repo definition
 * therefore lands with each artefact's `template` field carried over as text but no actual template
 * file underneath it until the phase that adds Azure-DevOps-workspace template support lands.
 */

const CACHE_DIRNAME = 'library-cache'

// #19 (ADR-0039): "GANTRY_LIBRARY_PAT is a single provider-blind environment variable ... replaced
// by one variable per provider ... with the existing name kept as a deprecated alias for the Azure
// DevOps one." lib/server.js resolves the actual env vars (so a test can override via `options`
// instead); this module only needs their *names*, to report which one a missing credential means.
const LIBRARY_PAT_ENV_VAR_NAME = {
  'azure-devops': 'GANTRY_LIBRARY_PAT_AZURE_DEVOPS',
  github: 'GANTRY_LIBRARY_PAT_GITHUB',
  gitlab: 'GANTRY_LIBRARY_PAT_GITLAB',
}

/** Exported for `lib/definitionPromote.js`'s own per-provider fan-out (#20) — the same "no credential configured for this repo's provider" message, reused rather than duplicated. */
export function missingLibraryPatMessage(provider) {
  const envVar = LIBRARY_PAT_ENV_VAR_NAME[provider] ?? `GANTRY_LIBRARY_PAT_${provider.toUpperCase().replace(/-/g, '_')}`
  const deprecatedAlias = provider === 'azure-devops' ? ', or the deprecated GANTRY_LIBRARY_PAT,' : ''
  return `No server PAT configured for provider "${provider}" (${envVar}${deprecatedAlias}) — cannot read library repos.`
}

/** The root of one repo's cache — everything under it is wholly owned by `refreshLibraryRepo` below. */
export function libraryRepoCacheRoot(instancesDir, repoId) {
  return join(instancesDir, CACHE_DIRNAME, repoId)
}

/** The mirrored `definitions/`-shaped directory a caller passes anywhere an ordinary `definitionsDir` string is expected. */
export function libraryRepoDefinitionsDir(instancesDir, repoId) {
  return join(libraryRepoCacheRoot(instancesDir, repoId), 'definitions')
}

function metaPath(instancesDir, repoId) {
  return join(libraryRepoCacheRoot(instancesDir, repoId), 'meta.json')
}

/** Whether `dir` is itself (or lives under) some repo's mirrored `definitions/` directory — `lib/server.js`'s write routes use this (via the `definitionsDir` a route already resolved) to refuse a direct edit, without needing to know *which* repo. */
export function isLibraryRepoDefinitionsDir(dir, instancesDir) {
  const root = resolve(join(instancesDir, CACHE_DIRNAME)) + sep
  return resolve(dir + sep).startsWith(root)
}

/** `{ fetchedAt, ids }` from a repo's last successful refresh, or `null` if it has never been successfully read. */
export function readLibraryRepoCacheMeta(repoId, { instancesDir = 'instances' } = {}) {
  const path = metaPath(instancesDir, repoId)
  if (!storage.exists(path)) return null
  return JSON.parse(storage.readText(path))
}

/**
 * Reads `repo`'s `definitions/` folder over the network (the server's own PAT, never a per-browser
 * one — see lib/librarySettings.js's doc comment) and, on success, wholesale-replaces its mirrored
 * `definitions/` directory. Throws on failure (a network error, a rejected PAT, the repo not
 * existing) — the mirror, if any, is left exactly as it was; callers that want "never let one
 * repo's failure stop the others" (`refreshAllLibraryRepos` below) catch this themselves rather
 * than this function swallowing it, so a caller that refreshes a single just-added repo
 * (`POST /api/library-repos`) can still report that failure back to whoever just added it.
 */
async function readAzureDevOpsDefinitions(repo, pat) {
  const options = { azureDevOps: { ...repo.location, pat } }
  const rows = await listAzureDevOpsDefinitions(options)
  const defs = []
  for (const row of rows) {
    if (!row.latestPublished) continue // draft-only in this repo — nothing a read-only caller can use yet.
    defs.push(await loadAzureDevOpsDefinition(row.id, row.latestPublished, options))
  }
  return defs
}

// #19: the GitHub counterpart of readAzureDevOpsDefinitions above — same "only a definition's
// current latest published version is cached" contract, over lib/definitionGitHub.js instead.
async function readGitHubDefinitions(repo, pat) {
  const { owner, repository, baseUrl } = repo.location
  const options = { github: { owner, repository, baseUrl, pat } }
  const rows = await listGitHubDefinitions(options)
  const defs = []
  for (const row of rows) {
    if (!row.latestPublished) continue // draft-only in this repo — nothing a read-only caller can use yet.
    defs.push(await loadGitHubDefinition(row.id, row.latestPublished, options))
  }
  return defs
}

// #27: the GitLab counterpart of readGitHubDefinitions above — same "only a definition's current
// latest published version is cached" contract, over lib/definitionGitLab.js instead.
async function readGitLabDefinitions(repo, pat) {
  const { namespace, repository, baseUrl } = repo.location
  const options = { gitlab: { namespace, repository, baseUrl, pat } }
  const rows = await listGitLabDefinitions(options)
  const defs = []
  for (const row of rows) {
    if (!row.latestPublished) continue // draft-only in this repo — nothing a read-only caller can use yet.
    defs.push(await loadGitLabDefinition(row.id, row.latestPublished, options))
  }
  return defs
}

// #27 (ADR-0041), following #24's own "N-way dispatch, not a binary branch" convention
// (lib/registry.js's ROW_BUILDERS is the direct precedent): keyed by provider, so a fourth provider
// plugs in with one more entry here rather than another arm of a growing if/else. A provider with no
// entry (e.g. a declared-but-not-yet-registered one) is refused with a clear message below, never
// silently misrouted into Azure DevOps's own reader.
const readDefinitionsByProvider = {
  'azure-devops': readAzureDevOpsDefinitions,
  github: readGitHubDefinitions,
  gitlab: readGitLabDefinitions,
}

export async function refreshLibraryRepo(repo, { instancesDir = 'instances', pat } = {}) {
  const readDefinitions = readDefinitionsByProvider[repo.provider]
  if (!readDefinitions) {
    throw new Error(`Reading a library repo on provider "${repo.provider}" is not supported yet.`)
  }
  const defs = await readDefinitions(repo, pat)

  // Only reached once every definition above has been fully, successfully read — a failure partway
  // through this loop throws out of this function before the mirror below is ever touched, per this
  // module's own doc comment.
  const definitionsDir = libraryRepoDefinitionsDir(instancesDir, repo.id)
  rmSync(definitionsDir, { recursive: true, force: true })
  for (const def of defs) {
    const versionDir = join(definitionsDir, def.id, String(def.version))
    mkdirSync(join(versionDir, 'modules'), { recursive: true })
    const structure = { title: def.title, description: def.description, stages: def.stages, artefacts: def.artefacts }
    const defObj = buildDefinitionYamlObject(def.id, def.version, def.status, structure, {})
    writeFileSync(join(versionDir, 'definition.yaml'), stringifyYAML(defObj))
    for (const mod of def.modules.values()) {
      writeFileSync(join(versionDir, 'modules', `${mod.id}.yaml`), stringifyYAML(buildModuleYamlObject(mod)))
    }
  }

  const meta = { repoId: repo.id, fetchedAt: new Date().toISOString(), ids: defs.map((d) => d.id) }
  mkdirSync(libraryRepoCacheRoot(instancesDir, repo.id), { recursive: true })
  writeFileSync(metaPath(instancesDir, repo.id), JSON.stringify(meta, null, 2) + '\n')
  return meta
}

/**
 * Refreshes every repo in `repos`, independently — one repo's failure (unreachable, rejected PAT,
 * doesn't exist) never stops the others from refreshing, mirroring `lib/registry.js`'s
 * `buildAzureDevOpsRow`'s own "a remote system this server doesn't control is a less predictable
 * failure domain than local disk" reasoning. Returns one result per repo, in the same order as
 * `repos`: `{ repoId, ok: true, definitionCount }` on success, `{ repoId, ok: false, error }` on
 * failure — the shape `POST /api/library-repos/refresh`'s response, and the "when a repo is added"
 * single-repo refresh, both report back to their caller.
 *
 * `pats` (#19, ADR-0039) is per-provider: `{ 'azure-devops': <pat|null>, github: <pat|null> }` — a
 * repo whose own provider has no configured credential is reported as a failure with a distinct,
 * actionable message naming *which* provider and *which* environment variable, rather than
 * attempting — and failing — a network call with no credential; each repo's existing mirror (if any)
 * is left untouched either way, so "no server PAT configured yet" degrades exactly like "server PAT
 * configured but every repo unreachable" from every other caller's point of view.
 */
export async function refreshAllLibraryRepos(repos, { instancesDir = 'instances', pats = {} } = {}) {
  const results = []
  for (const repo of repos) {
    const pat = pats[repo.provider]
    if (!pat) {
      results.push({ repoId: repo.id, ok: false, error: missingLibraryPatMessage(repo.provider) })
      continue
    }
    try {
      const meta = await refreshLibraryRepo(repo, { instancesDir, pat })
      results.push({ repoId: repo.id, ok: true, definitionCount: meta.ids.length })
    } catch (err) {
      results.push({ repoId: repo.id, ok: false, error: err.message })
    }
  }
  return results
}
