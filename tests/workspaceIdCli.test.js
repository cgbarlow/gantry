// #115 (parent #109): `gantry workspace-id` prints the workspace id `GANTRY_SHARED_WORKSPACE_PATS` and
// `GANTRY_WORKSPACE_PATS` are keyed by, without booting a server first.
//
// The load-bearing test in this file is "CLI and applyBootstrapWorkspaces agree" below: the whole
// value of the command is that the id it prints is the id the server actually registers, so that one
// asserts both code paths against each other for the same declaration rather than against a
// hard-coded UUID either side could drift away from independently.
//
// Every case drives the real CLI as a subprocess with an injected env (the same style
// tests/gantry-cli.test.js uses for its `--version`/symlink cases) rather than in-process
// `program.parseAsync`: the fail-loud path this ticket specifies ends in `process.exit(1)`, which
// in-process would take the test runner down with it, and a subprocess is also the only way to assert
// on the exit code and stderr an operator actually sees.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { parseBootstrapWorkspaces, applyBootstrapWorkspaces } from '../lib/workspaceBootstrap.js'
import { createServer } from '../lib/server.js'
import { withScratchInstances } from './helpers/lifecycle.js'

const CLI = resolve('bin/gantry.js')

/** This process's env with every env var this command reads cleared first, then `env` applied — so a
 * case that doesn't name GANTRY_BOOTSTRAP_WORKSPACES really is running without one, whatever the shell
 * that started the test run happened to export. */
function childEnv(env) {
  const merged = { ...process.env }
  delete merged.GANTRY_BOOTSTRAP_WORKSPACES
  delete merged.GANTRY_SHARED_WORKSPACE_PATS
  return { ...merged, ...env }
}

/** Runs `gantry <args>` in a child process and returns its trimmed stdout. Throws (failing the test)
 * on a non-zero exit — the success-path helper. */
function runCli(args, env = {}) {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: childEnv(env) }).trim()
}

/** The failure-path counterpart: never throws, so a test can assert on the exit code and stderr. */
function runCliExpectingFailure(args, env = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: childEnv(env) })
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
}

// One declaration per provider, each exercising that provider's own required location fields
// (lib/provider.js's LOCATION_SCHEMA) — the explicit-location mode has to work for all four, not just
// the GitHub shape every other bootstrap example in this codebase happens to use.
const PROVIDER_CASES = [
  {
    provider: 'azure-devops',
    location: { organization: 'contoso', project: 'Platform', repository: 'delivery' },
    args: ['--provider', 'azure-devops', '--organization', 'contoso', '--project', 'Platform', '--repository', 'delivery'],
  },
  {
    provider: 'github',
    location: { owner: 'cgbarlow', repository: 'gantry-workspace-testing' },
    args: ['--provider', 'github', '--owner', 'cgbarlow', '--repository', 'gantry-workspace-testing'],
  },
  {
    provider: 'gitlab',
    location: { namespace: 'acme/platform/sub', repository: 'delivery' },
    args: ['--provider', 'gitlab', '--namespace', 'acme/platform/sub', '--repository', 'delivery'],
  },
  {
    provider: 'atlassian',
    location: { owner: 'acme', repository: 'delivery', jiraSite: 'acme.atlassian.net', jiraProjectKey: 'ACME' },
    args: [
      '--provider',
      'atlassian',
      '--owner',
      'acme',
      '--repository',
      'delivery',
      '--jira-site',
      'acme.atlassian.net',
      '--jira-project-key',
      'ACME',
    ],
  },
]

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// ---------------------------------------------------------------------------------------------
// The one that matters: the CLI and the boot path can never drift apart.
// ---------------------------------------------------------------------------------------------

test('the id the CLI prints is byte-identical to the id applyBootstrapWorkspaces registers', async () => {
  for (const { provider, location, args } of PROVIDER_CASES) {
    // A fresh registry per declaration, so every id below is one this run actually just registered —
    // never a leftover from an earlier case or an earlier test run.
    await withScratchInstances(async (instancesDir) => {
      const declaration = { provider, location, owner: 'c.barlow' }
      const raw = JSON.stringify([declaration])

      const [registered] = applyBootstrapWorkspaces(parseBootstrapWorkspaces(raw), { instancesDir })

      // 1. Explicit-location mode: the id an operator gets from typing the location by hand.
      assert.equal(runCli(['workspace-id', ...args]), registered.id, `explicit mode disagrees for ${provider}`)

      // 2. Declarations mode: the id an operator gets from the very env var the server parsed above.
      const [printedId] = runCli(['workspace-id'], { GANTRY_BOOTSTRAP_WORKSPACES: raw }).split(/\s+/)
      assert.equal(printedId, registered.id, `env-var mode disagrees for ${provider}`)

      // 3. --json mode: the key of the GANTRY_SHARED_WORKSPACE_PATS skeleton is that same id, so the map an
      //    operator pastes is keyed by what the server will look up.
      const skeleton = JSON.parse(runCli(['workspace-id', '--json'], { GANTRY_BOOTSTRAP_WORKSPACES: raw }))
      assert.deepEqual(Object.keys(skeleton), [registered.id], `--json mode disagrees for ${provider}`)
    })
  }
})

