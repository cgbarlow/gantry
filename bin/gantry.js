#!/usr/bin/env node
import { join, dirname } from 'node:path'
import { realpathSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { renderArtefact } from '../lib/render.js'
import { getStatus } from '../lib/status.js'
import { checkGate } from '../lib/check.js'
import { validateDefinition } from '../lib/validate.js'
import { listDefinitions } from '../lib/definition.js'
import { createServer } from '../lib/server.js'
import { createInstance } from '../lib/instance.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import {
  resolveInstanceDataDir,
  listWorkspaceInstances,
  ensureDefaultWorkspace,
  MIGRATED_DEFAULT_WORKSPACE_FOLDER,
} from '../lib/instanceDataDir.js'
import { parseInstanceAddress } from '../lib/slug.js'
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

/**
 * WI #370: turns the `<slug>` argument every instance command takes into the two things those commands
 * actually need — the bare slug, and the concrete directory that slug's files live in.
 *
 * Before this, each command passed the workspaces root straight through as if it were an instance
 * directory. That was true in the pre-0.4 flat layout and has been wrong since WI #356 moved instances
 * one level down into `workspaces/<workspace>/<slug>/`: `gantry status my-initiative` went looking in
 * `workspaces/my-initiative/`, a directory that hasn't existed since. Resolution now goes through the
 * same registry lookup `gantry serve` uses per request (lib/instanceDataDir.js), so both sides agree
 * about where an instance is.
 *
 * The argument accepts both address forms WI #366 defined: a bare `my-initiative`, and the qualified
 * `default/my-initiative` that disambiguates a slug living in more than one workspace. `strict: true`
 * means an ambiguous bare slug reports that fact and names the candidates, rather than guessing.
 */
function resolveInstanceArgument(address, workspacesDir) {
  const parsed = parseInstanceAddress(address)
  if (!parsed) {
    throw new Error(
      `Invalid instance "${address}" — expected a slug ("my-initiative") or a workspace-qualified address ("default/my-initiative").`
    )
  }
  const instancesDir = resolveInstanceDataDir(parsed.slug, workspacesDir, {
    workspace: parsed.workspace,
    strict: true,
    // A bare slug is what every documented example here types, and a single command resolves one
    // several times over — so the registry's bare-slug deprecation notice would be pure noise at a
    // terminal. The qualified form is accepted above for anyone who wants it.
    suppressBareSlugWarning: true,
  })
  // `readInstance` reports a miss well enough when it's looking in the right place, but its "Available
  // instances" hint is a flat scan of the directory it was handed — which, for an unknown slug, is the
  // workspaces *root*, where there are no instances to list because they all sit a level down. The
  // result was a dead end: the exact wrong-layout confusion this ticket is about, reported as if the
  // data simply wasn't there. Checking here instead means the hint can name every instance in every
  // workspace, in the qualified form that addresses them.
  if (!existsSync(join(instancesDir, parsed.slug, 'instance.yaml'))) {
    const available = listWorkspaceInstances(workspacesDir).map((row) =>
      row.workspace ? `${row.workspace}/${row.slug}` : row.slug
    )
    const hint = available.length
      ? ` Available instances: ${available.join(', ')}.`
      : ` No instances found in ${workspacesDir}.`
    throw new Error(`No instance "${address}" in ${workspacesDir}.${hint}`)
  }
  return { slug: parsed.slug, instancesDir }
}

