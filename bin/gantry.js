#!/usr/bin/env node
import { join, dirname } from 'node:path'
import { realpathSync, readFileSync } from 'node:fs'
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
// beats the env var, which beats the literal default), same reasoning.
export function resolveWorkspacesDir(cliWorkspacesDir) {
  return cliWorkspacesDir ?? process.env.GANTRY_WORKSPACES_DIR ?? 'workspaces'
}

// WI #358: every command's actual entry point into "which directory holds the data" — wires
// --workspaces-dir/GANTRY_WORKSPACES_DIR in as the primary way to point the CLI at data, with the
// older --instances-dir/GANTRY_INSTANCES_DIR kept working as a deprecated alias (resolving to the
// exact same value; a pre-0.4 flat data directory is still just a directory gantry can point at).
// Precedence: --workspaces-dir flag > GANTRY_WORKSPACES_DIR env > --instances-dir flag (deprecated)
// > GANTRY_INSTANCES_DIR env (deprecated) > the literal default 'workspaces'. Only the two deprecated
// forms log a notice — pointing at the new name once per invocation — so a caller who has already
// moved on sees nothing.
export function resolveEffectiveWorkspacesDir(options) {
  if (options.workspacesDir) return options.workspacesDir
  if (process.env.GANTRY_WORKSPACES_DIR) return process.env.GANTRY_WORKSPACES_DIR
  if (options.instancesDir) {
    console.error('gantry: --instances-dir is deprecated — use --workspaces-dir instead')
    return options.instancesDir
  }
  if (process.env.GANTRY_INSTANCES_DIR) {
    console.error('gantry: GANTRY_INSTANCES_DIR is deprecated — use GANTRY_WORKSPACES_DIR instead')
    return process.env.GANTRY_INSTANCES_DIR
  }
  return resolveWorkspacesDir()
}

export function resolvePort(cliPort) {
  return Number(cliPort ?? process.env.PORT ?? '3000')
}

export const program = new Command()

// WI #369 — read from package.json rather than a literal, so a release bump can never leave the CLI
// reporting a version it isn't. Resolved against this file's own location, not the working
// directory, so it reports the version of the gantry that is *running* — the question it exists to
// answer — even when invoked from another repo or through a symlink on PATH (`realpathSync` below is
// what makes the symlink case resolve to the real install rather than to `/usr/bin`).
function gantryVersion() {
  const packageJsonPath = join(dirname(dirname(realpathSync(fileURLToPath(import.meta.url)))), 'package.json')
  return JSON.parse(readFileSync(packageJsonPath, 'utf8')).version
}

program
  .name('gantry')
  .description('A repo-driven pipeline for staged, gated processes.')
  // `-V`, not `-v`: several subcommands already use `--version` for a *definition* version
  // (`new --version`, `validate --version`), and commander scopes those to their own subcommand, so
  // the two never collide — but a short `-v` would read as the same thing and invite the confusion.
  .version(gantryVersion(), '-V, --version', "Report gantry's own version")

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
  .option('--workspaces-dir <path>', 'workspaces directory (default: workspaces; or GANTRY_WORKSPACES_DIR env)')
  .option('--instances-dir <path>', 'deprecated alias for --workspaces-dir')
  .action((options) => {
    const instancesDir = resolveEffectiveWorkspacesDir(options)
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
  .option('--workspaces-dir <path>', 'workspaces directory (default: workspaces; or GANTRY_WORKSPACES_DIR env)')
  .option('--instances-dir <path>', 'deprecated alias for --workspaces-dir')
  .action((definition, slug, options) => {
    const version = options.definitionVersion ?? options.version ?? null
    const instancesDir = resolveEffectiveWorkspacesDir(options)
    const result = createInstance(definition, slug, { instancesDir, owner: options.owner, assignee: options.assignee, definitionVersion: version ?? undefined })
    console.log(`Created instance "${result.slug}" (${result.definitionId}, stage: ${result.stage})`)
    console.log(`Modules: ${result.modules.join(', ')}`)
  })

program
  .command('status <slug>')
  .description("Current stage, module completeness, what's outstanding")
  .option('--json', 'emit structured JSON output')
  .option('--workspaces-dir <path>', 'workspaces directory (default: workspaces; or GANTRY_WORKSPACES_DIR env)')
  .option('--instances-dir <path>', 'deprecated alias for --workspaces-dir')
  .action((slug, options) => {
    const instancesDir = resolveEffectiveWorkspacesDir(options)
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
  .option('--workspaces-dir <path>', 'workspaces directory (default: workspaces; or GANTRY_WORKSPACES_DIR env)')
  .option('--instances-dir <path>', 'deprecated alias for --workspaces-dir')
  .action((slug, options) => {
    const instancesDir = resolveEffectiveWorkspacesDir(options)
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
  .option('--workspaces-dir <path>', 'workspaces directory (default: workspaces; or GANTRY_WORKSPACES_DIR env)')
  .option('--instances-dir <path>', 'deprecated alias for --workspaces-dir')
  .action((slug, artefact, options) => {
    const instancesDir = resolveEffectiveWorkspacesDir(options)
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
      'Workspaces directory resolves as --workspaces-dir flag > GANTRY_WORKSPACES_DIR env > ' +
      '--instances-dir flag (deprecated) > GANTRY_INSTANCES_DIR env (deprecated) > workspaces; ' +
      'port resolves as --port flag > PORT env > 3000.'
  )
  .option('--port <port>', 'port to listen on')
  .option('--workspaces-dir <path>', 'workspaces directory (default: workspaces; or GANTRY_WORKSPACES_DIR env)')
  .option('--instances-dir <path>', 'deprecated alias for --workspaces-dir')
  .action((slug, options) => {
    const instancesDir = resolveEffectiveWorkspacesDir(options)
    const port = resolvePort(options.port)
    // A real `gantry serve` is the one place a pre-0.4 flat data directory gets migrated into the
    // reserved `default` server workspace on first start (WI #356/#358) — every other command, and
    // every test that constructs a server directly, opts in explicitly instead (see
    // lib/server.js's own createServer doc comment and tests/helpers/lifecycle.js).
    const server = createServer({ slug, instancesDir, migrateWorkspacesOnStart: true })
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