test('CLI and boot agree on a declaration carrying an explicit id, which overrides the derived one', async () => {
  // applyBootstrapWorkspaces honours a declaration's own `id` over the derived one — so the CLI has to
  // honour it too, or an operator pinning an id would be handed a key the server never uses.
  await withScratchInstances(async (instancesDir) => {
    const pinned = '11111111-2222-4333-8444-555555555555'
    const raw = JSON.stringify([{ provider: 'github', location: PROVIDER_CASES[1].location, id: pinned }])
    const [registered] = applyBootstrapWorkspaces(parseBootstrapWorkspaces(raw), { instancesDir })
    assert.equal(registered.id, pinned)
    const [printedId] = runCli(['workspace-id'], { GANTRY_BOOTSTRAP_WORKSPACES: raw }).split(/\s+/)
    assert.equal(printedId, pinned)
  })
})

test('the id the CLI prints is the id gantry serve logs and registers at boot', async () => {
  await withScratchInstances(async (instancesDir) => {
    const raw = JSON.stringify([{ provider: 'github', location: PROVIDER_CASES[1].location, owner: 'c.barlow' }])
    const printedId = runCli(['workspace-id'], { GANTRY_BOOTSTRAP_WORKSPACES: raw }).split(/\s+/)[0]

    const logs = []
    const origLog = console.log
    console.log = (...parts) => logs.push(parts.join(' '))
    try {
      createServer({ instancesDir, migrateWorkspacesOnStart: true, bootstrapWorkspaces: raw }).close?.()
    } finally {
      console.log = origLog
    }

    // One line per bootstrapped workspace, naming the location and the id (#115 acceptance criterion).
    const line = logs.find((entry) => entry.includes('bootstrapped workspace'))
    assert.ok(line, `no bootstrap startup log line in: ${JSON.stringify(logs)}`)
    assert.match(line, /cgbarlow\/gantry-workspace-testing/)
    assert.ok(line.includes(printedId), `startup log "${line}" does not name the CLI's id ${printedId}`)
  })
})

// ---------------------------------------------------------------------------------------------
// Explicit-location mode
// ---------------------------------------------------------------------------------------------

test('explicit location mode prints one bare id per provider, and distinct ids per provider', () => {
  const ids = PROVIDER_CASES.map(({ args }) => runCli(['workspace-id', ...args]))
  for (const [index, id] of ids.entries()) {
    assert.match(id, UUID_RE, `${PROVIDER_CASES[index].provider} did not print a bare UUIDv5`)
  }
  assert.equal(new Set(ids).size, ids.length, 'two providers derived the same id')
})

test('explicit location mode defaults to azure-devops when --provider is omitted', () => {
  const withFlag = runCli(['workspace-id', ...PROVIDER_CASES[0].args])
  const withoutFlag = runCli(['workspace-id', '--organization', 'contoso', '--project', 'Platform', '--repository', 'delivery'])
  assert.equal(withoutFlag, withFlag)
})

test('explicit location mode ignores GANTRY_BOOTSTRAP_WORKSPACES entirely', () => {
  const other = JSON.stringify([{ provider: 'github', location: { owner: 'someone', repository: 'else' } }])
  assert.equal(
    runCli(['workspace-id', ...PROVIDER_CASES[1].args], { GANTRY_BOOTSTRAP_WORKSPACES: other }),
    runCli(['workspace-id', ...PROVIDER_CASES[1].args])
  )
})

test('explicit location mode --json emits a one-entry GANTRY_SHARED_WORKSPACE_PATS skeleton', () => {
  const id = runCli(['workspace-id', ...PROVIDER_CASES[1].args])
  const parsed = JSON.parse(runCli(['workspace-id', '--json', ...PROVIDER_CASES[1].args]))
  assert.deepEqual(parsed, { [id]: '' })
})

