import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { listInstances, parseModuleFile } from './instance.js'
import { loadDefinition } from './definition.js'
import { evaluateStage } from './status.js'

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
 * Distinct from `listInstances` (the directory-scan primitive this builds
 * on, which reports `stagesWithData` for every stage rather than a single
 * current-stage status/owner) — this is the shape `GET /api/instances` and
 * `gantry instances` want, not a replacement for the lower-level listing.
 *
 * `status` and `owner` both reflect the instance's *current* stage only —
 * the same stage `gantry status` would report against — not every stage the
 * instance has touched.
 */
export function listRegistry(options = {}) {
  const instancesDir = options.instancesDir ?? 'instances'
  const definitionsDir = options.definitionsDir ?? 'definitions'

  return listInstances({ instancesDir, definitionsDir }).map(({ slug, definition: definitionId, stage: stageId }) => {
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
  })
}