// Every instance command resolves its data directory the same way, from the same two flags.
function withInstanceOptions(command) {
  return command
    .option('--workspaces-dir <path>', 'workspaces directory (default: workspaces; or GANTRY_WORKSPACES_DIR env)')
    .option('--instances-dir <path>', 'deprecated alias for --workspaces-dir')
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
  // WI #370: without this, the root `--version` below swallows the *subcommand* `--version` options
  // (`new --version`, `validate --version`, both of which mean a **definition** version). Commander
  // parses the root command's own options across the whole argv before dispatching to a subcommand, so
  // `gantry validate design --version 1` printed gantry's version and validated nothing — the exact
  // collision WI #369 assumed could not happen ("commander scopes those to their own subcommand"), and
  // a regression against that ticket's own third acceptance criterion. `enablePositionalOptions` is
  // commander's own remedy: option parsing stops at the first operand, so anything after a subcommand
  // name belongs to that subcommand, while `gantry --version` with no subcommand still reaches the root.
  .enablePositionalOptions()
  // `-V`, not `-v`: several subcommands already use `--version` for a *definition* version
  // (`new --version`, `validate --version`), and with positional options enabled the two no longer
  // collide — but a short `-v` would read as the same thing and invite the confusion.
  .version(gantryVersion(), '-V, --version', "Report gantry's own version")

program
  .command('definitions')
  .description('List definitions available in this repo')
  .option('--json', 'emit structured JSON output')
  .action((options) => {
    // WI #370: previously a `console.log('not yet implemented')` stub. The engine was never the missing
    // part — `listDefinitions` has backed the server's own `GET /api/definitions` and the Definition
    // Editor for several tickets; only the CLI was never wired to it.
    const definitions = listDefinitions()
    if (options.json) {
      console.log(JSON.stringify(definitions, null, 2))
      return
    }
    if (definitions.length === 0) {
      console.log('No definitions found.')
      return
    }
    for (const definition of definitions) {
      const versions = definition.versions?.length
        ? ` (versions: ${definition.versions.map((v) => (v.status === 'published' ? v.version : `${v.version} ${v.status}`)).join(', ')})`
        : ''
      console.log(`${definition.id} — ${definition.title}${versions}`)
      console.log(`      stages: ${definition.stages.map((stage) => stage.title).join(' → ')}`)
    }
  })

withInstanceOptions(
  program.command('instances').description('List instances available in this repo').option('--json', 'emit structured JSON output')
).action((options) => {
  const workspacesDir = resolveEffectiveWorkspacesDir(options)
  const instances = listWorkspaceInstances(workspacesDir)
  if (options.json) {
    console.log(JSON.stringify(instances, null, 2))
    return
  }
  if (instances.length === 0) {
    console.log(`No instances found in ${workspacesDir}.`)
    return
  }
  for (const instance of instances) {
    // WI #370: the workspace is part of an instance's identity now — since WI #356 the same slug can
    // legitimately exist in two of them, so a line naming only the slug can't tell them apart.
    const location = instance.workspace ? `${instance.workspace}/${instance.slug}` : instance.slug
    console.log(
      `${location} — ${instance.definition} (current stage: ${instance.stage}; data for: ${instance.stagesWithData.join(', ') || 'none'})`
    )
  }
})

withInstanceOptions(
  program
    .command('new <definition> <slug>')
    .description('Create an instance')
    .option('--owner <owner>', "owner to record in each module file's frontmatter")
    .option('--assignee <assignee>', 'assignee to record on the instance record itself (#97)')
    .option('--definition-version <version>', 'definition version to pin (default latest published)')
    .option('--version <version>', 'alias for --definition-version')
).action((definition, slug, options) => {
  const version = options.definitionVersion ?? options.version ?? null
  const workspacesDir = resolveEffectiveWorkspacesDir(options)
  // WI #370: create into the reserved `default` server workspace, not the workspaces root itself. An
  // instance written to the root is in the pre-0.4 flat layout: invisible to `gantry serve`'s dashboard
  // until its first start migrates it, and — once migrated — no longer findable by the CLI that made
  // it. This is the same placement `POST /api/instances` has used since WI #356, so an instance now
  // lands in exactly the same place whichever way it was created, and the migration never has to run.
  const instancesDir = ensureDefaultWorkspace(workspacesDir)
  const result = createInstance(definition, slug, {
    instancesDir,
    owner: options.owner,
    assignee: options.assignee,
    definitionVersion: version ?? undefined,
  })
  // Registered explicitly for the same reason the server does it (WI #356): the registry only
  // auto-discovers instances inside a real server workspace, so without this the instance exists on
  // disk but no listing knows about it.
  registerInstance(slug, { kind: 'directory', workspace: MIGRATED_DEFAULT_WORKSPACE_FOLDER }, { instancesDir: workspacesDir })
  console.log(`Created instance "${result.slug}" (${result.definitionId}, stage: ${result.stage})`)
  console.log(`Workspace: ${MIGRATED_DEFAULT_WORKSPACE_FOLDER}`)
  console.log(`Modules: ${result.modules.join(', ')}`)
})

withInstanceOptions(
  program
    .command('status <slug>')
    .description("Current stage, module completeness, what's outstanding")
    .option('--json', 'emit structured JSON output')
).action((address, options) => {
  const { slug, instancesDir } = resolveInstanceArgument(address, resolveEffectiveWorkspacesDir(options))
  const status = getStatus(slug, { instancesDir })
  if (options.json) {
    console.log(JSON.stringify(status, null, 2))
    return
  }
  console.log(`${status.slug} — ${status.definition} / ${status.stage.title} (gate: ${status.stage.gate})`)
  printModules(status.modules)
  console.log(status.complete ? 'Stage complete.' : 'Stage incomplete.')
})

withInstanceOptions(
  program
    .command('check <slug>')
    .description("Validate an instance against a gate's requirements")
    .option('--gate <id>', 'the gate to check against')
    .option('--json', 'emit structured JSON output')
).action((address, options) => {
  const { slug, instancesDir } = resolveInstanceArgument(address, resolveEffectiveWorkspacesDir(options))
  const result = checkGate(slug, { gate: options.gate, instancesDir })
  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
    if (!result.pass) process.exitCode = 1
    return
  }
  console.log(result.pass ? 'PASS' : 'FAIL')
  console.log(`${result.slug} — ${result.definition} / ${result.stage.title} (gate: ${result.gate})`)
  printModules(result.modules)
  if (!result.pass) process.exitCode = 1
})

