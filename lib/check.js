import { loadDefinition } from './definition.js'
import { readInstance } from './instance.js'
import { evaluateStage } from './status.js'

/**
 * `gantry check <slug> [--gate <id>]`: validates a gate's required
 * modules/fields and reports PASS/FAIL. Defaults to the instance's current
 * stage; `--gate` resolves any stage whose `gate` matches, even if it isn't
 * the instance's current one. Unlike `status`, parses module files in
 * strict mode — a parser anomaly (non-matching or duplicate heading) throws
 * rather than warns, so the gate can't pass on data the parser wasn't
 * confident about.
 */
export function checkGate(slug, options = {}) {
  const instancesDir = options.instancesDir ?? 'instances'
  const definitionsDir = options.definitionsDir ?? 'definitions'

  const instance = readInstance(slug, { instancesDir })
  const definition = loadDefinition(instance.definition, { definitionsDir })

  let stage
  if (options.gate) {
    stage = definition.stages.find((s) => s.gate === options.gate)
    if (!stage) {
      throw new Error(`Definition "${definition.id}" has no stage with gate "${options.gate}"`)
    }
  } else {
    stage = definition.stages.find((s) => s.id === instance.stage)
    if (!stage) {
      throw new Error(`Instance "${slug}" is at unknown stage "${instance.stage}"`)
    }
  }

  const { modules, complete } = evaluateStage(definition, stage, slug, { instancesDir, strict: true })

  return {
    slug,
    definition: definition.id,
    stage: { id: stage.id, title: stage.title, gate: stage.gate },
    modules,
    complete,
    pass: complete,
    gate: stage.gate,
  }
}
