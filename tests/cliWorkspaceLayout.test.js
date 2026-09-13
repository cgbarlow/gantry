import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, existsSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { program } from '../bin/gantry.js'
import { createInstance } from '../lib/instance.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { writeWorkspaceJson } from '../lib/workspaceDirectory.js'
import { listRegistry } from '../lib/registry.js'

/**
 * WI #370. The gap these tests exist to close: every pre-existing CLI test built its fixture in the
 * **pre-0.4 flat layout** (`<dir>/<slug>/instance.yaml`) and passed it explicitly via `--instances-dir`.
 * That layout is not the one that ships. Since WI #356 an instance lives one level deeper, inside a
 * workspace (`<root>/<workspace>/<slug>/`), and WI #358 made that root the CLI's default — so the CLI
 * was reading a directory shape no real deployment has, and a suite of 1016 passing tests said nothing
 * about it. `gantry instances` reported "No instances found." against a workspaces root the web
 * dashboard happily listed two instances from.
 *
 * Everything below therefore builds a **real workspaces root** — `workspace.json` marker, instances
 * nested inside it, registry entries — and drives the CLI against it the way a person would.
 */

// Commander must throw rather than call process.exit, so these stay in-process (which is also what
// keeps bin/gantry.js's lines counted in the coverage run — a child process contributes none).
program.exitOverride()

function captureLog() {
  const logs = []
  const origLog = console.log
  const origWarn = console.warn
  console.log = (...args) => logs.push(args.join(' '))
  console.warn = () => {}
  return {
    logs,
    output: () => logs.join('\n'),
    restore() {
      console.log = origLog
      console.warn = origWarn
    },
  }
}

/**
 * A workspaces root in the shape that actually ships: one or more `workspace.json` workspaces, each
 * holding real instances, all recorded in the instance registry — exactly what `gantry serve` leaves
 * behind and what the bundled `workspaces/examples/` looks like on disk.
 *
 * `definitions/` is symlinked rather than copied so these run against the repo's real `design`
 * definition; the CLI resolves it relative to the working directory, so the fixture has to be cwd.
 */
function makeWorkspacesRoot(spec) {
  const cwd = mkdtempSync(join(tmpdir(), 'gantry-wi370-'))
  symlinkSync(resolve('definitions'), join(cwd, 'definitions'))
  // `render` reads commit info for the document control table; borrow the repo's own git directory.
  try {
    symlinkSync(resolve('.git'), join(cwd, '.git'))
  } catch {
    /* a checkout without .git still exercises everything else here */
  }
  const workspacesDir = join(cwd, 'workspaces')
  mkdirSync(workspacesDir, { recursive: true })

  for (const [workspace, slugs] of Object.entries(spec)) {
    writeWorkspaceJson(workspacesDir, workspace, {
      name: workspace,
      kind: 'local',
      createdAt: new Date().toISOString(),
    })
    for (const slug of slugs) {
      createInstance('design', slug, {
        instancesDir: join(workspacesDir, workspace),
        definitionsDir: join(cwd, 'definitions'),
        owner: 'c.barlow',
      })
      registerInstance(slug, { kind: 'directory', workspace }, { instancesDir: workspacesDir })
    }
  }
  return { cwd, workspacesDir, cleanup: () => rmSync(cwd, { recursive: true, force: true }) }
}

// Runs `fn` with the process cwd inside the fixture, so the CLI's own default directory resolution
// ('workspaces', relative to cwd) is what's under test — not a directory handed to it by a flag.
async function inFixture(spec, fn) {
  const fixture = makeWorkspacesRoot(spec)
  const origCwd = process.cwd()
  const savedExit = process.exitCode
  try {
    process.chdir(fixture.cwd)
    await fn(fixture)
  } finally {
    process.exitCode = savedExit
    try {
      process.chdir(origCwd)
    } catch {
      /* ignore */
    }
    fixture.cleanup()
  }
}

// ── The reported bug ────────────────────────────────────────────────────────────────────────────

test('WI #370: gantry instances lists instances nested inside a workspace, with no flag', async () => {
  await inFixture({ examples: ['alpha', 'beta'] }, async () => {
    const cap = captureLog()
    try {
      await program.parseAsync(['node', 'gantry.js', 'instances'])
    } finally {
      cap.restore()
    }
    const out = cap.output()
    assert.doesNotMatch(out, /No instances found/, 'the whole point: these instances exist and must be listed')
    assert.match(out, /examples\/alpha/)
    assert.match(out, /examples\/beta/)
  })
})

