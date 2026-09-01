// Browser-side re-implementation of the two pure text-rendering helpers
// `lib/instance.js` uses when `createInstance` lays down a brand-new
// instance's files: the canonical `instance.yaml` serializer and the blank
// `modules/<id>.md` template. A **local workspace** (ADR-0029) writes those
// same files straight through a `FileSystemDirectoryHandle` from the wizard
// (WI #295) rather than server-side, so it needs byte-identical output
// without importing `lib/instance.js` (which is server-only — it pulls in
// `node:fs`, the Azure DevOps client, etc.).
//
// Kept deliberately small and in lock-step with `lib/instance.js`:
//   - `renderInstanceYaml` mirrors `stringifyInstanceYAML` — canonical
//     (recursively key-sorted) YAML, so two writers touching disjoint fields
//     produce mergeable bytes (see `lib/instance.js`'s own long comment).
//   - `renderModuleFile` mirrors `renderModuleFile` verbatim: `---`-fenced
//     `module` / `status` / `owner` frontmatter, the module title at `#`,
//     one empty `## <field title>` section per field.
import { stringify as stringifyYAML } from 'yaml'

// Recursively sort every plain object's keys — the exact shape of
// `lib/instance.js`'s `canonicalizeForSerialization`.
function canonicalizeForSerialization(value) {
  if (Array.isArray(value)) return value.map(canonicalizeForSerialization)
  if (value !== null && typeof value === 'object') {
    const sorted = {}
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalizeForSerialization(value[key])
    }
    return sorted
  }
  return value
}

/**
 * The text to write at `gantry-workspace/<slug>/instance.yaml` for a new
 * local-workspace instance — the same fields `createInstance` records
 * (`definition`, `slug`, `stage` = first stage id, `assignee`,
 * `definitionVersion`), serialized canonically.
 */
export function renderInstanceYaml({ definition, slug, stage, assignee, definitionVersion }) {
  return stringifyYAML(
    canonicalizeForSerialization({
      definition,
      slug,
      stage,
      assignee: assignee ?? '',
      definitionVersion,
    })
  )
}

/**
 * A blank module file for `moduleSpec` (`{ id, title, fields: [{ title }] }`)
 * — verbatim port of `lib/instance.js`'s `renderModuleFile`.
 */
export function renderModuleFile(moduleSpec, { status = 'draft', owner = '' } = {}) {
  const frontmatter = stringifyYAML({ module: moduleSpec.id, status, owner }).trimEnd()
  const sections = moduleSpec.fields.map((field) => `## ${field.title}\n\n`).join('\n')
  return `---\n${frontmatter}\n---\n\n# ${moduleSpec.title}\n\n${sections}`
}
