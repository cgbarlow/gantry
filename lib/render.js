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

/**
 * `gantry render <slug> <artefactId>`: compiles the artefact's template
 * against the instance's required module data, then (unless `dryRun`)
 * converts the resulting Markdown to a .docx via pandoc.
 */
export function renderArtefact(slug, artefactId, options = {}) {
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const instancesDir = options.instancesDir ?? 'instances'

  const instance = readInstance(slug, { instancesDir })
  const definition = loadDefinition(instance.definition, { definitionsDir })
  const artefact = definition.artefacts.find((a) => a.id === artefactId)
  if (!artefact) {
    throw new Error(`Definition "${instance.definition}" has no artefact "${artefactId}"`)
  }

  const modules = {}
  for (const moduleId of artefact.requires) {
    modules[moduleId] = readModule(definition, slug, moduleId, { instancesDir }).fields
  }

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
  const mdPath = join(outDir, `${artefactId}.md`)
  const docxPath = join(outDir, `${artefactId}.docx`)

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
