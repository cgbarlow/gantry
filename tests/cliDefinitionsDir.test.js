import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, existsSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { program } from '../bin/gantry.js'
import { resolveDefinitionsDir } from '../lib/definition.js'

/**
 * WI #371. `definitions/` is a packaged asset — it ships inside the install. `gantry serve` has
 * resolved it against the package root since WI #278, which is what lets the server run from any
 * directory; every other command still resolved it against the *working directory*, so an installed
 * `gantry` on PATH only found the built-in definitions when you happened to be standing in a gantry
 * checkout. `gantry definitions` said "No definitions found." anywhere else, and `gantry new design …`
 * failed claiming the definition had no version 1 — blaming the definition for a missing directory.
 *
 * The condition none of the existing tests exercised: **a working directory that is not a gantry
 * checkout**. Every CLI test before this one either ran from the repo root or symlinked `definitions/`
 * into its fixture, so the cwd-relative lookup always happened to succeed.
 */

program.exitOverride()

// tests/ sits one level under the package root, same as lib/ does.
const packageRoot = fileURLToPath(new URL('..', import.meta.url))

function captureLog() {
  const logs = []
  const origLog = console.log
  console.log = (...args) => logs.push(args.join(' '))
  return {
    output: () => logs.join('\n'),
    restore() {
      console.log = origLog
    },
  }
}

// A working directory with no `definitions/` of its own — an installed gantry's ordinary situation.
async function inBareDirectory(fn) {
  const cwd = mkdtempSync(join(tmpdir(), 'gantry-wi371-bare-'))
  const origCwd = process.cwd()
  const savedExit = process.exitCode
  try {
    process.chdir(cwd)
    assert.ok(!existsSync('definitions'), 'fixture must not be a checkout, or it proves nothing')
    await fn(cwd)
  } finally {
    process.exitCode = savedExit
    try {
      process.chdir(origCwd)
    } catch {
      /* ignore */
    }
    rmSync(cwd, { recursive: true, force: true })
  }
}

// ── The resolver itself ─────────────────────────────────────────────────────────────────────────

test('WI #371: an explicit directory always wins', () => {
  assert.equal(resolveDefinitionsDir('/somewhere/else'), '/somewhere/else')
})

test('WI #371: a definitions/ in the working directory beats the packaged copy', () => {
  // Run from the repo root, which has one. Editing a definition and validating it must act on the
  // checkout's copy, never silently on the installed one.
  assert.equal(resolveDefinitionsDir(), 'definitions')
})

test('WI #371: with no definitions/ in the working directory, the packaged copy is used', async () => {
  await inBareDirectory(() => {
    const resolved = resolveDefinitionsDir()
    assert.notEqual(resolved, 'definitions', 'must not hand back a cwd-relative path that does not exist')
    assert.ok(existsSync(join(resolved, 'design')), `expected the packaged design definition under ${resolved}`)
    // It must be the *install's* own copy, resolved from the package root rather than from wherever
    // the process happens to be standing — that is the whole point.
    assert.equal(resolved, join(packageRoot, 'definitions'))
  })
})

// ── The commands, from a directory that is not a checkout ───────────────────────────────────────

test('WI #371: gantry definitions lists the packaged definitions from any directory', async () => {
  await inBareDirectory(async () => {
    const cap = captureLog()
    try {
      await program.parseAsync(['node', 'gantry.js', 'definitions'])
    } finally {
      cap.restore()
    }
    const out = cap.output()
    assert.doesNotMatch(out, /No definitions found/)
    assert.match(out, /design — Solution Design/)
  })
})

test('WI #371: gantry validate resolves a packaged definition from any directory', async () => {
  await inBareDirectory(async () => {
    const cap = captureLog()
    try {
      await program.parseAsync(['node', 'gantry.js', 'validate', 'design'])
    } finally {
      cap.restore()
    }
    assert.match(cap.output(), /Definition is valid/)
  })
})