test('WI #370: gantry instances --json carries the workspace each instance lives in', async () => {
  await inFixture({ examples: ['alpha'], other: ['beta'] }, async () => {
    const cap = captureLog()
    try {
      await program.parseAsync(['node', 'gantry.js', 'instances', '--json'])
    } finally {
      cap.restore()
    }
    const rows = JSON.parse(cap.output())
    assert.deepEqual(
      rows.map((r) => [r.workspace, r.slug]),
      [
        ['examples', 'alpha'],
        ['other', 'beta'],
      ]
    )
  })
})

// The CLI and the web dashboard read the same directory; before this ticket they disagreed completely
// about what was in it. This is the assertion that pins them together.
test('WI #370: the CLI listing and GET /api/instances agree about the same workspaces root', async () => {
  await inFixture({ examples: ['alpha', 'beta'], other: ['gamma'] }, async ({ workspacesDir }) => {
    const cap = captureLog()
    try {
      await program.parseAsync(['node', 'gantry.js', 'instances', '--json'])
    } finally {
      cap.restore()
    }
    const cliSlugs = JSON.parse(cap.output()).map((r) => `${r.workspace}/${r.slug}`)
    const apiSlugs = listRegistry({ instancesDir: workspacesDir, definitionsDir: 'definitions' }).map(
      (r) => `${r.workspace.id}/${r.slug}`
    )
    assert.deepEqual(cliSlugs.sort(), apiSlugs.sort())
  })
})

// ── Slug-taking commands against the default directory ──────────────────────────────────────────

test('WI #370: status resolves a slug living inside a workspace, with no flag', async () => {
  await inFixture({ examples: ['alpha'] }, async () => {
    const cap = captureLog()
    try {
      await program.parseAsync(['node', 'gantry.js', 'status', 'alpha'])
    } finally {
      cap.restore()
    }
    assert.match(cap.output(), /alpha — design/)
  })
})

test('WI #370: check resolves a slug living inside a workspace, with no flag', async () => {
  await inFixture({ examples: ['alpha'] }, async () => {
    const cap = captureLog()
    try {
      await program.parseAsync(['node', 'gantry.js', 'check', 'alpha', '--json'])
    } finally {
      cap.restore()
      process.exitCode = undefined
    }
    assert.equal(JSON.parse(cap.output()).slug, 'alpha')
  })
})

test('WI #370: render resolves a slug living inside a workspace, with no flag', async () => {
  await inFixture({ examples: ['alpha'] }, async () => {
    const cap = captureLog()
    try {
      await program.parseAsync(['node', 'gantry.js', 'render', 'alpha', 'soap', '--dry-run'])
    } finally {
      cap.restore()
    }
    assert.match(cap.output(), /Solution on a Page/)
  })
})

// ── Workspace-qualified addressing (WI #366's address form, now honoured by the CLI) ────────────

test('WI #370: a workspace-qualified address selects that workspace\'s copy of an ambiguous slug', async () => {
  await inFixture({ examples: ['shared'], other: ['shared'] }, async () => {
    const cap = captureLog()
    try {
      await program.parseAsync(['node', 'gantry.js', 'status', 'other/shared'])
    } finally {
      cap.restore()
    }
    assert.match(cap.output(), /shared — design/)
  })
})

test('WI #370: a bare slug that exists in two workspaces reports the ambiguity instead of guessing', async () => {
  await inFixture({ examples: ['shared'], other: ['shared'] }, async () => {
    await assert.rejects(
      () => program.parseAsync(['node', 'gantry.js', 'status', 'shared']),
      (err) => {
        assert.match(err.message, /ambiguous/i)
        assert.match(err.message, /examples/)
        assert.match(err.message, /other/)
        return true
      }
    )
  })
})

test('WI #370: an unknown slug names the instances that do exist, in their qualified form', async () => {
  await inFixture({ examples: ['alpha'] }, async () => {
    await assert.rejects(
      () => program.parseAsync(['node', 'gantry.js', 'status', 'nope']),
      (err) => {
        // The old failure mode was a dead end: the hint scanned the workspaces root, where there is
        // never anything to find, so it always came back empty.
        assert.match(err.message, /examples\/alpha/)
        return true
      }
    )
  })
})

// ── The round-trip that shipped broken ──────────────────────────────────────────────────────────

