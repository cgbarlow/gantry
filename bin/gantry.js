#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { renderArtefact } from '../lib/render.js'
import { getStatus } from '../lib/status.js'
import { checkGate } from '../lib/check.js'
import { validateDefinition } from '../lib/validate.js'
import { createServer } from '../lib/server.js'
import { createInstance, listInstances } from '../lib/instance.js'
import { backfillNumberRegistry } from '../lib/numberRegistry.js'

export function resolveInstancesDir(cliInstancesDir) {
  return cliInstancesDir ?? process.env.GANTRY_INSTANCES_DIR ?? 'instances'
}

// WI #355: the CLI-side counterpart of resolveInstancesDir above, for the workspaces root a **server
// workspace** directory (lib/workspaceDirectory.js) lives under — same precedence (an explicit flag value
// beats the env var, which beats the literal default), same reasoning. No command wires this in yet: that
// cutover — a real --workspaces-dir flag on `serve`/`new`/`status`/`check`/`render`/`instances`, replacing
// --instances-dir as the primary way to point the CLI at data — is Feature #356's job, not this one's.
// Exported now, and unit-tested now, so #356 has this precedence already proven rather than writing it
// from scratch under time pressure.
export function resolveWorkspacesDir(cliWorkspacesDir) {
  return cliWorkspacesDir ?? process.env.GANTRY_WORKSPACES_DIR ?? 'workspaces'
}

export function resolvePort(cliPort) {
  return Number(cliPort ?? process.env.PORT ?? '3000')
}

export const program = new Command()

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
  .option('--instances-dir <path>', 'instances directory (default: instances) — superseded by --workspaces-dir, coming soon')
  .action((options) => {
    const instancesDir = resolveInstancesDir(options.instancesDir)
    const instances = listInstances({ instancesDir })
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
  .option('--assignee <assignee>', 'assignee to record on the instance record itself (#97)')
  .option('--definition-version <version>', 'definition version to pin (default latest published)')
  .option('--version <version>', 'alias for --definition-version')
  .option('--instances-dir <path>', 'instances directory (default: instances) — superseded by --workspaces-dir, coming soon')
  .action((definition, slug, options) => {
    const version = options.definitionVersion ?? options.version ?? null
    const instancesDir = resolveInstancesDir(options.instancesDir)
    const result = createInstance(definition, slug, { instancesDir, owner: options.owner, assignee: options.assignee, definitionVersion: version ?? undefined })
    console.log(`Created instance "${result.slug}" (${result.definitionId}, stage: ${result.stage})`)
    console.log(`Modules: ${result.modules.join(', ')}`)
  })

program
  .command('status <slug>')
  .description("Current stage, module completeness, what's outstanding")
  .option('--json', 'emit structured JSON output')
  .option('--instances-dir <path>', 'instances directory (default: instances) — superseded by --workspaces-dir, coming soon')
  .action((slug, options) => {
    const instancesDir = resolveInstancesDir(options.instancesDir)
    const status = getStatus(slug, { instancesDir })
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
  .option('--instances-dir <path>', 'instances directory (default: instances) — superseded by --workspaces-dir, coming soon')
  .action((slug, options) => {
    const instancesDir = resolveInstancesDir(options.instancesDir)
    const result = checkGate(slug, { gate: options.gate, instancesDir })
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
  .option('--instances-dir <path>', 'instances directory (default: instances) — superseded by --workspaces-dir, coming soon')
  .action((slug, artefact, options) => {
    const instancesDir = resolveInstancesDir(options.instancesDir)
    const result = renderArtefact(slug, artefact, { dryRun: options.dryRun, instancesDir })
    if (result.dryRun) {
      console.log(result.markdown)
    } else {
      console.log(`Rendered ${result.docxPath}`)
    }
  })

program
  .command('serve [slug]')
  .description(
    'Serve the web app: an instance dashboard at / (every registered instance, via GET ' +
      '/api/instances) and the stage-by-stage form at /instance/<slug>. [slug] only sets a ' +
      'fallback default for API requests made with no ?slug=<slug> of their own — it does not ' +
      'change what the dashboard shows or require picking one instance up front. ' +
      'Instances directory resolves as --instances-dir flag > GANTRY_INSTANCES_DIR env > instances; ' +
      'port resolves as --port flag > PORT env > 3000.'
  )
  .option('--port <port>', 'port to listen on')
  .option(
    '--instances-dir <path>',
    'instances directory (default: instances; or GANTRY_INSTANCES_DIR env) — superseded by --workspaces-dir, coming soon'
  )
  .action((slug, options) => {
    const instancesDir = resolveInstancesDir(options.instancesDir)
    const port = resolvePort(options.port)
    const server = createServer({ slug, instancesDir })
    server.listen(port, () => {
      const label = slug ? `default instance for slug-less API requests: ${slug}` : 'no default instance'
      console.log(`gantry serve: http://localhost:${port} (${label})`)
    })
  })

program
  .command('validate <definition>')
  .description('Validate a definition against the schema')
  .option('--json', 'emit structured JSON output')
  .option('--version <version>', 'definition version to validate (default latest published)')
  .option('--definition-version <version>', 'alias for --version')
  .action((definition, options) => {
    const version = options.version ?? options.definitionVersion ?? null
    const result = validateDefinition(definition, { version: version ? Number(version) : undefined })
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

program
  .command('backfill-numeric-refs')
  .description(
    'One-time backfill of numeric workspace/instance references (WI200, docs/adr/0024) for workspaces/instances that predate this feature. Safe to run more than once — only fills in what is still missing.'
  )
  .action(() => {
    const { workspacesAssigned, instancesAssigned } = backfillNumberRegistry()
    if (workspacesAssigned === 0 && instancesAssigned === 0) {
      console.log('Nothing to backfill — every workspace/instance already has a numeric reference.')
      return
    }
    console.log(
      `Assigned numeric references to ${workspacesAssigned} workspace(s) and ${instancesAssigned} instance(s).`
    )
  })

const invokedDirectly = (() => {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (invokedDirectly) {
  program.parseAsync(process.argv)
}
