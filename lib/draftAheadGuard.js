import { readInstance } from './instance.js'
import { findStageBranch } from './stageBranch.js'
import { findGitHubStageBranch } from './githubStageBranch.js'
import { approvalIsOpen, heldModules, heldModulesRefusal } from '../web/lib/draftAhead.js'

// #296 (map #238, docs/adr/0063): "shared Modules wait". Gantry enforces the draft-ahead write guard itself; it is not left to the AI's brief.
// While the Instance's current Stage has a Pull Request open, a write to a later Stage may not put content in a Module that a pending Stage
// (from the current one up to the one before it) can also edit, because the Owner's requested changes on the earlier Stage would then
// conflict with the later branch, and Gantry has no sync on GitHub (ADR-0026). Both module-write routes call this before any branch is
// started or file written, on Azure DevOps and GitHub, so MCP's `update_instance_modules` (a client of those routes) is held to it too.

const FINDERS = {
  azureDevOps: findStageBranch,
  github: findGitHubStageBranch,
}

/**
 * The refusal for writing `moduleIds` at `stage`, or `null`. `providerKey` is `azureDevOps` or `github` and `base` its connection (no branch).
 * The cheap, pure question comes first (does the write touch a Module a pending Stage also mounts?); only then is the Provider asked
 * whether the current Stage's Pull Request is open, so an ordinary Save pays nothing.
 */
export async function draftAheadWriteRefusal({ definition, stage, currentStageId, moduleIds, slug, providerKey, base }) {
  const stages = definition.stages
  const held = heldModules(stages, stage.id, currentStageId)
  if (!held.some((h) => moduleIds.includes(h.id))) return null
  const find = FINDERS[providerKey]
  if (!find) return null
  const branch = await find(base, slug, currentStageId)
  if (!branch) return null // the current Stage has no branch, so it has no Pull Request to conflict with
  const record = await readInstance(slug, { [providerKey]: { ...base, branch } })
  if (!approvalIsOpen(record, currentStageId)) return null
  return heldModulesRefusal(stages, stage, currentStageId, moduleIds, (id) => definition.modules.get(id)?.title ?? id)
}