test('an optional baseUrl is part of the id', () => {
  const bare = runCli(['workspace-id', ...PROVIDER_CASES[1].args])
  const withBaseUrl = runCli(['workspace-id', ...PROVIDER_CASES[1].args, '--base-url', 'https://github.example.com'])
  assert.match(withBaseUrl, UUID_RE)
  assert.notEqual(withBaseUrl, bare)
})

// ---------------------------------------------------------------------------------------------
// GANTRY_BOOTSTRAP_WORKSPACES mode
// ---------------------------------------------------------------------------------------------

test('env var mode prints one id per declaration, in declaration order, id first', () => {
  const raw = JSON.stringify([
    { provider: 'github', location: PROVIDER_CASES[1].location, owner: 'c.barlow' },
    { location: PROVIDER_CASES[0].location },
  ])
  const lines = runCli(['workspace-id'], { GANTRY_BOOTSTRAP_WORKSPACES: raw }).split('\n')
  assert.equal(lines.length, 2)
  assert.equal(lines[0].split(/\s+/)[0], runCli(['workspace-id', ...PROVIDER_CASES[1].args]))
  assert.equal(lines[1].split(/\s+/)[0], runCli(['workspace-id', ...PROVIDER_CASES[0].args]))
  // Each line names the workspace it belongs to, via describeProviderLocation's own formatting.
  assert.match(lines[0], /github cgbarlow\/gantry-workspace-testing$/)
  assert.match(lines[1], /azure-devops contoso\/Platform\/delivery$/)
})

test('env var mode --json emits a GANTRY_SHARED_WORKSPACE_PATS skeleton with empty-string placeholders', () => {
  const raw = JSON.stringify([
    { provider: 'github', location: PROVIDER_CASES[1].location },
    { provider: 'gitlab', location: PROVIDER_CASES[2].location },
  ])
  const parsed = JSON.parse(runCli(['workspace-id', '--json'], { GANTRY_BOOTSTRAP_WORKSPACES: raw }))
  const keys = Object.keys(parsed)
  assert.equal(keys.length, 2)
  for (const key of keys) {
    assert.match(key, UUID_RE)
    assert.equal(parsed[key], '', 'placeholder values must be empty strings for the operator to fill in')
  }
})

test('with no location and no GANTRY_BOOTSTRAP_WORKSPACES, it says so rather than failing', () => {
  const stdout = runCli(['workspace-id'])
  assert.match(stdout, /No workspaces declared in GANTRY_BOOTSTRAP_WORKSPACES/)
  // Still a valid (empty) skeleton in --json mode, so a script piping this never has to special-case it.
  assert.deepEqual(JSON.parse(runCli(['workspace-id', '--json'])), {})
})

// ---------------------------------------------------------------------------------------------
// Fail-loud: one actionable line on stderr, exit 1, no stack trace
// ---------------------------------------------------------------------------------------------

test('an unknown provider fails with one actionable line naming the valid providers', () => {
  const { status, stderr, stdout } = runCliExpectingFailure(['workspace-id', '--provider', 'bitbucket', '--owner', 'a', '--repository', 'b'])
  assert.equal(status, 1)
  assert.equal(stdout, '')
  assert.equal(stderr.split('\n').length, 1, `expected a single line, got: ${stderr}`)
  assert.match(stderr, /Unknown provider "bitbucket" — expected one of: azure-devops, github, gitlab, atlassian/)
})

test('a missing location field fails with one actionable line naming the provider and the field', () => {
  const { status, stderr } = runCliExpectingFailure(['workspace-id', '--provider', 'github', '--owner', 'cgbarlow'])
  assert.equal(status, 1)
  assert.equal(stderr.split('\n').length, 1, `expected a single line, got: ${stderr}`)
  assert.match(stderr, /A github workspace location is missing: repository/)
})

test('--provider with no location at all fails rather than silently reading the env var', () => {
  const raw = JSON.stringify([{ provider: 'github', location: PROVIDER_CASES[1].location }])
  const { status, stderr, stdout } = runCliExpectingFailure(['workspace-id', '--provider', 'github'], {
    GANTRY_BOOTSTRAP_WORKSPACES: raw,
  })
  assert.equal(status, 1)
  assert.equal(stdout, '')
  assert.match(stderr, /--provider "github" needs a location/)
})

