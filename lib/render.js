import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Eta } from 'eta'
import { loadDefinition } from './definition.js'
import { readInstance, readModule } from './instance.js'
import { resolveAssetFileRefs } from './assets.js'
import { createAzureDevOpsClient } from './azureDevOpsClient.js'

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
// Rendered output always lands under the local `instancesDir`/`slug`/`out`
// first — pandoc needs a real file on disk to write to, and for a local
// instance that local copy is the whole story. For an Azure-DevOps-backed
// instance it's a build scratch step only: `renderArtefactFromAzureDevOps`
// (below) pushes the resulting `.docx` on to the Azure DevOps repo
// afterwards, so the artefact ends up living alongside the instance data
// it was rendered from, not stranded on whichever machine `gantry serve`
// happens to be running on.
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
// over instance/module data read from Azure DevOps instead of disk. Unlike
// the local path, the rendered `.docx` doesn't stop at the local scratch
// copy: it's pushed on to the same Azure DevOps repo the instance itself
// lives in, at `out/<artefactId>.docx` on `main`, overwriting any previous
// render of that artefact (the repo's own history is the audit trail —
// no reason to also keep every past render as a distinct file). A dry run
// never reaches this — `compileArtefact` returns before writing anything,
// local or remote.
async function renderArtefactFromAzureDevOps(slug, artefactId, options) {
  const definitionsDir = options.definitionsDir ?? 'definitions'

  const instance = await readInstance(slug, { azureDevOps: options.azureDevOps })
  const definition = loadDefinition(instance.definition, { definitionsDir })
  const artefact = findArtefactSpec(definition, artefactId)

  const modules = {}
  for (const moduleId of artefact.requires) {
    modules[moduleId] = (await readModule(definition, slug, moduleId, { azureDevOps: options.azureDevOps })).fields
  }

  const result = await compileArtefact(slug, artefact, instance, modules, options)
  if (result.dryRun) return result

  const azureDevOpsPath = `out/${artefact.id}.docx`
  const client = createAzureDevOpsClient(options.azureDevOps)
  const docxBytes = readFileSync(result.docxPath)
  await client.writeFile(azureDevOpsPath, docxBytes.toString('base64'), {
    contentType: 'base64encoded',
    message: `Render ${artefact.id}`,
  })

  return { ...result, azureDevOpsPath }
}
