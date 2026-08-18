import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Eta } from 'eta'
import { loadDefinition } from './definition.js'
import { readInstance, readModule } from './instance.js'

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
  const markdown = eta.renderString(templateSource, { instance, modules })

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
