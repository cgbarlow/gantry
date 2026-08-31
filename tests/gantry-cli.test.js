import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveInstancesDir, resolvePort, program } from '../bin/gantry.js'

function withEnv(env, fn) {
  const prev = {}
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  const result = fn()
  const restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
  if (result && typeof result.then === 'function') {
    return result.finally(restore)
  }
  restore()
}

function captureLog() {
  const logs = []
  const orig = console.log
  console.log = (...args) => logs.push(args.join(' '))
  return { logs, restore() { console.log = orig } }
}

// Ensure commander throws instead of calling process.exit, so tests remain in-process
program.exitOverride()

// instancesDir: flag > env > default
test('resolveInstancesDir: flag takes precedence over env and default', () => {
  withEnv({ GANTRY_INSTANCES_DIR: '/from-env' }, () => {
    assert.equal(resolveInstancesDir('/from-flag'), '/from-flag')
  })
})

test('resolveInstancesDir: env used when flag is undefined', () => {
  withEnv({ GANTRY_INSTANCES_DIR: '/from-env' }, () => {
    assert.equal(resolveInstancesDir(undefined), '/from-env')
  })
})

test('resolveInstancesDir: default when neither flag nor env', () => {
  withEnv({ GANTRY_INSTANCES_DIR: undefined }, () => {
    assert.equal(resolveInstancesDir(undefined), 'instances')
  })
})

test('resolveInstancesDir: flag undefined falls back to default when env empty string? nullish only', () => {
  withEnv({ GANTRY_INSTANCES_DIR: undefined }, () => {
    assert.equal(resolveInstancesDir(null), 'instances')
  })
})

// port: flag > env > default
test('resolvePort: flag takes precedence over env and default', () => {
  withEnv({ PORT: '4000' }, () => {
    assert.equal(resolvePort('5000'), 5000)
  })
})

test('resolvePort: env used when flag is undefined', () => {
  withEnv({ PORT: '4000' }, () => {
    assert.equal(resolvePort(undefined), 4000)
  })
})

test('resolvePort: default 3000 when neither flag nor env', () => {
  withEnv({ PORT: undefined }, () => {
    assert.equal(resolvePort(undefined), 3000)
  })
})

test('resolvePort: string flag is coerced to number', () => {
  withEnv({ PORT: undefined }, () => {
    assert.equal(resolvePort('8080'), 8080)
  })
})

test('resolvePort: env string is coerced to number', () => {
  withEnv({ PORT: '9000' }, () => {
    assert.equal(resolvePort(undefined), 9000)
  })
})

// ── CLI pass-throughs: --instances-dir flag > GANTRY_INSTANCES_DIR env > default ──
// These tests drive the actual commander actions in bin/gantry.js so that
// coverage for those lines is counted in test:unit:ci (spawning a child
// process would not contribute to the parent's coverage).

test('CLI instances --instances-dir uses flag dir (flag > env)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gantry-cli-instances-flag-'))
  const tmpEnv = mkdtempSync(join(tmpdir(), 'gantry-cli-env-'))
  // put a dummy instance in env dir to prove flag wins
  try {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(tmpEnv, 'dummy'), { recursive: true })
    writeFileSync(join(tmpEnv, 'dummy', 'instance.yaml'), 'slug: dummy\n')
    const { logs, restore } = captureLog()
    try {
      await withEnv({ GANTRY_INSTANCES_DIR: tmpEnv }, async () => {
        await program.parseAsync(['node', 'gantry.js', 'instances', '--instances-dir', tmp])
      })
      assert.ok(logs.some(l => l.includes('No instances found.')), `expected empty flag dir to report none, got ${logs.join('\n')}`)
    } finally { restore() }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
    rmSync(tmpEnv, { recursive: true, force: true })
  }
})

