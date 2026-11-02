import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerInstance } from '../lib/instanceRegistry.js'
import { withRunningServerForProvider, basicAuthHeader } from './helpers/lifecycle.js'
import { writeTrio } from './helpers/trioDefinition.js'
import { PROVIDERS, SLUG, ROOT, json } from './helpers/remoteTrio.js'

// #299 (parent #238): GET /api/instance/pull-request-comments reads every comment on the Pull Request open for a Stage, resolved or not, on
// Azure DevOps and GitHub. It reads only; the AI interview never writes to a Pull Request.

const INSTANCE_YAML = `definition: trio\nslug: ${SLUG}\nstage: s1\ndefinitionVersion: 1\n`


async function withTrio(spec, fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-pr-comments-'))
  const definitionsDir = join(root, 'definitions')
  const instancesDir = join(root, 'instances')
  try {
    writeTrio(definitionsDir)
    await withRunningServerForProvider(
      spec.provider,
      { options: { instancesDir, definitionsDir }, fakeServerOptions: { files: { [`/${ROOT}/instance.yaml`]: INSTANCE_YAML } } },
      async (ctx) => {
        registerInstance(SLUG, { kind: spec.kind, ...spec.location(ctx) }, { instancesDir })
        const auth = { Authorization: basicAuthHeader(ctx.pat) }
        const api = (path, init = {}) => fetch(`${ctx.gantryBase}${path}${path.includes('?') ? '&' : '?'}slug=${SLUG}`, { ...init, headers: { ...auth, ...init.headers } })
        await fn({ ctx, api })
      }
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// Saves Scope's one Field and asks for approval, so a Pull Request is open.
async function openScopePullRequest(api) {
  const saved = await api('/api/instance/modules?stage=s1', json('PUT', { modules: { m1: { status: 'draft', owner: '', fields: { body: 'Notes for s1: the agreed position, written out.' } } } }))
  assert.equal(saved.status, 200)
  const asked = await api('/api/instance/request-approval', json('POST', {}))
  assert.equal(asked.status, 200)
  return (await asked.json()).pullRequestId
}

for (const spec of PROVIDERS) {
  test(`${spec.name}: the comments on a Stage's Pull Request come back whole, and reading them writes nothing`, async () => {
    await withTrio(spec, async ({ ctx, api }) => {
      const pullRequestId = await openScopePullRequest(api)
      assert.equal((await spec.comment(ctx, pullRequestId, { body: 'Please name the owner.', author: 'Olivia' })).status < 300, true)
      assert.equal((await spec.comment(ctx, pullRequestId, { body: 'This figure has no source.', author: 'Olivia', resolved: true })).status < 300, true)

      const res = await api('/api/instance/pull-request-comments?stage=s1')
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.deepEqual([body.stage, body.pullRequestId], ['s1', pullRequestId])
      assert.deepEqual(body.comments.map((c) => c.body).sort(), ['Please name the owner.', 'This figure has no source.'])
      assert.ok(body.comments.every((c) => c.author === 'Olivia'))
      const again = await (await api('/api/instance/pull-request-comments')).json() // the current Stage by default
      assert.equal(again.comments.length, 2, 'nothing was written to the Pull Request')
    })
  })

  test(`${spec.name}: a Stage with no Pull Request open has no comments to read, and says so`, async () => {
    await withTrio(spec, async ({ api }) => {
      const res = await api('/api/instance/pull-request-comments?stage=s1')
      assert.equal(res.status, 400)
      assert.match((await res.json()).error, /no Pull Request open for stage "s1"/)
    })
  })
}

test('a local workspace has no Pull Request to read comments from', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gantry-pr-comments-local-'))
  try {
    writeTrio(join(root, 'definitions'))
    const { withRunningServer } = await import('./helpers/lifecycle.js')
    await withRunningServer({ instancesDir: join(root, 'instances'), definitionsDir: join(root, 'definitions') }, async (base) => {
      const res = await fetch(`${base}/api/instance/pull-request-comments?slug=nothing-here`)
      assert.equal(res.status, 400)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