test('WI #370: an instance created by the CLI is still readable by the CLI after gantry serve migrates', async () => {
  await inFixture({}, async ({ cwd, workspacesDir }) => {
    const created = captureLog()
    try {
      await program.parseAsync(['node', 'gantry.js', 'new', 'design', 'my-initiative'])
    } finally {
      created.restore()
    }
    // `new` places it in the reserved `default` workspace — the same place `POST /api/instances` does,
    // which is what makes the migration below a no-op rather than a rug-pull.
    assert.ok(existsSync(join(workspacesDir, 'default', 'my-initiative', 'instance.yaml')))

    // Exactly what `gantry serve` does to the data directory on first start. Before this ticket this
    // step is what broke every later CLI command: `new` wrote the flat layout, this moved it, and the
    // CLI could no longer find data it had created itself.
    const { createServer } = await import('../lib/server.js')
    createServer({ instancesDir: workspacesDir, migrateWorkspacesOnStart: true })

    const after = captureLog()
    try {
      await program.parseAsync(['node', 'gantry.js', 'status', 'my-initiative'])
      await program.parseAsync(['node', 'gantry.js', 'instances'])
    } finally {
      after.restore()
    }
    assert.match(after.output(), /my-initiative — design/)
    assert.match(after.output(), /default\/my-initiative/)
    assert.equal(cwd, process.cwd())
  })
})

// ── The rest of the review's findings ───────────────────────────────────────────────────────────

test('WI #370: gantry definitions lists real definitions instead of the "not yet implemented" stub', async () => {
  const cap = captureLog()
  try {
    await program.parseAsync(['node', 'gantry.js', 'definitions'])
  } finally {
    cap.restore()
  }
  const out = cap.output()
  assert.doesNotMatch(out, /not yet implemented/)
  assert.match(out, /design — Solution Design/)
  assert.match(out, /stages:/)
})

test('WI #370: gantry definitions --json emits the same shape the server serves', async () => {
  const cap = captureLog()
  try {
    await program.parseAsync(['node', 'gantry.js', 'definitions', '--json'])
  } finally {
    cap.restore()
  }
  const parsed = JSON.parse(cap.output())
  const design = parsed.find((d) => d.id === 'design')
  assert.ok(design, 'the bundled design definition must be listed')
  assert.ok(Array.isArray(design.stages) && design.stages.length > 0)
})

// WI #369 added a root `-V, --version`; its own third acceptance criterion was that the subcommand
// `--version` options keep meaning a *definition* version. They did not — commander parsed the root
// option across the whole argv before dispatching, so this printed gantry's version and validated
// nothing. Both directions are asserted here so neither can regress in favour of the other again.
test('WI #370: validate --version still means the definition version, not gantry\'s own', async () => {
  const cap = captureLog()
  try {
    await program.parseAsync(['node', 'gantry.js', 'validate', 'design', '--version', '1'])
  } finally {
    cap.restore()
  }
  const out = cap.output()
  assert.match(out, /Definition is valid/)
  assert.doesNotMatch(out, /^\d+\.\d+\.\d+/m, 'must not have printed gantry\'s own version instead')
})

test('WI #370: new --version still pins the definition version', async () => {
  await inFixture({}, async ({ workspacesDir }) => {
    const cap = captureLog()
    try {
      await program.parseAsync(['node', 'gantry.js', 'new', 'design', 'pinned', '--version', '1'])
    } finally {
      cap.restore()
    }
    assert.match(cap.output(), /Created instance "pinned"/)
    const { readInstance } = await import('../lib/instance.js')
    assert.equal(readInstance('pinned', { instancesDir: join(workspacesDir, 'default') }).definitionVersion, 1)
  })
})

test('WI #370: backfill-numeric-refs honours --workspaces-dir instead of always targeting instances/', async () => {
  await inFixture({ examples: ['alpha'] }, async ({ workspacesDir }) => {
    const cap = captureLog()
    try {
      await program.parseAsync(['node', 'gantry.js', 'backfill-numeric-refs', '--workspaces-dir', workspacesDir])
    } finally {
      cap.restore()
    }
    assert.match(cap.output(), /Assigned numeric references/)
    assert.ok(existsSync(join(workspacesDir, 'number-registry.json')))
  })
})

test('WI #370: a no-op backfill against a directory that does not exist yet reports it, and writes nothing', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'gantry-wi370-empty-'))
  const origCwd = process.cwd()
  try {
    process.chdir(cwd)
    const cap = captureLog()
    try {
      await program.parseAsync(['node', 'gantry.js', 'backfill-numeric-refs'])
    } finally {
      cap.restore()
    }
    assert.match(cap.output(), /Nothing to backfill/)
    assert.ok(!existsSync(join(cwd, 'workspaces', 'number-registry.json')))
  } finally {
    try {
      process.chdir(origCwd)
    } catch {
      /* ignore */
    }
    rmSync(cwd, { recursive: true, force: true })
  }
})

