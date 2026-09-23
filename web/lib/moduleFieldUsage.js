// How many of each module's fields a set of documents draws on — the Definitions page Map's
// per-module "used/total" count and its ghosting of modules a document never touches.
//
// "Used" is exactly the editor's per-artefact scope (`artefactFieldIds`), so the Map and the module
// editor's artefact filter can never disagree about which fields a document shows. A field is
// counted as optional when every document that uses it does so through a `module.field?` ref —
// one bare ref, or a whole-module ref, from any document makes it gating.
import { artefactFieldIds } from './artefactSelection.js'

/**
 * @param {{ id: string, fields?: { id: string }[] }[]} modules
 * @param {{ requires?: string[] }[]} artefacts  the documents in focus (one, or a stage's gate set)
 * @returns {Map<string, { used: number, optional: number, total: number }>} keyed by module id,
 *   one entry per module in `modules` (refs to modules or fields that don't exist are ignored)
 */
export function moduleFieldUsage(modules = [], artefacts = []) {
  const used = new Set()
  const gating = new Set()
  for (const artefact of artefacts) {
    for (const id of artefactFieldIds(modules, artefact)) used.add(id)
    for (const requirement of artefact.requires ?? []) {
      if (requirement.endsWith('?')) continue
      const separator = requirement.indexOf('.')
      if (separator !== -1) {
        gating.add(requirement)
        continue
      }
      const module = modules.find((m) => m.id === requirement)
      for (const field of module?.fields ?? []) gating.add(`${requirement}.${field.id}`)
    }
  }

  const usage = new Map()
  for (const module of modules) {
    // A draft can briefly hold two modules with one id; every other lookup takes the first.
    if (usage.has(module.id)) continue
    const fieldIds = (module.fields ?? []).map((f) => `${module.id}.${f.id}`)
    const inUse = fieldIds.filter((id) => used.has(id))
    usage.set(module.id, {
      used: inUse.length,
      optional: inUse.filter((id) => !gating.has(id)).length,
      total: fieldIds.length,
    })
  }
  return usage
}
