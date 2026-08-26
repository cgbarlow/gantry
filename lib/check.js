import { loadDefinition } from './definition.js'
import { readInstance } from './instance.js'
import { evaluateStage } from './status.js'

// Resolves which stage a gate check runs against: `options.gate` (any stage whose `gate` matches, not just the instance's current one), falling back to the instance's own current stage. Shared by the local and Azure-DevOps-backed halves of `checkGate` below so the two can never drift in how they pick a stage, only in how the instance/modules were read. Exported so lib/server.js's `GET /api/instance/check` route (#122) can resolve the exact same stage — before this call's own `checkGate` runs — to find or create that stage's branch (lib/stageBranch.js), without either duplicating this resolution logic or guessing at a stage that might not match what `checkGate` itself picks.
export function resolveCheckStage(definition, instance, slug, options) {
  if (options.gate) {
    const stage = definition.stages.find((s) => s.gate === options.gate)
    if (!stage) {
      throw new Error(`Definition "${definition.id}" has no stage with gate "${options.gate}"`)
    }
    return stage
  }
  const stage = definition.stages.find((s) => s.id === instance.stage)
  if (!stage) {
    throw new Error(`Instance "${slug}" is at unknown stage "${instance.stage}"`)
  }
  return stage
}

function checkResultFor(slug, definition, stage, modules, artefacts, complete) {
  return {
    slug,
    definition: definition.id,
    stage: { id: stage.id, title: stage.title, gate: stage.gate },
    modules,
    artefacts,
    complete,
    pass: complete,
    gate: stage.gate,
  }
}

// Reports the closest incomplete artefact so callers do not present the
// stage's union of modules as if every artefact had to be complete.
export function formatGateOutstanding(checkResult) {
  const incomplete = (checkResult.artefacts ?? []).filter((artefact) => !artefact.complete)
  if (incomplete.length) {
    const closest = incomplete.reduce((best, artefact) =>
      artefact.outstanding.length < best.outstanding.length ? artefact : best
    )
    return `${closest.title}: ${closest.outstanding.join(', ') || 'see required modules'}`
  }

  const outstanding = (checkResult.modules ?? []).filter((module) => !module.complete).map((module) => module.title)
  return outstanding.join(', ') || 'see modules'
}

/**
 * `gantry check <slug> [--gate <id>]`: validates a gate's required modules/fields and reports PASS/FAIL. Defaults to the instance's current stage; `--gate` resolves any stage whose `gate` matches, even if it isn't the instance's current one. Unlike `status`, parses module files in strict mode — a parser anomaly (non-matching or duplicate heading) throws rather than warns, so the gate can't pass on data the parser wasn't confident about.
 *
 * With `options.azureDevOps` supplied, reads the instance/modules from that Azure DevOps repo instead of the local filesystem (see checkGateFromAzureDevOps below) and returns a Promise the caller must `await`. Without it — every existing caller — this stays exactly the synchronous local-filesystem check it always was. Added for #103's confirmed gate-pass-to-work-item sync, which must be able to check an Azure-DevOps-backed instance's gate the same way it checks a local one — a gap this ticket also closes in `GET /api/instance/check` (lib/server.js), which previously only ever checked local instances.
 */
export function checkGate(slug, options = {}) {
  if (options.azureDevOps) {
    return checkGateFromAzureDevOps(slug, options)
  }

  const instancesDir = options.instancesDir ?? 'instances'
  const definitionsDir = options.definitionsDir ?? 'definitions'

  const instance = readInstance(slug, { instancesDir })
  const definition = loadDefinition(instance.definition, { definitionsDir })
  const stage = resolveCheckStage(definition, instance, slug, options)

  const { modules, artefacts, complete } = evaluateStage(definition, stage, slug, { instancesDir, strict: true })

  return checkResultFor(slug, definition, stage, modules, artefacts, complete)
}

// The Azure-DevOps-backed half of checkGate (#103) — the exact same stage-resolution/strict-evaluation logic as the local path, over an instance/its modules read from Azure DevOps instead of disk.
async function checkGateFromAzureDevOps(slug, options) {
  const definitionsDir = options.definitionsDir ?? 'definitions'

  const instance = await readInstance(slug, { azureDevOps: options.azureDevOps })
  const definition = loadDefinition(instance.definition, { definitionsDir })
  const stage = resolveCheckStage(definition, instance, slug, options)

  const { modules, artefacts, complete } = await evaluateStage(definition, stage, slug, {
    azureDevOps: options.azureDevOps,
    strict: true,
  })

  return checkResultFor(slug, definition, stage, modules, artefacts, complete)
}
