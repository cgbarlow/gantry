import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAzureDevOpsClient } from '../../lib/azureDevOpsClient.js'
import { createGitHubClient } from '../../lib/githubClient.js'
import { registerInstance } from '../../lib/instanceRegistry.js'
import { launchBrowser, DEFAULT_TIMEOUT } from './launchBrowser.js'
import { GITHUB_OWNER, GITHUB_REPOSITORY, ORGANIZATION, PROJECT, REPOSITORY, basicAuthHeader, withRunningServerForProvider } from './lifecycle.js'
import { seedProviders, trioScript, withFakeAnthropic } from './interviewStandIn.js'
import { writeTrio } from './trioDefinition.js'

// A remote workspace of the small three-Stage Definition (tests/helpers/trioDefinition.js) on a fake Azure DevOps or GitHub, a real gantry
// server and relay, a stand-in for Anthropic, and one page in Chromium that holds the workspace's token and an AI Provider. Shared by the
// remote-session tests (#295, #296). The Owner's approval is cast directly at the Provider, as it is in real life.

export const SLUG = 'remote-trio'
export const ROOT = `gantry-workspace/${SLUG}`
const INSTANCE_YAML = `definition: trio\nslug: ${SLUG}\nstage: s1\ndefinitionVersion: 1\n`
export const json = (method, body, headers = {}) => ({ method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

export const PROVIDERS = [
  {
    name: 'Azure DevOps',
    provider: 'azure-devops',
    kind: 'azureDevOps',
    author: 'Fake Pusher',
    prPath: /\/pullrequest\/\d+$/,
    location: (ctx) => ({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: ctx.providerBaseUrl }),
    client: (ctx) => createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: ctx.pat, baseUrl: ctx.providerBaseUrl }),
    approve: (ctx, pullRequestId) =>
      fetch(`${ctx.providerBaseUrl}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY}/pullrequests/${pullRequestId}/reviewers/owner-1`, {
        method: 'PUT',
        headers: { Authorization: basicAuthHeader(ctx.pat), 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'The Owner', vote: 10 }),
      }),
  },
  {
    name: 'GitHub',
    provider: 'github',
    kind: 'github',
    author: 'Fake Author',
    prPath: /\/pull\/\d+$/,
    location: (ctx) => ({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: ctx.providerBaseUrl }),
    client: (ctx) => createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: ctx.pat, baseUrl: ctx.providerBaseUrl }),
    approve: (ctx, pullRequestId) =>
      fetch(`${ctx.providerBaseUrl}/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/pulls/${pullRequestId}/reviews`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ctx.pat}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'APPROVE' }),
      }),
  },
]

/** Runs `fn` against a remote trio. `shared` mounts a Module in both Scope and Shape (#296); `script` is the stand-in AI's. */
export async function withRemoteTrio(spec, fn, { shared = false, script = trioScript } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-remote-trio-e2e-'))
  const definitionsDir = join(root, 'definitions')
  const instancesDir = join(root, 'instances')
  try {
    writeTrio(definitionsDir, { shared })
    await withFakeAnthropic(script, (aiBase, posts) =>
      withRunningServerForProvider(
        spec.provider,
        { options: { instancesDir, definitionsDir, allowPrivateAiUrls: true }, fakeServerOptions: { files: { [`/${ROOT}/instance.yaml`]: INSTANCE_YAML } } },
        async (ctx) => {
          registerInstance(SLUG, { kind: spec.kind, ...spec.location(ctx) }, { instancesDir })
          const browser = await launchBrowser()
          try {
            const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
            page.setDefaultTimeout(Math.max(DEFAULT_TIMEOUT, 30_000))
            // Leaving a page with unsaved drafts asks first (beforeunload); a test that opens the page again means to leave it.
            page.on('dialog', (dialog) => dialog.accept())
            const pageErrors = []
            page.on('pageerror', (err) => pageErrors.push(err.message))
            const checks = []
            page.on('request', (req) => {
              if (req.url().includes('/api/instance/check-status')) checks.push(req.method())
            })
            await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), ctx.pat)
            await seedProviders(page, aiBase)
            const auth = { Authorization: basicAuthHeader(ctx.pat) }
            const api = (path, init = {}) => fetch(`${ctx.gantryBase}${path}${path.includes('?') ? '&' : '?'}slug=${SLUG}`, { ...init, headers: { ...auth, ...init.headers } })
            await fn({ page, base: ctx.gantryBase, ctx, posts, checks, client: spec.client(ctx), api })
            assert.deepEqual(pageErrors, [])
          } finally {
            await browser.close()
          }
        }
      )
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

export const row = (page, id) => page.locator(`[data-testid="run-plan-row"][data-stage-id="${id}"]`)
export const states = (page) => page.locator('[data-testid="run-plan-row"]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-stage-id')}:${e.getAttribute('data-state')}${e.getAttribute('data-target') === 'true' ? '*' : ''}`))
export const waitState = (page, id, state) => page.waitForSelector(`[data-testid="run-plan-row"][data-stage-id="${id}"][data-state="${state}"]`)
export const pullRequestNumber = async (page) => Number((await page.textContent('[data-testid="interview-pr-link"]')).match(/#(\d+)/)[1])
/** The number of the Pull Request open for `stageId`, once the Provider has it (the page shows "awaiting approval" a moment before the request returns). */
export async function pullRequestOf(api, stageId) {
  for (let i = 0; i < 40; i++) {
    const number = (await (await api('/api/instance')).json()).pullRequests?.[stageId]
    if (number) return number
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`no Pull Request was opened for ${stageId}`)
}
export const open = async (page, base) => {
  await page.goto(`${base}/instance/${SLUG}?interview=1`)
  await page.waitForSelector('[data-testid="interview-page"]')
}
// Kickoff to the first stage-end card of the Stage on the page, for a run until `target`.
export async function draftStage(page, target) {
  await page.waitForSelector('[data-testid="interview-run-until"]')
  if (target) await page.selectOption('[data-testid="interview-run-until"]', target)
  await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
  await page.click('[data-testid="interview-start"]')
  await page.waitForSelector('[data-testid="interview-stage-end"]')
}
