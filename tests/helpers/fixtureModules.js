import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadDefinition } from '../../lib/definition.js'

// The bundled Kiwi Cover Mutual fixture (WI #348, moved to `workspaces/examples/kiwi-cover-mutual`
// by WI #358) carries diagrams as `![…](asset:<id>)` references backed by that instance's own
// `assets/manifest.yaml`. Tests that borrow a fixture module's text to seed some *other* instance (a
// fake Azure DevOps repo, a local-workspace payload, a scratch instance) have no such manifest, and a
// render would fail resolving the reference. This returns the module text with the image references
// and their citation lines removed — the prose, headings, tables and lists are untouched, so gate
// checks and renders see the same content shape without a dangling asset lookup.
//
// The example is on design v3 (#193), but most of those instances are on v2, the latest published
// version. An instance file finds each Field by its title, so a Field v3 retitled with its id kept
// (#233's "Operational accounts and licences") gets back the title of the `definitionVersion` seeded.
export function exampleModuleText(moduleId, { definitionVersion = 2 } = {}) {
  const text = readFileSync(join('workspaces', 'examples', 'kiwi-cover-mutual', 'modules', `${moduleId}.md`), 'utf8')
  const retitled = retitledHeadings(moduleId, definitionVersion)
  return text
    .split('\n')
    .filter((line) => !/^!\[[^\]]*\]\(asset:[\w-]+\)\s*$/.test(line))
    .map((line) => retitled.get(line) ?? line)
    .join('\n')
}

// `## <v3 title>` → `## <title in definitionVersion>`, for each Field of the module both versions have.
function retitledHeadings(moduleId, definitionVersion) {
  const headings = new Map()
  if (definitionVersion === 3) return headings
  const example = loadDefinition('design', { version: 3 }).modules.get(moduleId)
  const seeded = loadDefinition('design', { version: definitionVersion }).modules.get(moduleId)
  if (!example || !seeded) return headings
  for (const field of example.fields) {
    const title = seeded.fields.find((f) => f.id === field.id)?.title
    if (title && title !== field.title) headings.set(`## ${field.title}`, `## ${title}`)
  }
  return headings
}
