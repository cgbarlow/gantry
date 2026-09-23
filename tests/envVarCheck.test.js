// #130: the Gantry web server warns at startup about every `GANTRY_`-prefixed variable set in its
// environment that it does not read. The failure this replaces is silence — an operator set
// `GANTRY_WORKSPACE_PATS` on the web service, which never read it, and the symptom surfaced hours later
// somewhere entirely unrelated. These tests pin the three cases apart (belongs to the other service /
// retired name / unrecognised), the two hard constraints (never a value, never a blocked startup), and
// the drift guards that keep the declared lists honest against what the code actually reads.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  READ_ENV_VARS,
  OTHER_SERVICE_ENV_VARS,
  RETIRED_ENV_VARS,
  unreadEnvVarWarnings,
  warnAboutUnreadEnvVars,
} from '../lib/envVarCheck.js'
import { createServer } from '../lib/server.js'
import * as mcpEnvVarCheck from '../mcp-server/src/envVarCheck.js'

const REPO_ROOT = new URL('..', import.meta.url).pathname

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

test('a variable the MCP server reads is named as belonging to the MCP server, not merely reported as unknown', () => {
  assert.deepEqual(unreadEnvVarWarnings({ GANTRY_MCP_WORKSPACE_PATS: '{}' }), [
    'gantry serve: GANTRY_MCP_WORKSPACE_PATS is set but this service does not read it — it belongs to the Gantry MCP server, a separate process. Set it there instead.',
  ])
})

test('every one of the other service\'s variables is recognised as such', () => {
  for (const name of OTHER_SERVICE_ENV_VARS) {
    const [line] = unreadEnvVarWarnings({ [name]: 'x' })
    assert.match(line, /it belongs to the Gantry MCP server, a separate process\. Set it there instead\.$/, name)
  }
})

// ---------------------------------------------------------------------------
// Case 2: a retired name. What an operator upgrading across an alias-free rename hits.
// ---------------------------------------------------------------------------

test('a retired name names the variable that replaced it', () => {
  assert.deepEqual(unreadEnvVarWarnings({ ['GANTRY_BOOTSTRAP' + '_PATS']: '{}' }), [
    'gantry serve: GANTRY_BOOTSTRAP_PATS is set but this service does not read it — that name is retired; it is now GANTRY_SHARED_WORKSPACE_PATS.',
  ])
})

