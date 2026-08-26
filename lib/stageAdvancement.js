import { loadDefinition } from './definition.js'
import { readInstance, writeInstanceStage } from './instance.js'
import { checkGate, formatGateOutstanding } from './check.js'

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
  const definition = loadDefinition(instance.definition, { definitionsDir })
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