test('CLI instances uses GANTRY_INSTANCES_DIR env when --instances-dir omitted', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gantry-cli-instances-env-'))
  try {
    const { logs, restore } = captureLog()
    try {
      await withEnv({ GANTRY_INSTANCES_DIR: tmp }, async () => {
        await program.parseAsync(['node', 'gantry.js', 'instances'])
      })
      assert.ok(logs.some(l => l.includes('No instances found.')))
    } finally { restore() }
    // also test --json on empty dir emits []
    const { logs: logs2, restore: restore2 } = captureLog()
    try {
      await withEnv({ GANTRY_INSTANCES_DIR: tmp }, async () => {
        await program.parseAsync(['node', 'gantry.js', 'instances', '--json'])
      })
      const combined = logs2.join('\n')
      assert.ok(combined.includes('[]'))
    } finally { restore2() }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('CLI new --instances-dir creates instance in custom dir', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gantry-cli-new-'))
  const origCwd = process.cwd()
  try {
    symlinkSync(resolve('definitions'), join(tmp, 'definitions'))
    process.chdir(tmp)
    const { logs, restore } = captureLog()
    try {
      await withEnv({ GANTRY_INSTANCES_DIR: undefined }, async () => {
        await program.parseAsync(['node', 'gantry.js', 'new', 'design', 'cli-pass-test', '--instances-dir', join(tmp, 'instances')])
      })
      assert.ok(logs.some(l => l.includes('Created instance "cli-pass-test"')))
    } finally { restore() }
    assert.ok(existsSync(join(tmp, 'instances', 'cli-pass-test', 'instance.yaml')))
  } finally {
    try { process.chdir(origCwd) } catch {}
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('CLI status --instances-dir reads from custom dir', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gantry-cli-status-'))
  const origCwd = process.cwd()
  try {
    symlinkSync(resolve('definitions'), join(tmp, 'definitions'))
    const instancesDir = join(tmp, 'instances')
    process.chdir(tmp)
    // create instance first (real lib via CLI)
    const { logs: logsNew, restore: restoreNew } = captureLog()
    try {
      await program.parseAsync(['node', 'gantry.js', 'new', 'design', 'cli-status-test', '--instances-dir', instancesDir])
    } finally { restoreNew() }
    // now status with custom dir (plain)
    const { logs, restore } = captureLog()
    try {
      await program.parseAsync(['node', 'gantry.js', 'status', 'cli-status-test', '--instances-dir', instancesDir])
      assert.ok(logs.some(l => l.includes('cli-status-test')))
    } finally { restore() }
    // status --json with env var (no flag)
    const { logs: logsJson, restore: restoreJson } = captureLog()
    try {
      await withEnv({ GANTRY_INSTANCES_DIR: instancesDir }, async () => {
        await program.parseAsync(['node', 'gantry.js', 'status', 'cli-status-test', '--json'])
      })
      const out = logsJson.join('\n')
      const parsed = JSON.parse(out)
      assert.equal(parsed.slug, 'cli-status-test')
    } finally { restoreJson() }
  } finally {
    try { process.chdir(origCwd) } catch {}
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('CLI check --instances-dir passes through to checkGate', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gantry-cli-check-'))
  const origCwd = process.cwd()
  const savedExit = process.exitCode
  try {
    symlinkSync(resolve('definitions'), join(tmp, 'definitions'))
    const instancesDir = join(tmp, 'instances')
    process.chdir(tmp)
    const { logs: logsNew, restore: r1 } = captureLog()
    try { await program.parseAsync(['node', 'gantry.js', 'new', 'design', 'cli-check-test', '--instances-dir', instancesDir]) } finally { r1() }
    process.exitCode = undefined
    const { logs, restore } = captureLog()
    try {
      await program.parseAsync(['node', 'gantry.js', 'check', 'cli-check-test', '--instances-dir', instancesDir])
      assert.ok(logs.some(l => l.includes('PASS') || l.includes('FAIL')))
    } finally { restore(); process.exitCode = undefined }
    const { logs: logsJson, restore: r2 } = captureLog()
    try {
      await withEnv({ GANTRY_INSTANCES_DIR: instancesDir }, async () => {
        await program.parseAsync(['node', 'gantry.js', 'check', 'cli-check-test', '--json'])
      })
      const parsed = JSON.parse(logsJson.join('\n'))
      assert.equal(parsed.slug, 'cli-check-test')
    } finally { r2(); process.exitCode = undefined }
  } finally {
    process.exitCode = savedExit
    try { process.chdir(origCwd) } catch {}
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('CLI render --instances-dir --dry-run passes through', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gantry-cli-render-'))
  const origCwd = process.cwd()
  try {
    symlinkSync(resolve('definitions'), join(tmp, 'definitions'))
    // render needs git commit info; make tmp a git repo by symlinking .git
    try { symlinkSync(resolve('.git'), join(tmp, '.git')) } catch {}
    const instancesDir = join(tmp, 'instances')
    process.chdir(tmp)
    const { logs: l1, restore: r1 } = captureLog()
    try { await program.parseAsync(['node', 'gantry.js', 'new', 'design', 'cli-render-test', '--instances-dir', instancesDir]) } finally { r1() }
    const { logs, restore } = captureLog()
    try {
      await program.parseAsync(['node', 'gantry.js', 'render', 'cli-render-test', 'soap', '--dry-run', '--instances-dir', instancesDir])
      assert.ok(logs.some(l => l.length > 0))
    } finally { restore() }
    // via env var without flag
    const { logs: logs2, restore: r2 } = captureLog()
    try {
      await withEnv({ GANTRY_INSTANCES_DIR: instancesDir }, async () => {
        await program.parseAsync(['node', 'gantry.js', 'render', 'cli-render-test', 'soap', '--dry-run'])
      })
      assert.ok(logs2.some(l => l.length > 0))
    } finally { r2() }
  } finally {
    try { process.chdir(origCwd) } catch {}
    rmSync(tmp, { recursive: true, force: true })
  }
})
