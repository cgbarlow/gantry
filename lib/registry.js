import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readInstance, readModule, parseModuleFile } from './instance.js'
import { loadDefinition } from './definition.js'
import { evaluateStage } from './status.js'
import { listRegisteredInstances } from './instanceRegistry.js'

// The current stage's modules are usually filled in by the same person/team
// — this returns the first non-empty `owner` found among them, in
// stage-definition order, rather than a per-module breakdown. '' if none of
// them have an owner set yet (or none exist on disk).
function stageOwner(definition, stage, slug, instancesDir) {
  for (const moduleId of stage.modules) {
    const path = join(instancesDir, slug, 'modules', `${moduleId}.md`)
    if (!existsSync(path)) continue
    const moduleSpec = definition.modules.get(moduleId)
    const { owner } = parseModuleFile(readFileSync(path, 'utf8'), moduleSpec)
    if (owner) return owner
  }
  return ''
}

// The Azure-DevOps-backed half of stageOwner (#93) — the same "first
// non-empty owner across the stage's modules" rule, reusing readModule's
// Azure DevOps branch instead of a raw file read. A module with no saved
// data yet (readModule's own "no saved data" miss) contributes no owner,
// the same way the local path's existsSync guard skips it, rather than
// failing the whole lookup.
async function azureDevOpsStageOwner(definition, stage, slug, azureDevOps) {
  for (const moduleId of stage.modules) {
    let owner
    try {
      ;({ owner } = await readModule(definition, slug, moduleId, { azureDevOps }))
    } catch (err) {
      if (/has no saved data/.test(err.message)) continue
      throw err
    }
    if (owner) return owner
  }
  return ''
}

// One local instance's registry row, or `null` if its registered slug has
// no instance.yaml on disk anymore (a stale entry — see listRegistry's own
// comment on why that's skipped rather than failing the whole listing).
// Factored out of listRegistry so both its sync (local-only) and async
// (mixed local/Azure-DevOps) branches build local rows identically.
function buildLocalRow(slug, instancesDir, definitionsDir) {
  let instance
  try {
    instance = readInstance(slug, { instancesDir })
  } catch (err) {
    if (/^No instance /.test(err.message)) return null
    throw err
  }
  const definitionId = instance.definition
  const stageId = instance.stage
  const definition = loadDefinition(definitionId, { definitionsDir })
  const stage = definition.stages.find((s) => s.id === stageId)
  if (!stage) {
    throw new Error(`Instance "${slug}" has no stage "${stageId}"`)
  }
  const { complete } = evaluateStage(definition, stage, slug, { instancesDir })
  return {
    slug,
    definition: definitionId,
    stage: stageId,
    status: complete ? 'complete' : 'incomplete',
    owner: stageOwner(definition, stage, slug, instancesDir),
  }
}

// The Azure-DevOps-backed half of buildLocalRow (#93) — the exact same row
// shape, read from `location`'s Azure DevOps repo instead of instancesDir.
// `pat` is the caller's own Azure DevOps credential (lib/credential.js's
// `getCredential(req)`); with none supplied, this entry is skipped without
// even attempting a network call.
//
// Unlike buildLocalRow (which still throws on a genuine *local* read
// failure — a deliberate, tested choice, since that's the same trust/
// failure domain as the server itself), *any* failure reading an Azure-
// DevOps-backed entry — a rejected/expired PAT, a network error, an Azure
// DevOps outage, a malformed instance.yaml pointing at an unknown stage,
// etc. — is caught here and simply leaves that one entry out of the
// unified list (returns `null`), rather than failing the whole listing
// for every other — possibly unrelated, possibly purely local — instance
// in it. A remote system this server doesn't control is a fundamentally
// less predictable failure domain than its own local disk; letting one
// unreachable Azure DevOps org take down visibility of every local
// instance too (verified: a single unreachable registered entry used to
// turn the whole `GET /api/instances` into a 500) is a worse outcome than
// that one entry's row simply being temporarily absent.
//
// This still must not go completely silent, though: this codebase has no
// other server-side logging at all, so without the `console.error` below,
// a genuine, persistent problem (a rejected PAT, a malformed remote
// instance.yaml, a bug in this very function) would be indistinguishable
// from "temporarily unreachable" with zero trace anywhere an operator or
// developer could notice it — this is the one diagnostic breadcrumb for
// exactly that case.
async function buildAzureDevOpsRow(slug, location, definitionsDir, pat) {
  if (!pat) return null
  const azureDevOps = { ...location, pat }
  try {
    const instance = await readInstance(slug, { azureDevOps })
    const definitionId = instance.definition
    const stageId = instance.stage
    const definition = loadDefinition(definitionId, { definitionsDir })
    const stage = definition.stages.find((s) => s.id === stageId)
    if (!stage) {
      throw new Error(`Instance "${slug}" has no stage "${stageId}"`)
    }
    const { complete } = await evaluateStage(definition, stage, slug, { azureDevOps })
    return {
      slug,
      definition: definitionId,
      stage: stageId,
      status: complete ? 'complete' : 'incomplete',
      owner: await azureDevOpsStageOwner(definition, stage, slug, azureDevOps),
    }
  } catch (err) {
    console.error(`lib/registry.js: omitting Azure-DevOps-backed instance "${slug}" from GET /api/instances — ${err.message}`)
    return null
  }
}