// The per-module completeness block `status` and `check` both print, identically.
function printModules(modules) {
  for (const mod of modules) {
    const marker = mod.complete ? '[complete]' : mod.exists ? '[incomplete]' : '[missing]'
    console.log(`  ${marker} ${mod.title}`)
    if (!mod.exists) {
      console.log(`      file not found: modules/${mod.id}.md`)
    } else if (mod.outstanding.length) {
      console.log(`      outstanding: ${mod.outstanding.join(', ')}`)
    }
  }
}

withInstanceOptions(
  program
    .command('render <slug> <artefact>')
    .description('Render an artefact to out/')
    .option('--dry-run', 'resolve the template without writing')
).action((address, artefact, options) => {
  const { slug, instancesDir } = resolveInstanceArgument(address, resolveEffectiveWorkspacesDir(options))
  const result = renderArtefact(slug, artefact, { dryRun: options.dryRun, instancesDir })
  if (result.dryRun) {
    console.log(result.markdown)
  } else {
    console.log(`Rendered ${result.docxPath}`)
  }
})

withInstanceOptions(
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
).action((slug, options) => {
  const instancesDir = resolveEffectiveWorkspacesDir(options)
  const port = resolvePort(options.port)
  // A real `gantry serve` is the one place a pre-0.4 flat data directory gets migrated into the
  // reserved `default` server workspace (WI #356/#358) — every other command, and
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

withInstanceOptions(
  program
    .command('backfill-numeric-refs')
    .description(
      'One-time backfill of numeric workspace/instance references (WI200, docs/adr/0024) for workspaces/instances that predate this feature. Safe to run more than once — only fills in what is still missing.'
    )
).action((options) => {
  // WI #370: this command used to take no options at all and fall back to `backfillNumberRegistry`'s
  // own `'instances'` default — so it always targeted the pre-0.4 directory regardless of
  // --workspaces-dir or GANTRY_WORKSPACES_DIR, and silently reported "nothing to backfill" for a
  // workspaces root full of instances that genuinely needed one.
  const instancesDir = resolveEffectiveWorkspacesDir(options)
  const { workspacesAssigned, instancesAssigned } = backfillNumberRegistry({ instancesDir })
  if (workspacesAssigned === 0 && instancesAssigned === 0) {
    console.log(`Nothing to backfill in ${instancesDir} — every workspace/instance already has a numeric reference.`)
    return
  }
  console.log(
    `Assigned numeric references to ${workspacesAssigned} workspace(s) and ${instancesAssigned} instance(s) in ${instancesDir}.`
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
  // WI #370: every failure used to reach the top of the process as an unhandled rejection, so a plain
  // user error — a slug that doesn't exist, a definition that was never created — printed ten lines of
  // commander internals and a Node version banner instead of the one sentence the error already
  // carried. Exit codes are unchanged (1 for a failure, and a `check` FAIL still keeps its own), so
  // anything scripting against this sees exactly what it saw before; only the noise is gone. The full
  // stack is still one env var away for an actual bug.
  program.parseAsync(process.argv).catch((err) => {
    console.error(`gantry: ${err.message}`)
    if (process.env.GANTRY_DEBUG) console.error(err.stack)
    process.exitCode = 1
  })
}
