// #130: this server warns at startup about every `GANTRY_`-prefixed variable set in its environment
// that it does not read. The failure this replaces is silence — a variable on the wrong one of the two
// processes started fine, logged nothing, and surfaced much later as a symptom pointing somewhere else
// entirely. These tests pin the three cases apart (belongs to the other service / retired name /
// unrecognised), the two hard constraints (never a value, never a blocked startup), and the drift guard
// that keeps the declared list honest against what `src/` actually reads.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  READ_ENV_VARS,
  OTHER_SERVICE_ENV_VARS,
  RETIRED_ENV_VARS,
  unreadEnvVarWarnings,
  warnAboutUnreadEnvVars,
} from '../src/envVarCheck.js'

const PACKAGE_ROOT = new URL('..', import.meta.url).pathname

function captureStderr(fn) {
  const logged = []
  const originalError = console.error
  console.error = (...args) => logged.push(args.join(' '))
  try {
    fn()
  } finally {
    console.error = originalError
  }
  return logged
}

// ---------------------------------------------------------------------------
// Case 1: the variable belongs to the other service. The case that actually bites.
// ---------------------------------------------------------------------------

test('a variable the web server reads is named as belonging to the web server, not merely reported as unknown', () => {
  assert.deepEqual(unreadEnvVarWarnings({ GANTRY_SHARED_WORKSPACE_PATS: '{}' }), [
    'gantry-mcp-server: GANTRY_SHARED_WORKSPACE_PATS is set but this service does not read it — it belongs to the Gantry web server (gantry serve), a separate process. Set it there instead.',
  ])
})

test('every one of the other service\'s variables is recognised as such', () => {
  for (const name of OTHER_SERVICE_ENV_VARS) {
    const [line] = unreadEnvVarWarnings({ [name]: 'x' })
    assert.match(line, /it belongs to the Gantry web server \(gantry serve\), a separate process\. Set it there instead\.$/, name)
  }
})

// ---------------------------------------------------------------------------
// Case 2: a retired name. What an operator upgrading across an alias-free rename hits.
// ---------------------------------------------------------------------------

test('a retired name names the variable that replaced it', () => {
  // The pre-#129 names, still set on this server after an upgrade — the exact thing the alias-free
  // rename would otherwise turn into silent breakage.
  assert.deepEqual(unreadEnvVarWarnings({ ['GANTRY' + '_BASE_URL']: 'https://gantry.example.com' }), [
    'gantry-mcp-server: GANTRY_BASE_URL is set but this service does not read it — that name is retired; it is now GANTRY_MCP_BASE_URL.',
  ])
  assert.deepEqual(unreadEnvVarWarnings({ ['GANTRY' + '_WORKSPACE_PATS']: '{}' }), [
    'gantry-mcp-server: GANTRY_WORKSPACE_PATS is set but this service does not read it — that name is retired; it is now GANTRY_MCP_WORKSPACE_PATS.',
  ])
})

test('a retired name whose replacement lives on the other service says both things', () => {
  assert.deepEqual(unreadEnvVarWarnings({ ['GANTRY_BOOTSTRAP' + '_PATS']: '{}' }), [
    'gantry-mcp-server: GANTRY_BOOTSTRAP_PATS is set but this service does not read it — that name is retired; it is now GANTRY_SHARED_WORKSPACE_PATS, which belongs to the Gantry web server (gantry serve), a separate process.',
  ])
})

test('every retired name is reported as retired rather than as unknown', () => {
  for (const [name, replacement] of Object.entries(RETIRED_ENV_VARS)) {
    const [line] = unreadEnvVarWarnings({ [name]: 'x' })
    assert.ok(line.includes(`that name is retired; it is now ${replacement}`), name)
  }
})

// ---------------------------------------------------------------------------
// Case 3: otherwise unrecognised, with a suggestion when one is close.
// ---------------------------------------------------------------------------

test('a near-miss on a known variable suggests the one that was probably meant', () => {
  assert.deepEqual(unreadEnvVarWarnings({ GANTRY_MCP_ACCESS_TOKENS: 'x' }), [
    'gantry-mcp-server: GANTRY_MCP_ACCESS_TOKENS is set but this service does not read it — did you mean GANTRY_MCP_ACCESS_TOKEN?',
  ])
  assert.deepEqual(unreadEnvVarWarnings({ GANTRY_MCP_BASEURL: 'x' }), [
    'gantry-mcp-server: GANTRY_MCP_BASEURL is set but this service does not read it — did you mean GANTRY_MCP_BASE_URL?',
  ])
})

test('a variable that resembles nothing known gets a plain note and no invented suggestion', () => {
  assert.deepEqual(unreadEnvVarWarnings({ GANTRY_TEAM_DEPLOY_CHANNEL_WEBHOOK: 'x' }), [
    'gantry-mcp-server: GANTRY_TEAM_DEPLOY_CHANNEL_WEBHOOK is set but this service does not read it.',
  ])
})

// ---------------------------------------------------------------------------
// The hard constraints.
// ---------------------------------------------------------------------------

test('a correctly configured deployment produces no output at all', () => {
  const env = { PATH: '/usr/bin', NODE_ENV: 'production', PORT: '3100', SOME_OTHER_TOOL_TOKEN: 'x' }
  for (const name of READ_ENV_VARS) env[name] = 'configured'
  assert.deepEqual(captureStderr(() => warnAboutUnreadEnvVars(env)), [])
})