/**
 * The registry: every instance gantry knows about, enriched with what a
 * listing screen needs to render a row without fetching each instance
 * individually — name (`slug`), `definition`, current `stage`, an overall
 * `status` ('complete'/'incomplete') for that stage, and an `owner`.
 *
 * "Every instance gantry knows about" means every slug the instance
 * registry (lib/instanceRegistry.js, #89) knows about — that module's
 * auto-backfill means this is still every local instance on disk (the
 * examples/demo-cli/demo-web fixtures, anything made via `gantry new`, any
 * test's temp instance), with zero migration step and zero change in
 * output shape or order from before #89 for local-only registries.
 *
 * Azure-DevOps-backed entries (registered by `POST /api/instances`, #93)
 * are included in the same unified list, read from their own repo instead
 * of `instancesDir` (see buildAzureDevOpsRow) — this is what makes a newly
 * Azure-DevOps-backed instance "appear in the dashboard listing" once
 * created. Because reading one of those requires a real network call, this
 * function returns a plain array synchronously exactly as before *only*
 * when nothing registered is Azure-DevOps-backed (every existing caller's
 * case); the moment at least one such entry is registered, this returns a
 * Promise instead — the same "sync unless Azure DevOps is involved"
 * contract every other dual-backend function in this codebase
 * (readInstance/readModule/writeModule/evaluateStage/getStatus) already
 * has, just decided here by what's *registered* rather than by an option
 * the caller passed for a single instance. `options.pat` is the caller's
 * own Azure DevOps credential (lib/credential.js's `getCredential(req)`),
 * forwarded to each Azure-DevOps-backed entry's read.
 *
 * Distinct from `listInstances` (the directory-scan primitive, which
 * reports `stagesWithData` for every stage rather than a single
 * current-stage status/owner) — this is the shape `GET /api/instances`
 * wants, not a replacement for that lower-level listing.
 *
 * `status` and `owner` both reflect the instance's *current* stage only —
 * the same stage `gantry status` would report against — not every stage the
 * instance has touched.
 */
export function listRegistry(options = {}) {
  const instancesDir = options.instancesDir ?? 'instances'
  const definitionsDir = options.definitionsDir ?? 'definitions'

  // Already sorted by slug — listRegisteredInstances's own contract — so
  // no further sorting is needed on either branch below.
  const registered = listRegisteredInstances({ instancesDir, registryPath: options.registryPath })

  if (!registered.some((entry) => entry.location.kind === 'azureDevOps')) {
    return registered
      .map((entry) => buildLocalRow(entry.slug, instancesDir, definitionsDir))
      .filter((row) => row !== null)
  }

  return (async () => {
    const rows = []
    for (const entry of registered) {
      const row =
        entry.location.kind === 'local'
          ? buildLocalRow(entry.slug, instancesDir, definitionsDir)
          : await buildAzureDevOpsRow(entry.slug, entry.location, definitionsDir, options.pat)
      if (row !== null) rows.push(row)
    }
    return rows
  })()
}
