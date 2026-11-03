import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadDefinition } from '../../lib/definition.js'
import { withoutCitationsAtAll } from './uncite.js'

const EXAMPLE_DIR = join('workspaces', 'examples', 'kiwi-cover-mutual')

// The bundled Kiwi Cover Mutual fixture (WI #348, moved to `workspaces/examples/kiwi-cover-mutual`
// by WI #358) carries diagrams as `![…](asset:<id>)` references backed by that instance's own
// `assets/manifest.yaml`. Tests that borrow a fixture module's text to seed some *other* instance (a
// fake Azure DevOps repo, a local-workspace payload, a scratch instance) have no such manifest, and a
// render would fail resolving the reference. The same goes for a `[text](source:<id>)` citation of one of
// the example's Source documents (#310): the borrowing instance has none, so each is taken out whole. This returns the module text with the image references
// and their citation lines removed — the prose, headings, tables and lists are untouched, so gate
// checks and renders see the same content shape without a dangling asset lookup.
//
// The example is on design v3 (#193), but most of those instances are on v2, the latest published
// version. An instance file finds each Field by its title, so a Field v3 retitled with its id kept
// (#233's "Operational accounts and licences") gets back the title of the `definitionVersion` seeded.
export function exampleModuleText(moduleId, { definitionVersion = 2 } = {}) {
  const text = withVersion2Sections(moduleId, definitionVersion, withoutCitationsAtAll(readFileSync(join(EXAMPLE_DIR, 'modules', `${moduleId}.md`), 'utf8')))
  const retitled = retitledHeadings(moduleId, definitionVersion)
  return text
    .split('\n')
    .filter((line) => !/^!\[[^\]]*\]\(asset:[\w-]+\)\s*$/.test(line))
    .map((line) => retitled.get(line) ?? line)
    .join('\n')
}

// Loaded once per version: dozens of suites call this per module, and each load validates the definition.
const definitions = new Map()
function designModule(version, moduleId) {
  if (!definitions.has(version)) definitions.set(version, loadDefinition('design', { version }))
  return definitions.get(version).modules.get(moduleId)
}

// The example's own version, read from its instance.yaml so this follows the example when it moves on.
const exampleVersion = Number(readFileSync(join(EXAMPLE_DIR, 'instance.yaml'), 'utf8').match(/^definitionVersion:\s*(\d+)/m)[1])

// `## <example's title>` → `## <title in definitionVersion>`, for each Field of the module both versions have.
function retitledHeadings(moduleId, definitionVersion) {
  const headings = new Map()
  if (definitionVersion === exampleVersion) return headings
  const example = designModule(exampleVersion, moduleId)
  const seeded = designModule(definitionVersion, moduleId)
  if (!example || !seeded) return headings
  for (const field of example.fields) {
    const title = seeded.fields.find((f) => f.id === field.id)?.title
    if (title && title !== field.title) headings.set(`## ${field.title}`, `## ${title}`)
  }
  return headings
}

// #308: design v3 moved the two decisions tables into the Key decisions module (`key-decisions.md`), so
// the example no longer carries them. A v1 or v2 Instance still has the Fields, and its SAD and
// As-built Gates still need them, so a fixture seeded for those versions gets the v2 tables back.
const DECISIONS_TABLE_HEAD = '| AD | Decision | ADR |\n|----------|----------------------------------------------------------------------|------------|\n'
const VERSION_2_SECTIONS = {
  architecture: `\n## Design decisions\n\n${DECISIONS_TABLE_HEAD}| AD01 | **Shared services, not point-to-point.** CIS and Claims InfoServ serve customer and claim data; applications don't hold copies. An ADR because the services are built for enterprise reuse. | ADRYYY |\n| AD02 | **Policy Data Management stays the system of record, exposed as services.** Four CICS transactions over MQ. An ADR because it sets the precedent for exposing the mainframe as services. | ADRYYY |\n| AD03 | **The CRM System orchestrates Handle Claim; Claims InfoServ owns claim state**, valuation, routing rules and the audit trail. | |\n`,
  'as-built-notes': `\n## Architecture decisions\n\n${DECISIONS_TABLE_HEAD}| AD01 | **Shared services** — as designed. | ADR031 |\n| AD02 | **Policy Data Management exposed as services** — PDM-01 to PDM-04 live in the April and May windows. | ADR032 |\n| AD03 | **CRM System orchestrates, Claims InfoServ owns state** — nightly checks find no drift. | |\n`,
}

function withVersion2Sections(moduleId, definitionVersion, text) {
  const section = VERSION_2_SECTIONS[moduleId]
  if (!section || definitionVersion >= 3 || text.includes(section.trim().split('\n')[0])) return text
  return `${text.trimEnd()}\n${section}`
}