test('WI #371: gantry new works from any directory, and status/check can read back what it made', async () => {
  await inBareDirectory(async (cwd) => {
    const created = captureLog()
    try {
      await program.parseAsync(['node', 'gantry.js', 'new', 'design', 'anywhere'])
    } finally {
      created.restore()
    }
    // Previously: `Definition "design" has no version 1`, because no definitions directory was found.
    assert.match(created.output(), /Created instance "anywhere"/)
    assert.ok(existsSync(join(cwd, 'workspaces', 'default', 'anywhere', 'instance.yaml')))

    // status and check load the instance's own definition too, so they need the same resolution.
    const read = captureLog()
    try {
      await program.parseAsync(['node', 'gantry.js', 'status', 'anywhere'])
      await program.parseAsync(['node', 'gantry.js', 'check', 'anywhere', '--json'])
    } finally {
      read.restore()
      process.exitCode = undefined
    }
    assert.match(read.output(), /anywhere — design/)
  })
})

test('WI #371: gantry instances resolves definitions from any directory', async () => {
  await inBareDirectory(async () => {
    const setup = captureLog()
    try {
      await program.parseAsync(['node', 'gantry.js', 'new', 'design', 'listed'])
    } finally {
      setup.restore()
    }
    const cap = captureLog()
    try {
      await program.parseAsync(['node', 'gantry.js', 'instances'])
    } finally {
      cap.restore()
    }
    assert.match(cap.output(), /default\/listed — design/)
  })
})

// ── The explicit flag ───────────────────────────────────────────────────────────────────────────

test('WI #371: --definitions-dir overrides even a definitions/ sitting in the working directory', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'gantry-wi371-flag-'))
  const origCwd = process.cwd()
  try {
    // A cwd definitions/ that is deliberately empty, plus a real one somewhere else. Without the flag
    // the empty one would win (rule 2); with it, the named directory must.
    mkdirSync(join(cwd, 'definitions'), { recursive: true })
    const elsewhere = join(cwd, 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    cpSync(resolve('definitions', 'design'), join(elsewhere, 'design'), { recursive: true })
    process.chdir(cwd)

    const without = captureLog()
    try {
      await program.parseAsync(['node', 'gantry.js', 'definitions'])
    } finally {
      without.restore()
    }
    assert.match(without.output(), /No definitions found/, 'the empty cwd directory should win by default')

    const withFlag = captureLog()
    try {
      await program.parseAsync(['node', 'gantry.js', 'definitions', '--definitions-dir', elsewhere])
    } finally {
      withFlag.restore()
    }
    assert.match(withFlag.output(), /design — Solution Design/)
  } finally {
    try {
      process.chdir(origCwd)
    } catch {
      /* ignore */
    }
    rmSync(cwd, { recursive: true, force: true })
  }
})

// ── Reporting a missing directory as a missing directory ────────────────────────────────────────

test('WI #371: a definitions directory that does not exist says so, instead of blaming the definition', async () => {
  await inBareDirectory(async () => {
    await assert.rejects(
      () => program.parseAsync(['node', 'gantry.js', 'validate', 'design', '--definitions-dir', '/no/such/dir']),
      (err) => {
        assert.match(err.message, /No definitions directory at \/no\/such\/dir/)
        // The old message read as "your definition is malformed", which sent you looking in the
        // wrong place entirely.
        assert.doesNotMatch(err.message, /has no version/)
        return true
      }
    )
  })
})

// A definitions directory that exists but doesn't hold the definition asked for is a *different*
// problem, and must keep reporting itself as one — this is the case the check above must not swallow.
test('WI #371: an existing directory missing that one definition still reports the definition, not the directory', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'gantry-wi371-empty-'))
  const origCwd = process.cwd()
  try {
    mkdirSync(join(cwd, 'definitions'), { recursive: true })
    process.chdir(cwd)
    await assert.rejects(
      () => program.parseAsync(['node', 'gantry.js', 'validate', 'nope']),
      (err) => {
        assert.match(err.message, /"nope"/)
        assert.doesNotMatch(err.message, /No definitions directory/)
        return true
      }
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
