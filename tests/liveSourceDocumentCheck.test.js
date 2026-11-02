import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { runLiveCheck } from '../scripts/live-source-document-check.mjs'
import { MAX_SOURCE_BYTES } from '../web/lib/sourceDocuments.js'
import { withRunningServerForProvider } from './helpers/lifecycle.js'

// #280 criteria 1-3 can only be settled against a REAL GitHub and a REAL Azure DevOps repository (scripts/live-source-document-check.mjs, run by hand with a token). This runs that same script against the fake Provider servers so the script itself is known to work, and to report a failure rather than pass quietly. It says nothing about how fast a real Provider is.

// A real repository has a `main`; the Azure DevOps fake only has one once something is on it.
const SEED = { files: { '/seed/README.md': 'a repository with a main branch\n' } }

const CASES = [
  { name: 'GitHub', provider: 'github', location: (ctx) => ({ owner: ctx.owner, repository: ctx.repository, baseUrl: ctx.providerBaseUrl }) },
  { name: 'Azure DevOps', provider: 'azure-devops', location: (ctx) => ({ organization: ctx.organization, project: ctx.project, repository: ctx.repository, baseUrl: ctx.providerBaseUrl }) },
]

for (const { name, provider, location } of CASES) {
  describe(`live Source documents check, ${name}`, () => {
    test('passes every check at the full 25 MB against a fake Provider', () =>
      withRunningServerForProvider(provider, { fakeServerOptions: provider === 'azure-devops' ? SEED : undefined }, async (ctx) => {
        const result = await runLiveCheck({ provider, location: location(ctx), pat: ctx.pat, cleanup: false })
        assert.equal(result.uploadBytes, MAX_SOURCE_BYTES)
        assert.deepEqual(result.checks.filter((c) => !c.ok), [])
        assert.equal(result.passed, true)
        const names = result.checks.map((c) => c.name)
        for (const wanted of [/25 MB upload finishes within 10 s/, /big upload is exactly one commit/, /rename is exactly one commit/, /extract text again is exactly one commit/, /remove is exactly one commit/, /later Stage's branch carries/]) {
          assert.ok(names.some((n) => wanted.test(n)), `a check matching ${wanted}`)
        }
      }))

    test('reports an upload slower than the limit as a failed check, not a pass', () =>
      withRunningServerForProvider(provider, { fakeServerOptions: provider === 'azure-devops' ? SEED : undefined }, async (ctx) => {
        const result = await runLiveCheck({ provider, location: location(ctx), pat: ctx.pat, cleanup: false, bytes: 1024 * 1024, limitMs: -1 })
        assert.equal(result.passed, false)
        assert.deepEqual(result.checks.filter((c) => !c.ok).map((c) => c.name), ['a 1 MB upload finishes within -0.001 s'])
      }))
  })
}

test('an unknown Provider is a setup error', async () => {
  await assert.rejects(() => runLiveCheck({ provider: 'gitlab', location: {}, pat: 'x' }), /Unknown provider/)
})
