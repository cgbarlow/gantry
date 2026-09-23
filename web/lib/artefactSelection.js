// Artefact selection is persisted per instance and stage because it describes
// the document the author is currently working towards, not a transient view
// preference like the Markdown/Split/Rendered toggle.
const STORAGE_PREFIX = 'gantry:artefact-selection:'

function safeGetItem(key) {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSetItem(key, value) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value)
  } catch {
    // Storage can be unavailable in a sandboxed browser; selection still works
    // for the current visit in that case.
  }
}

export function sortArtefacts(artefacts = []) {
  return [...artefacts].sort((a, b) => a.id.localeCompare(b.id))
}

export function defaultArtefactId(artefacts = []) {
  return sortArtefacts(artefacts)[0]?.id ?? null
}

function storageKey(slug, stageId) {
  return `${STORAGE_PREFIX}${slug}:${stageId}`
}

export function readArtefactSelection(slug, stageId, artefacts = []) {
  const sorted = sortArtefacts(artefacts)
  const stored = safeGetItem(storageKey(slug, stageId))
  return sorted.some((artefact) => artefact.id === stored) ? stored : sorted[0]?.id ?? null
}

export function persistArtefactSelection(slug, stageId, artefactId) {
  safeSetItem(storageKey(slug, stageId), artefactId)
}

// Expands whole-module requirements into the fields currently displayed by
// the API. Field references remain precise, which lets artefacts sharing a
// module show different subsets without teaching the UI about module schemas.
export function artefactFieldIds(modules = [], artefact) {
  const ids = new Set()
  if (!artefact) return ids

  const scopedModuleIds = new Set()

  for (const requirement of artefact.requires ?? []) {
    // A trailing `?` (WI #276) marks a field ref optional for gate-blocking only;
    // for editor scope an optional ref is identical to a bare one, so strip it.
    const ref = requirement.endsWith('?') ? requirement.slice(0, -1) : requirement
    const separator = ref.indexOf('.')
    const moduleId = separator === -1 ? ref : ref.slice(0, separator)
    const fieldId = separator === -1 ? null : ref.slice(separator + 1)
    const module = modules.find((candidate) => candidate.id === moduleId)

    scopedModuleIds.add(moduleId)
    if (fieldId) {
      ids.add(`${moduleId}.${fieldId}`)
    } else if (module) {
      for (const field of module.fields ?? []) ids.add(`${moduleId}.${field.id}`)
    }
  }

  // Author-inserted custom sections (`field.custom`, client-side ids) belong to
  // no artefact's `requires`, but a field-level `requires` list must not make
  // them vanish from the editor. Keep every custom field on a module the
  // artefact already scopes. Whole-module refs already cover these via the loop
  // above; this only matters for field-level refs.
  for (const module of modules) {
    if (!scopedModuleIds.has(module.id)) continue
    for (const field of module.fields ?? []) {
      if (field.custom) ids.add(`${module.id}.${field.id}`)
    }
  }

  return ids
}

export function artefactsHaveDifferentRequirements(modules = [], artefacts = []) {
  if (artefacts.length < 2) return false
  const signatures = artefacts.map((artefact) => [...artefactFieldIds(modules, artefact)].sort().join('\u0000'))
  return new Set(signatures).size > 1
}