// ── The error handler, which only exists on the real entry path ─────────────────────────────────

// These have to be child processes: the handler lives behind bin/gantry.js's `invokedDirectly` guard,
// so an in-process `parseAsync` never reaches it.
function runCli(args, cwd) {
  try {
    const stdout = execFileSync('node', [resolve('bin/gantry.js'), ...args], { cwd, encoding: 'utf8' })
    return { status: 0, stdout, stderr: '' }
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

test('WI #370: a user error prints one clear line and no stack trace, keeping exit code 1', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'gantry-wi370-err-'))
  try {
    symlinkSync(resolve('definitions'), join(cwd, 'definitions'))
    const result = runCli(['validate', 'no-such-definition'], cwd)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /gantry: Definition "no-such-definition" not found/)
    assert.doesNotMatch(result.stderr, /at Command\.|node:internal|Node\.js v/, 'a stack trace must not reach the user')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('WI #370: GANTRY_DEBUG still exposes the full stack for a real bug', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'gantry-wi370-debug-'))
  try {
    symlinkSync(resolve('definitions'), join(cwd, 'definitions'))
    let stderr = ''
    try {
      execFileSync('node', [resolve('bin/gantry.js'), 'validate', 'no-such-definition'], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GANTRY_DEBUG: '1' },
      })
    } catch (err) {
      stderr = err.stderr ?? ''
    }
    assert.match(stderr, /at /, 'GANTRY_DEBUG must still print the stack')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('WI #370: gantry --version still reports the running build', () => {
  const result = runCli(['--version'], process.cwd())
  assert.equal(result.status, 0)
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/)
})

// ── The deprecated flat layout, which `--instances-dir` still promises to read ───────────────────

// `resolveEffectiveWorkspacesDir`'s contract in bin/gantry.js is explicit that "a pre-0.4 flat data
// directory is still just a directory gantry can point at". That path has no workspace and no registry
// entry, so it is reached by the bare-directory scan rather than the registry — worth its own test,
// since every *other* test here now goes through the registry.
test('WI #370: a pre-0.4 flat directory still lists, reported as belonging to no workspace', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'gantry-wi370-flat-'))
  const origCwd = process.cwd()
  try {
    symlinkSync(resolve('definitions'), join(cwd, 'definitions'))
    const flatDir = join(cwd, 'legacy')
    mkdirSync(flatDir, { recursive: true })
    // No workspace.json, no registerInstance — exactly what a pre-0.4 directory looks like.
    createInstance('design', 'legacy-thing', { instancesDir: flatDir, definitionsDir: join(cwd, 'definitions') })
    process.chdir(cwd)

    const cap = captureLog()
    try {
      await program.parseAsync(['node', 'gantry.js', 'instances', '--workspaces-dir', flatDir, '--json'])
    } finally {
      cap.restore()
    }
    const rows = JSON.parse(cap.output())
    assert.deepEqual(
      rows.map((r) => [r.workspace, r.slug]),
      [[null, 'legacy-thing']],
      'a bare instance has no workspace, and saying so is more honest than inventing one'
    )

    // And it still resolves for the slug-taking commands, which is the actual promise.
    const status = captureLog()
    try {
      await program.parseAsync(['node', 'gantry.js', 'status', 'legacy-thing', '--workspaces-dir', flatDir])
    } finally {
      status.restore()
    }
    assert.match(status.output(), /legacy-thing — design/)
  } finally {
    try {
      process.chdir(origCwd)
    } catch {
      /* ignore */
    }
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('WI #370: an unreadable instance registry degrades to the directory scan instead of reporting nothing', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'gantry-wi370-badreg-'))
  const origCwd = process.cwd()
  try {
    symlinkSync(resolve('definitions'), join(cwd, 'definitions'))
    const dir = join(cwd, 'workspaces')
    mkdirSync(dir, { recursive: true })
    createInstance('design', 'survivor', { instancesDir: dir, definitionsDir: join(cwd, 'definitions') })
    writeFileSync(join(dir, 'instance-registry.json'), '{ this is not valid json')
    process.chdir(cwd)

    const cap = captureLog()
    try {
      await program.parseAsync(['node', 'gantry.js', 'instances', '--json'])
    } finally {
      cap.restore()
    }
    // A broken registry must not read as "you have no instances" — the instance is right there on disk.
    assert.deepEqual(
      JSON.parse(cap.output()).map((r) => r.slug),
      ['survivor']
    )
  } finally {
    try {
      process.chdir(origCwd)
    } catch {
      /* ignore */
    }
    rmSync(cwd, { recursive: true, force: true })
  }
})
