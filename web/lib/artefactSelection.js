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

  for (const requirement of artefact.requires ?? []) {
    const separator = requirement.indexOf('.')
    const moduleId = separator === -1 ? requirement : requirement.slice(0, separator)
    const fieldId = separator === -1 ? null : requirement.slice(separator + 1)
    const module = modules.find((candidate) => candidate.id === moduleId)

    if (fieldId) {
      ids.add(`${moduleId}.${fieldId}`)
    } else if (module) {
      for (const field of module.fields) ids.add(`${moduleId}.${field.id}`)
    }
  }

  return ids
}

export function artefactsHaveDifferentRequirements(modules = [], artefacts = []) {
  if (artefacts.length < 2) return false
  const signatures = artefacts.map((artefact) => [...artefactFieldIds(modules, artefact)].sort().join('\u0000'))
  return new Set(signatures).size > 1
}
