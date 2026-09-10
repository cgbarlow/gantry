import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The bundled Kiwi Cover Mutual fixture (WI #348, moved to `workspaces/examples/kiwi-cover-mutual`
// by WI #358) carries diagrams as `![…](asset:<id>)` references backed by that instance's own
// `assets/manifest.yaml`. Tests that borrow a fixture module's text to seed some *other* instance (a
// fake Azure DevOps repo, a local-workspace payload, a scratch instance) have no such manifest, and a
// render would fail resolving the reference. This returns the module text with the image references
// and their citation lines removed — the prose, headings, tables and lists are untouched, so gate
// checks and renders see the same content shape without a dangling asset lookup.
export function exampleModuleText(moduleId) {
  const text = readFileSync(join('workspaces', 'examples', 'kiwi-cover-mutual', 'modules', `${moduleId}.md`), 'utf8')
  return text
    .split('\n')
    .filter((line) => !/^!\[[^\]]*\]\(asset:[\w-]+\)\s*$/.test(line))
    .join('\n')
}
