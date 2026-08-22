#!/usr/bin/env node
import { Command } from 'commander'
import { renderArtefact } from '../lib/render.js'
import { getStatus } from '../lib/status.js'
import { checkGate } from '../lib/check.js'
import { validateDefinition } from '../lib/validate.js'
import { createServer } from '../lib/server.js'
import { createInstance, listInstances } from '../lib/instance.js'

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
  .command('instances')
  .description('List instances available in this repo')
  .option('--json', 'emit structured JSON output')
  .action((options) => {
    const instances = listInstances()
    if (options.json) {
      console.log(JSON.stringify(instances, null, 2))
      return
    }
    if (instances.length === 0) {
      console.log('No instances found.')
      return
    }
    for (const instance of instances) {
      console.log(
        `${instance.slug} — ${instance.definition} (current stage: ${instance.stage}; data for: ${instance.stagesWithData.join(', ') || 'none'})`
      )
    }
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
  .action((slug, options) => {
    const result = checkGate(slug, { gate: options.gate })
    if (options.json) {
      console.log(JSON.stringify(result, null, 2))
      if (!result.pass) process.exitCode = 1
      return
    }
    console.log(result.pass ? 'PASS' : 'FAIL')
    console.log(`${result.slug} — ${result.definition} / ${result.stage.title} (gate: ${result.gate})`)
    for (const mod of result.modules) {
      const marker = mod.complete ? '[complete]' : mod.exists ? '[incomplete]' : '[missing]'
      console.log(`  ${marker} ${mod.title}`)
      if (!mod.exists) {
        console.log(`      file not found: modules/${mod.id}.md`)
      } else if (mod.outstanding.length) {
        console.log(`      outstanding: ${mod.outstanding.join(', ')}`)
      }
    }
    if (!result.pass) process.exitCode = 1
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
  .description(
    'Serve the stage-by-stage form for <slug>. Without a slug, the JSON API still serves every ' +
      'instance (e.g. GET /api/instances) — the bundled form itself still needs one instance ' +
      'selected via ?slug=<slug>, since it has no instance-picker screen yet'
  )
  .option('--port <port>', 'port to listen on', '3000')
  .action((slug, options) => {
    const server = createServer({ slug })
    const port = Number(options.port)
    server.listen(port, () => {
      const label = slug
        ? `instance: ${slug}`
        : 'no default instance — API only (GET /api/instances, or ?slug=<slug> per request); the bundled form has no instance-picker yet'
      console.log(`gantry serve: http://localhost:${port} (${label})`)
    })
  })

program
  .command('validate <definition>')
  .description('Validate a definition against the schema')
  .option('--json', 'emit structured JSON output')
  .action((definition, options) => {
    const result = validateDefinition(definition)
    if (options.json) {
      console.log(JSON.stringify(result.problems, null, 2))
      if (!result.valid) process.exitCode = 1
      return
    }
    if (result.valid) {
      console.log('Definition is valid.')
      return
    }
    for (const problem of result.problems) {
      console.log(`  [${problem.type}] ${problem.message}`)
    }
    process.exitCode = 1
  })

program.parseAsync(process.argv)