test('a malformed GANTRY_BOOTSTRAP_WORKSPACES fails exactly as startup does', () => {
  const cases = [
    { raw: '{not json', pattern: /^GANTRY_BOOTSTRAP_WORKSPACES must be valid JSON:/, fromParser: true },
    { raw: '{"a":1}', pattern: /^GANTRY_BOOTSTRAP_WORKSPACES must be a JSON array of workspace declarations$/, fromParser: true },
    {
      raw: JSON.stringify([{ provider: 'trello', location: { owner: 'a', repository: 'b' } }]),
      pattern: /^GANTRY_BOOTSTRAP_WORKSPACES entry 0 has unknown provider "trello"/,
      fromParser: true,
    },
    {
      raw: JSON.stringify([{ provider: 'github' }]),
      pattern: /^GANTRY_BOOTSTRAP_WORKSPACES entry 0 is missing required field "location"$/,
      fromParser: true,
    },
    {
      // `parseBootstrapWorkspaces` is deliberately shallow and lets this through; deriving the id is
      // what catches it — still one actionable line, still exit 1.
      raw: JSON.stringify([{ provider: 'github', location: { owner: 'cgbarlow' } }]),
      pattern: /is missing: repository$/,
      fromParser: false,
    },
  ]
  for (const { raw, pattern, fromParser } of cases) {
    const { status, stderr, stdout } = runCliExpectingFailure(['workspace-id'], { GANTRY_BOOTSTRAP_WORKSPACES: raw })
    assert.equal(status, 1, `expected exit 1 for ${raw}`)
    assert.equal(stdout, '')
    assert.equal(stderr.split('\n').length, 1, `expected a single line for ${raw}, got: ${stderr}`)
    assert.match(stderr, pattern)
    if (fromParser) {
      // Byte-identical to what the shared parser raises — startup rejects this value with exactly the
      // same sentence, so the CLI is never softening or rewording what `gantry serve` would say.
      assert.throws(
        () => parseBootstrapWorkspaces(raw),
        (err) => {
          assert.equal(stderr, err.message)
          return true
        }
      )
    }
  }
})

test('--json fails the same way on a malformed declaration rather than emitting a partial skeleton', () => {
  const { status, stdout, stderr } = runCliExpectingFailure(['workspace-id', '--json'], {
    GANTRY_BOOTSTRAP_WORKSPACES: JSON.stringify([{ provider: 'trello', location: {} }]),
  })
  assert.equal(status, 1)
  assert.equal(stdout, '')
  assert.match(stderr, /unknown provider "trello"/)
})

// ---------------------------------------------------------------------------------------------
// No PAT, anywhere
// ---------------------------------------------------------------------------------------------

test('no PAT is read, printed, or logged — even with GANTRY_SHARED_WORKSPACE_PATS set in the environment', () => {
  const secret = 'ghp-do-not-print-me-0123456789'
  const raw = JSON.stringify([{ provider: 'github', location: PROVIDER_CASES[1].location }])
  const id = runCli(['workspace-id'], { GANTRY_BOOTSTRAP_WORKSPACES: raw }).split(/\s+/)[0]
  for (const args of [['workspace-id'], ['workspace-id', '--json'], ['workspace-id', ...PROVIDER_CASES[1].args]]) {
    const stdout = runCli(args, {
      GANTRY_BOOTSTRAP_WORKSPACES: raw,
      GANTRY_SHARED_WORKSPACE_PATS: JSON.stringify({ [id]: secret }),
      GANTRY_WORKSPACE_PATS: JSON.stringify({ [id]: secret }),
    })
    assert.ok(!stdout.includes(secret), `a PAT leaked into: ${stdout}`)
    assert.ok(!stdout.includes('pat'), `output mentions a PAT: ${stdout}`)
  }
  // The command's own source never reaches for a PAT env var either.
  const help = execFileSync(process.execPath, [CLI, 'workspace-id', '--help'], { encoding: 'utf8' })
  assert.ok(!/GANTRY_SHARED_WORKSPACE_PATS='?\{/.test(help))
  assert.match(help, /No PAT is ever read, printed, or logged/)
})

test("--help explains what the id is for and which env vars are keyed by it", () => {
  const help = execFileSync(process.execPath, [CLI, 'workspace-id', '--help'], { encoding: 'utf8' })
  assert.match(help, /GANTRY_SHARED_WORKSPACE_PATS/)
  assert.match(help, /GANTRY_WORKSPACE_PATS/)
  assert.match(help, /GANTRY_BOOTSTRAP_WORKSPACES/)
  // Honest about the one case where a running server's stored id differs from the derived one.
  assert.match(help, /keeps whatever id it was first registered under/)
  for (const provider of ['azure-devops', 'github', 'gitlab', 'atlassian']) {
    assert.match(help, new RegExp(provider))
  }
})
