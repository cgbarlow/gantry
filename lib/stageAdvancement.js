import { loadDefinition } from './definition.js'
import { readInstance, writeInstanceStage, instanceDefinitionVersion } from './instance.js'
import { checkGate, formatGateOutstanding } from './check.js'
import { openDefinition } from './definitionStorage.js'

/**
 * The self-serve "Advance to next stage" action for a *local* instance
 * (ADR-0012's local-instance mode, re-affirmed unchanged by ADR-0014's
 * ticketing-mode pivot; #115): moves `slug`'s `instance.yaml` `stage`
 * pointer to its definition's next stage in sequence, but only once the
 * *current* stage's gate has genuinely passed — re-checked here via
 * `checkGate`, never trusted from an earlier client-side check (the same
 * defense-in-depth `syncGatePassToWorkItem`, lib/workItemLink.js, already
 * applies to its own gate-gated write). Throws — without writing anything —
 * if the gate hasn't passed, or if the instance is already at its
 * definition's final stage (there is no next stage to advance to).
 *
 * Local instances only: takes `options.instancesDir`/`options.definitionsDir`,
 * never `options.azureDevOps`. A Workspace-backed instance never reaches
 * this function at all — it advances only once its stage's own Pull
 * Request is merged (ADR-0014, "PR-based stage approval" — #122-#125's
 * own mechanism; not yet in this repo as of this writing, see #106), a
 * self-serve write like this one playing no part in that flow. Callers
 * (lib/server.js's `POST /api/instance/advance-stage`)
 * must resolve whether a slug is local or Workspace-backed themselves
 * (lib/instanceRegistry.js) and refuse to call this for a Workspace-backed
 * slug — mirroring every other local-only vs. Azure-DevOps-backed split in
 * this codebase.
 */
export function advanceStage(slug, options = {}) {
  if (options.storage) {
    return advanceStageInStorage(slug, options)
  }
  const instancesDir = options.instancesDir ?? 'instances'
  const definitionsDir = options.definitionsDir ?? 'definitions'

  const checkResult = checkGate(slug, { instancesDir, definitionsDir })
  if (!checkResult.pass) {
    throw new Error(
      `Gate "${checkResult.gate}" (stage "${checkResult.stage.id}") has not passed for instance "${slug}" — ` +
        `outstanding: ${formatGateOutstanding(checkResult)}`
    )
  }

  const instance = readInstance(slug, { instancesDir })
  const definition = loadDefinition(instance.definition, { definitionsDir, version: instanceDefinitionVersion(instance) })
  const currentIndex = definition.stages.findIndex((s) => s.id === checkResult.stage.id)
  const nextStage = definition.stages[currentIndex + 1]
  if (!nextStage) {
    throw new Error(
      `Instance "${slug}" is already at its final stage ("${checkResult.stage.title}") — there is no next stage to advance to`
    )
  }

  writeInstanceStage(slug, nextStage.id, { instancesDir })

  return {
    slug,
    fromStage: checkResult.stage,
    toStage: { id: nextStage.id, title: nextStage.title, gate: nextStage.gate },
  }
}

// The store-backed half of advanceStage (#265, ADR-0070, `options.storage`): the same gate re-check and the same refusals as the disk path, with the Instance, its modules and the stage pointer read and written through the store. Returns a Promise.
async function advanceStageInStorage(slug, options) {
  const { storage, instancesDir, workspaceDefinitionsDir } = options
  const definitionsDir = options.definitionsDir ?? 'definitions'

  const checkResult = await checkGate(slug, { storage, instancesDir, workspaceDefinitionsDir, definitionsDir })
  if (!checkResult.pass) {
    throw new Error(
      `Gate "${checkResult.gate}" (stage "${checkResult.stage.id}") has not passed for instance "${slug}" — ` +
        `outstanding: ${formatGateOutstanding(checkResult)}`
    )
  }

  const instance = await readInstance(slug, { storage, instancesDir })
  const { definition, dispose } = await openDefinition(instance.definition, {
    storage,
    workspaceDefinitionsDir,
    definitionsDir,
    version: instanceDefinitionVersion(instance),
  })
  let nextStage
  try {
    const currentIndex = definition.stages.findIndex((s) => s.id === checkResult.stage.id)
    nextStage = definition.stages[currentIndex + 1]
  } finally {
    await dispose()
  }
  if (!nextStage) {
    throw new Error(
      `Instance "${slug}" is already at its final stage ("${checkResult.stage.title}") — there is no next stage to advance to`
    )
  }

  await writeInstanceStage(slug, nextStage.id, { storage, instancesDir })

  return {
    slug,
    fromStage: checkResult.stage,
    toStage: { id: nextStage.id, title: nextStage.title, gate: nextStage.gate },
  }
}
