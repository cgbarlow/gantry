import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readInstance, parseModuleFile } from './instance.js'
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

/**
 * The registry: every instance gantry knows about, enriched with what a
 * listing screen needs to render a row without fetching each instance
 * individually — name (`slug`), `definition`, current `stage`, an overall
 * `status` ('complete'/'incomplete') for that stage, and an `owner`.
 *
 * "Every instance gantry knows about" now means every slug the instance
 * registry (lib/instanceRegistry.js, #89) knows about — that module's
 * auto-backfill means this is still every local instance on disk (the
 * examples/demo-cli/demo-web fixtures, anything made via `gantry new`, any
 * test's temp instance), with zero migration step and zero change in
 * output shape or order from before #89. Azure-DevOps-backed entries
 * aren't produced by anything yet (that's later tickets), so they're
 * filtered out here rather than left to fail against `instancesDir` reads
 * that assume a local layout.
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

  const localSlugs = listRegisteredInstances({ instancesDir, registryPath: options.registryPath })
    .filter((entry) => entry.location.kind === 'local')
    .map((entry) => entry.slug)

  // localSlugs is already sorted by slug — listRegisteredInstances's own
  // contract — so no further sorting is needed here.
  const rows = []
  for (const slug of localSlugs) {
    let instance
    try {
      instance = readInstance(slug, { instancesDir })
    } catch (err) {
      // A registry entry whose instance.yaml no longer exists on disk (the
      // directory was deleted/renamed after being registered or
      // auto-backfilled — the registry, unlike the old directory-scan-only
      // listing this replaces, doesn't self-heal by forgetting entries on
      // its own) must not take down the *entire* listing for one stale
      // slug. Skipping it here restores the old listInstances-based
      // behavior, where a removed instance simply never appeared, rather
      // than every other — perfectly healthy — instance's row failing to
      // load too. Only readInstance's own "missing" error is swallowed;
      // anything else (a genuine read failure, malformed YAML, etc.) still
      // propagates, since that's a real problem worth surfacing.
      if (/^No instance /.test(err.message)) continue
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
    rows.push({
      slug,
      definition: definitionId,
      stage: stageId,
      status: complete ? 'complete' : 'incomplete',
      owner: stageOwner(definition, stage, slug, instancesDir),
    })
  }
  return rows
}