test('no variable\'s value is ever printed — names only', () => {
  const secret = 'glpat-THIS-IS-A-REAL-LOOKING-SECRET-0123456789'
  const env = {
    GANTRY_SHARED_WORKSPACE_PATS: JSON.stringify({ 'ws-1': secret }),
    ['GANTRY' + '_WORKSPACE_PATS']: JSON.stringify({ 'ws-2': secret }),
    GANTRY_MCP_ACCESS_TOKENS: secret,
    GANTRY_TEAM_DEPLOY_CHANNEL_WEBHOOK: secret,
    // A read variable holding a credential must not be printed either — it produces no line at all.
    GANTRY_MCP_ACCESS_TOKEN: secret,
  }
  const logged = captureStderr(() => warnAboutUnreadEnvVars(env))
  assert.equal(logged.length, 4)
  assert.ok(!logged.join('\n').includes(secret), 'a variable value reached the warning output')
  assert.ok(!logged.join('\n').includes('glpat'), 'a fragment of a variable value reached the warning output')
})

test('a hostile environment cannot break startup', () => {
  // Inherited-property and odd-shaped environments must degrade to "no warnings", never to a throw:
  // a startup diagnostic that can itself fail startup is worse than no diagnostic.
  assert.doesNotThrow(() => warnAboutUnreadEnvVars(null))
  assert.deepEqual(captureStderr(() => warnAboutUnreadEnvVars(Object.create({ GANTRY_INHERITED: 'x' }))), [])
})

test('the real server still starts, and listens, with several unrecognised variables set', async () => {
  // End-to-end rather than unit: the acceptance criterion is about a deployment booting, so this runs
  // the actual entry point with a deliberately messy environment and waits for it to listen.
  const secret = 'glpat-SPAWNED-PROCESS-SECRET-9876543210'
  const child = spawn(process.execPath, [join(PACKAGE_ROOT, 'src', 'index.js')], {
    env: {
      PATH: process.env.PATH,
      PORT: '0',
      GANTRY_MCP_BASE_URL: 'https://gantry.example.com',
      GANTRY_MCP_ACCESS_TOKEN: 'a-token',
      GANTRY_SHARED_WORKSPACE_PATS: JSON.stringify({ 'ws-1': secret }),
      ['GANTRY' + '_BASE_URL']: 'https://gantry.example.com',
      GANTRY_SOMETHING_ENTIRELY_OURS: secret,
      GANTRY_ANOTHER_ONE_OF_OURS: '2',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server never listened. stdout: ${stdout} stderr: ${stderr}`)), 10_000)
      child.stdout.on('data', () => {
        if (stdout.includes('listening on')) {
          clearTimeout(timer)
          resolve()
        }
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`server exited with code ${code}. stderr: ${stderr}`))
      })
    })
  } finally {
    child.kill()
  }

  assert.ok(stderr.includes('GANTRY_SHARED_WORKSPACE_PATS is set but this service does not read it'))
  assert.ok(stderr.includes('that name is retired; it is now GANTRY_MCP_BASE_URL'))
  assert.ok(stderr.includes('GANTRY_SOMETHING_ENTIRELY_OURS is set but this service does not read it'))
  assert.ok(stderr.includes('GANTRY_ANOTHER_ONE_OF_OURS is set but this service does not read it'))
  assert.ok(!`${stdout}${stderr}`.includes(secret), 'a variable value reached the process output')
})

// ---------------------------------------------------------------------------
// Drift guard: the declared list is held against what `src/` actually reads, so a variable added
// (or removed) later cannot silently fall out of the check. The main package's
// `tests/envVarCheck.test.js` holds the two packages' copies of these tables to each other.
// ---------------------------------------------------------------------------

function walkFiles(path) {
  const stat = statSync(path)
  if (stat.isFile()) return [path]
  if (!stat.isDirectory()) return []
  return readdirSync(path).flatMap((entry) => walkFiles(join(path, entry)))
}

test('READ_ENV_VARS matches every GANTRY_ variable src/ actually reads', () => {
  const found = new Set()
  for (const file of walkFiles(join(PACKAGE_ROOT, 'src'))) {
    if (!file.endsWith('.js')) continue
    for (const match of readFileSync(file, 'utf8').matchAll(/process\.env\.(GANTRY_[A-Z0-9_]+)/g)) found.add(match[1])
  }
  assert.deepEqual([...found].sort(), [...READ_ENV_VARS].sort())
})

test('no variable is both read here and claimed to belong to the other service', () => {
  const read = new Set(READ_ENV_VARS)
  assert.deepEqual(OTHER_SERVICE_ENV_VARS.filter((name) => read.has(name)), [])
  assert.deepEqual(Object.keys(RETIRED_ENV_VARS).filter((name) => read.has(name)), [])
})

test('every retired name\'s replacement is a variable one of the two services actually reads', () => {
  const live = new Set([...READ_ENV_VARS, ...OTHER_SERVICE_ENV_VARS])
  for (const [name, replacement] of Object.entries(RETIRED_ENV_VARS)) {
    assert.ok(live.has(replacement), `${name} points at ${replacement}, which no service reads`)
  }
})
