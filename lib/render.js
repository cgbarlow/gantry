import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Eta } from 'eta'
import { loadDefinition } from './definition.js'
import { readInstance, readModule } from './instance.js'
import { resolveAssetFileRefs } from './assets.js'

// autoTrim: false is deliberate — Eta's own default trimming strips the
// newline after every interpolation tag, which runs the next heading onto
// the same line as the preceding paragraph. The cost is that suppressed
// optional sections leave blank-line runs behind; renderArtefact collapses
// those afterwards instead.
const eta = new Eta({ autoTrim: false })

function findArtefactSpec(definition, artefactId) {
  const artefact = definition.artefacts.find((a) => a.id === artefactId)
  if (!artefact) {
    throw new Error(`Definition "${definition.id}" has no artefact "${artefactId}"`)
  }
  return artefact
}

// Compiles the artefact's template against already-fetched instance/module
// data and (unless `dryRun`) converts the result to a .docx via pandoc.
// Shared by the local and Azure-DevOps-backed paths below — they differ
// only in *how* `instance`/`modules` were fetched, never in this part.
// Rendered output (the compiled markdown, the .docx) always lands under
// the local `instancesDir`/`slug`/`out` — it's ephemeral, generated output
// for the current user to download, not instance data itself, so it isn't
// part of what #85 moved to Azure DevOps (`instance.yaml`, `modules/`,
// `assets/`).
function compileArtefact(slug, artefact, instance, modules, options) {
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const instancesDir = options.instancesDir ?? 'instances'

  const templatePath = join(definitionsDir, instance.definition, artefact.template)
  const templateSource = readFileSync(templatePath, 'utf8')
  const compiled = eta.renderString(templateSource, { instance, modules }).replace(/\n{3,}/g, '\n\n')
  // A module field's markdown may hand-type or have inserted (#80) an
  // `asset:<id>` reference at any paragraph position — resolve it to the
  // asset's real file in the instance's assets/ directory now, in place,
  // so pandoc embeds the actual image at that same position rather than
  // leaving a broken/literal "asset:<id>" link in the compiled artefact.
  const markdown = resolveAssetFileRefs(compiled, slug, { instancesDir })

  const outDir = join(instancesDir, slug, 'out')
  const mdPath = join(outDir, `${artefact.id}.md`)
  const docxPath = join(outDir, `${artefact.id}.docx`)

  if (options.dryRun) {
    return { markdown, mdPath, docxPath, dryRun: true }
  }

  mkdirSync(outDir, { recursive: true })
  writeFileSync(mdPath, markdown)

  const referenceDoc = join(definitionsDir, instance.definition, 'templates', 'reference.docx')
  const args = ['-f', 'markdown', '-t', 'docx']
  if (existsSync(referenceDoc)) {
    args.push('--reference-doc', referenceDoc)
  }
  args.push('-o', docxPath, mdPath)
  execFileSync('pandoc', args)

  return { markdown, mdPath, docxPath, dryRun: false }
}

/**
 * `gantry render <slug> <artefactId>`: compiles the artefact's template
 * against the instance's required module data, then (unless `dryRun`)
 * converts the resulting Markdown to a .docx via pandoc.
 *
 * With `options.azureDevOps` supplied, reads the instance/module data from
 * that Azure DevOps repo instead of the local filesystem (see
 * renderArtefactFromAzureDevOps below) and returns a Promise the caller
 * must `await`. Without it — every existing caller — this stays exactly
 * the synchronous local-filesystem read it always was.
 */
export function renderArtefact(slug, artefactId, options = {}) {
  if (options.azureDevOps) {
    return renderArtefactFromAzureDevOps(slug, artefactId, options)
  }

  const definitionsDir = options.definitionsDir ?? 'definitions'
  const instancesDir = options.instancesDir ?? 'instances'

  const instance = readInstance(slug, { instancesDir })
  const definition = loadDefinition(instance.definition, { definitionsDir })
  const artefact = findArtefactSpec(definition, artefactId)

  const modules = {}
  for (const moduleId of artefact.requires) {
    modules[moduleId] = readModule(definition, slug, moduleId, { instancesDir }).fields
  }

  return compileArtefact(slug, artefact, instance, modules, options)
}

// The Azure-DevOps-backed half of renderArtefact (#86) — the exact same
// template compile/pandoc step as the local path (compileArtefact above),
// over instance/module data read from Azure DevOps instead of disk.
async function renderArtefactFromAzureDevOps(slug, artefactId, options) {
  const definitionsDir = options.definitionsDir ?? 'definitions'

  const instance = await readInstance(slug, { azureDevOps: options.azureDevOps })
  const definition = loadDefinition(instance.definition, { definitionsDir })
  const artefact = findArtefactSpec(definition, artefactId)

  const modules = {}
  for (const moduleId of artefact.requires) {
    modules[moduleId] = (await readModule(definition, slug, moduleId, { azureDevOps: options.azureDevOps })).fields
  }

  return compileArtefact(slug, artefact, instance, modules, options)
}
