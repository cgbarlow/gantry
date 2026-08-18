#!/usr/bin/env node
import { Command } from 'commander'
import { renderArtefact } from '../lib/render.js'
import { getStatus } from '../lib/status.js'
import { createServer } from '../lib/server.js'
import { createInstance } from '../lib/instance.js'

const program = new Command()

program
  .name('gantry')
  .description('A repo-driven pipeline for staged, gated processes.')

program
  .command('definitions')
  .description('List definitions available in this repo')
  .action(() => {
    console.log('not yet implemented')
  })

program
  .command('new <definition> <slug>')
  .description('Create an instance')
  .option('--owner <owner>', 'owner to record in each module file\'s frontmatter')
  .action((definition, slug, options) => {
    const result = createInstance(definition, slug, { owner: options.owner })
    console.log(`Created instance "${result.slug}" (${result.definitionId}, stage: ${result.stage})`)
    console.log(`Modules: ${result.modules.join(', ')}`)
  })

program
  .command('status <slug>')
  .description("Current stage, module completeness, what's outstanding")
  .option('--json', 'emit structured JSON output')
  .action((slug, options) => {
    const status = getStatus(slug)
    if (options.json) {
      console.log(JSON.stringify(status, null, 2))
      return
    }
    console.log(`${status.slug} — ${status.definition} / ${status.stage.title} (gate: ${status.stage.gate})`)
    for (const mod of status.modules) {
      const marker = mod.complete ? '[complete]' : mod.exists ? '[incomplete]' : '[missing]'
      console.log(`  ${marker} ${mod.title}`)
      if (!mod.exists) {
        console.log(`      file not found: modules/${mod.id}.md`)
      } else if (mod.outstanding.length) {
        console.log(`      outstanding: ${mod.outstanding.join(', ')}`)
      }
    }
    console.log(status.complete ? 'Stage complete.' : 'Stage incomplete.')
  })

program
  .command('check <slug>')
  .description("Validate an instance against a gate's requirements")
  .option('--gate <id>', 'the gate to check against')
  .option('--json', 'emit structured JSON output')
  .action(() => {
    console.log('not yet implemented')
  })

program
  .command('render <slug> <artefact>')
  .description('Render an artefact to out/')
  .option('--dry-run', 'resolve the template without writing')
  .action((slug, artefact, options) => {
    const result = renderArtefact(slug, artefact, { dryRun: options.dryRun })
    if (result.dryRun) {
      console.log(result.markdown)
    } else {
      console.log(`Rendered ${result.docxPath}`)
    }
  })

program
  .command('serve [slug]')
  .description('Serve the stage-by-stage form')
  .option('--port <port>', 'port to listen on', '3000')
  .action((slug, options) => {
    const resolvedSlug = slug ?? 'example-soap'
    const server = createServer({ slug: resolvedSlug })
    const port = Number(options.port)
    server.listen(port, () => {
      console.log(`gantry serve: http://localhost:${port} (instance: ${resolvedSlug})`)
    })
  })

program
  .command('validate <definition>')
  .description('Validate a definition against the schema')
  .action(() => {
    console.log('not yet implemented')
  })

program.parseAsync(process.argv)