test('a retired name whose replacement lives on the other service says both things', () => {
  // The exact mistake that motivated this ticket, as an upgrading operator now hits it: the pre-#129
  // name, set on the web service, which neither reads it nor is where its replacement belongs.
  assert.deepEqual(unreadEnvVarWarnings({ ['GANTRY' + '_WORKSPACE_PATS']: '{}' }), [
    'gantry serve: GANTRY_WORKSPACE_PATS is set but this service does not read it — that name is retired; it is now GANTRY_MCP_WORKSPACE_PATS, which belongs to the Gantry MCP server, a separate process.',
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
  assert.deepEqual(unreadEnvVarWarnings({ GANTRY_SHARED_WORKSPACE_PAT: '{}' }), [
    'gantry serve: GANTRY_SHARED_WORKSPACE_PAT is set but this service does not read it — did you mean GANTRY_SHARED_WORKSPACE_PATS?',
  ])
  assert.deepEqual(unreadEnvVarWarnings({ GANTRY_DEBUGG: '1' }), [
    'gantry serve: GANTRY_DEBUGG is set but this service does not read it — did you mean GANTRY_DEBUG?',
  ])
})

test('a variable that resembles nothing known gets a plain note and no invented suggestion', () => {
  assert.deepEqual(unreadEnvVarWarnings({ GANTRY_TEAM_DEPLOY_CHANNEL_WEBHOOK: 'x' }), [
    'gantry serve: GANTRY_TEAM_DEPLOY_CHANNEL_WEBHOOK is set but this service does not read it.',
  ])
})

// ---------------------------------------------------------------------------
// The hard constraints.
// ---------------------------------------------------------------------------

test('a correctly configured deployment produces no output at all', () => {
  const env = { PATH: '/usr/bin', NODE_ENV: 'production', PORT: '3000', SOME_OTHER_TOOL_TOKEN: 'x' }
  for (const name of READ_ENV_VARS) env[name] = 'configured'
  assert.deepEqual(captureStderr(() => warnAboutUnreadEnvVars(env)), [])
})

test('no variable\'s value is ever printed — names only', () => {
  const secret = 'glpat-THIS-IS-A-REAL-LOOKING-SECRET-0123456789'
  const env = {
    GANTRY_MCP_WORKSPACE_PATS: JSON.stringify({ 'ws-1': secret }),
    ['GANTRY' + '_WORKSPACE_PATS']: JSON.stringify({ 'ws-2': secret }),
    GANTRY_SHARED_WORKSPACE_PAT: secret,
    GANTRY_TEAM_DEPLOY_CHANNEL_WEBHOOK: secret,
    // A read variable holding a credential must not be printed either — it produces no line at all.
    GANTRY_LIBRARY_PAT: secret,
  }
  const logged = captureStderr(() => warnAboutUnreadEnvVars(env))
  assert.equal(logged.length, 4)
  assert.ok(!logged.join('\n').includes(secret), 'a variable value reached the warning output')
  assert.ok(!logged.join('\n').includes('glpat'), 'a fragment of a variable value reached the warning output')
})

test('startup completes normally with several unrecognised variables set, and every one is named', () => {
  const env = {
    GANTRY_MCP_ACCESS_TOKEN: 'tok',
    GANTRY_SOMETHING_ENTIRELY_OURS: '1',
    GANTRY_ANOTHER_ONE_OF_OURS: '2',
    ['GANTRY_BOOTSTRAP' + '_PATS']: '{}',
  }
  let server
  const logged = captureStderr(() => {
    server = createServer({ env })
  })
  assert.ok(server, 'createServer returned no server')
  server.close?.()
  assert.equal(logged.length, 4)
  // Sorted by name, so the output is stable across environments.
  assert.deepEqual(
    logged.map((line) => line.split(' ')[2]),
    ['GANTRY_ANOTHER_ONE_OF_OURS', 'GANTRY_BOOTSTRAP_PATS', 'GANTRY_MCP_ACCESS_TOKEN', 'GANTRY_SOMETHING_ENTIRELY_OURS']
  )
})

test('a hostile environment cannot break startup', () => {
  // Inherited-property and odd-shaped environments must degrade to "no warnings", never to a throw:
  // a startup diagnostic that can itself fail startup is worse than no diagnostic.
  assert.doesNotThrow(() => warnAboutUnreadEnvVars(null))
  assert.doesNotThrow(() => warnAboutUnreadEnvVars(Object.create({ GANTRY_INHERITED: 'x' })))
  assert.deepEqual(captureStderr(() => warnAboutUnreadEnvVars(Object.create({ GANTRY_INHERITED: 'x' }))), [])
})

// ---------------------------------------------------------------------------
// Drift guards: the declared lists are held against what the code actually reads, so a variable
// added (or removed) later cannot silently fall out of the check.
// ---------------------------------------------------------------------------

function walkFiles(path) {
  const stat = statSync(path)
  if (stat.isFile()) return [path]
  if (!stat.isDirectory()) return []
  return readdirSync(path).flatMap((entry) => walkFiles(join(path, entry)))
}

function envVarsReadIn(roots) {
  const found = new Set()
  for (const root of roots) {
    for (const file of walkFiles(join(REPO_ROOT, root))) {
      if (!file.endsWith('.js')) continue
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/process\.env\.(GANTRY_[A-Z0-9_]+)/g)) found.add(match[1])
    }
  }
  return [...found].sort()
}

test('READ_ENV_VARS matches every GANTRY_ variable lib/ and bin/ actually read', () => {
  assert.deepEqual(envVarsReadIn(['lib', 'bin']), [...READ_ENV_VARS].sort())
})

test('the MCP package\'s READ_ENV_VARS matches every GANTRY_ variable its own src/ actually reads', () => {
  assert.deepEqual(envVarsReadIn(['mcp-server/src']), [...mcpEnvVarCheck.READ_ENV_VARS].sort())
})

test('the two packages\' copies of the check agree about who reads what', () => {
  // `lib/envVarCheck.js` and `mcp-server/src/envVarCheck.js` are deliberately duplicated rather than
  // shared (the packages do not import across each other at runtime — see `lib/workspaceBootstrap.js`).
  // This test is the seam that keeps the duplication honest: each service's "belongs to the other
  // service" list must be exactly the other service's read set, or a misplaced variable gets reported
  // as merely unknown by the service it was misplaced on. Importing across packages is safe here
  // precisely because it is a test: it adds no runtime dependency in either direction.
  assert.deepEqual([...mcpEnvVarCheck.OTHER_SERVICE_ENV_VARS].sort(), [...READ_ENV_VARS].sort())
  assert.deepEqual([...OTHER_SERVICE_ENV_VARS].sort(), [...mcpEnvVarCheck.READ_ENV_VARS].sort())
  assert.deepEqual(mcpEnvVarCheck.RETIRED_ENV_VARS, RETIRED_ENV_VARS)
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
