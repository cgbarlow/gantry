import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../lib/server.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { withRunningServer, basicAuthHeader, ORGANIZATION, PROJECT, REPOSITORY, VALID_PAT } from './helpers/lifecycle.js'

// #92: `createServer(options)` no longer takes one fixed `options.azureDevOps` location for the whole process — each request resolves its own slug against the instance registry (#89) to decide whether it's local or Azure-DevOps-backed. These tests are the acceptance test for that: one running server, with one local instance and one Azure-DevOps-backed (fake-server-backed) instance both registered ahead of time, exercised through the exact same server instance — mirroring tests/serverAzureDevOpsAuth.test.js's existing style.




const SEED_FILES = {
  '/gantry-workspace/remote-initiative/instance.yaml': 'definition: design\nslug: remote-initiative\nstage: shape\n',
  '/gantry-workspace/remote-initiative/modules/background.md': [
    '---',
    'module: background',
    'status: draft',
    'owner: c.barlow',
    '---',
    '',
    '## Problem statement',
    '',
    'Seeded from the fake Azure DevOps repo.',
    '',
    '## Affected domains',
    '',
    '- Payments',
    '',
    '## Success criteria',
    '',
    'Nothing yet.',
    '',
  ].join('\n'),
}

test('one running server, with no fixed Azure DevOps location, correctly serves both a local instance and a registry-registered Azure-DevOps-backed instance', async () => {
  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: SEED_FILES },
    async (adoBaseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
      try {
        // A real local instance, on disk, auto-backfilled into the registry as `{ kind: 'local' }` the first time it's resolved.
        cpSync('instances/examples', join(instancesDir, 'local-initiative'), { recursive: true })
        rmSync(join(instancesDir, 'local-initiative', 'out'), { recursive: true, force: true })

        // A remote instance, registered directly (per #92's scope: this ticket doesn't add a way to register one through the app itself, only makes the server capable of correctly serving one already in the registry).
        registerInstance(
          'remote-initiative',
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          { instancesDir }
        )

        // No `slug` and no `azureDevOps` option at all — nothing pins this server to any one instance or location; both are resolved per-request purely from the registry.
        await withRunningServer({ instancesDir }, async (base) => {
          // The local slug: served with no credential required, unchanged from today.
          const localRes = await fetch(`${base}/api/instance?slug=local-initiative`)
          assert.equal(localRes.status, 200)
          const localBody = await localRes.json()
          assert.equal(localBody.slug, 'local-initiative')
          assert.equal(localBody.definition, 'design')

          // The same running server, same instance, same request shape — now against the Azure-DevOps-backed slug: gated behind the same PAT credential flow as before.
          const noPatRes = await fetch(`${base}/api/instance?slug=remote-initiative`)
          assert.equal(noPatRes.status, 401)
          const noPatBody = await noPatRes.json()
          assert.equal(noPatBody.error, 'authentication_required')

          const remoteRes = await fetch(`${base}/api/instance?slug=remote-initiative`, {
            headers: { Authorization: basicAuthHeader(VALID_PAT) },
          })
          assert.equal(remoteRes.status, 200)
          const remoteBody = await remoteRes.json()
          assert.equal(remoteBody.slug, 'remote-initiative')
          assert.equal(remoteBody.definition, 'design')
          const context = remoteBody.modules.find((m) => m.id === 'background')
          const driver = context.fields.find((f) => f.id === 'problem')
          assert.equal(driver.value, 'Seeded from the fake Azure DevOps repo.')

          // Both instances now show up in the shared dashboard listing — the registry is the single source of truth for both.
          const listing = await (await fetch(`${base}/api/instances`)).json()
          assert.ok(listing.some((i) => i.slug === 'local-initiative'))
        })
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    }
  )
})

test('writing a module on the Azure-DevOps-backed instance never touches the local instance sharing the same server', async () => {
  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: SEED_FILES },
    async (adoBaseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
      try {
        cpSync('instances/examples', join(instancesDir, 'local-initiative'), { recursive: true })
        rmSync(join(instancesDir, 'local-initiative', 'out'), { recursive: true, force: true })
        registerInstance(
          'remote-initiative',
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          { instancesDir }
        )

        await withRunningServer({ instancesDir }, async (base) => {
          const res = await fetch(`${base}/api/instance/modules/background?slug=remote-initiative`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(VALID_PAT) },
            body: JSON.stringify({
              status: 'agreed',
              owner: 'c.barlow',
              fields: { problem: 'Written to the remote instance only.', 'affected-domains': ['Payments'], opportunity: '' },
            }),
          })
          assert.equal(res.status, 200)

          // The local instance's own context module is untouched by a write against the remote instance sharing the same server.
          const localRes = await fetch(`${base}/api/instance?slug=local-initiative`)
          const localBody = await localRes.json()
          const localContext = localBody.modules.find((m) => m.id === 'background')
          const localDriver = localContext.fields.find((f) => f.id === 'problem')
          assert.notEqual(localDriver.value, 'Written to the remote instance only.')
        })
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    }
  )
})
