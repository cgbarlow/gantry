import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerInstance } from '../lib/instanceRegistry.js'
import { readInstance } from '../lib/instance.js'
import { withRunningServerForProvider, GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT } from './helpers/lifecycle.js'

// #188: an instance's ref (`w<W>i<N>`) used to live only in the server's own number-registry.json —
// on a host whose disk is wiped on every redeploy (the hosted demo), every restart renumbered
// instances in whatever order they were next listed, so a bookmarked ref silently opened a
// different instance. A new instance now records its number in its own instance.yaml, and a
// rebuilt registry claims it back.

const authHeader = { Authorization: `Basic ${Buffer.from(`:${GITHUB_VALID_PAT}`, 'utf8').toString('base64')}` }

test('a GitHub-backed instance keeps its ref after the server loses its number registry', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withRunningServerForProvider(
      'github',
      {
        options: { instancesDir },
        fakeServerOptions: {
          // An instance created before refs were persisted — no `number` in its instance.yaml — whose
          // slug sorts ahead of the new one, so it's listed first after the restart.
          files: { '/gantry-workspace/alpha-legacy/instance.yaml': 'definition: design\nslug: alpha-legacy\nstage: shape\ndefinitionVersion: 2\n' },
        },
      },
      async ({ gantryBase, providerBaseUrl }) => {
        const github = { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: providerBaseUrl }
        registerInstance('alpha-legacy', { kind: 'github', ...github }, { instancesDir })

        const res = await fetch(`${gantryBase}/api/instances`, {
          method: 'POST',
          headers: { ...authHeader, 'Content-Type': 'application/json' },
          body: JSON.stringify({ definition: 'design', slug: 'zeta-new', github }),
        })
        assert.equal(res.status, 201)
        const created = await res.json()
        assert.equal(created.instanceNumber, 2, 'numbered after the workspace it joins was listed')

        const recorded = await readInstance('zeta-new', { github: { ...github, pat: GITHUB_VALID_PAT } })
        assert.equal(recorded.number, 2)

        // The redeploy: the server-side registry is gone.
        rmSync(join(instancesDir, 'number-registry.json'))

        const rows = await (await fetch(`${gantryBase}/api/instances`, { headers: authHeader })).json()
        const zeta = rows.find((r) => r.slug === 'zeta-new')
        const alpha = rows.find((r) => r.slug === 'alpha-legacy')
        assert.equal(zeta.ref, created.ref)
        assert.notEqual(alpha.instanceNumber, zeta.instanceNumber)

        const byRef = await fetch(`${gantryBase}/api/instance?ref=${created.ref}`, { headers: authHeader })
        assert.equal((await byRef.json()).slug, 'zeta-new')
      }
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})
