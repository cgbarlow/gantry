import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerInstance } from '../lib/instanceRegistry.js'
import { loadDefinition } from '../lib/definition.js'
import { createGitHubClient } from '../lib/githubClient.js'
import { resolveGitHubStageBranch } from '../lib/githubStageBranch.js'
import {
  withRunningServerForProvider,
  GITHUB_OWNER,
  GITHUB_REPOSITORY,
  GITHUB_VALID_PAT,
} from './helpers/lifecycle.js'
import { exampleModuleText } from './helpers/fixtureModules.js'

// #13, ADR-0037/0040 — GitHub PR-gated sign-off (and re-open): the GitHub twin of
// tests/serverStageApproval.test.js / tests/serverStageStatus.test.js / tests/serverStageReopen.test.js,
// parameterizing the same three routes (POST /api/instance/request-approval,
// POST /api/instance/check-status, POST /api/instance/stage/reopen) against a real fake GitHub server
// instead, per #1's Testing Decisions ("parameterize the existing server route suites over both
// providers"). Where behaviour genuinely diverges — GitHub review states instead of Azure DevOps
// reviewer votes, a merge-commit-only completion, a verbatim branch-protection refusal — that's its
// own explicit assertion here, mirroring tests/githubStageApproval.test.js's own lib-level coverage
// one HTTP hop out.

// Every test below needs its own scratch instance registry — `withRunningServerForProvider` defaults
// to no `instancesDir` (a real deployment's own default), which would otherwise accumulate this same
// slug's registration across runs into an "ambiguous slug" failure — the same reason
// tests/serverGitHubWorkItems.test.js's own `withScratchGitHubServer` helper exists.
function withScratchGitHubServer(fn, { fakeServerOptions } = {}) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  return withRunningServerForProvider(
    'github',
    { options: { instancesDir }, fakeServerOptions },
    (ctx) => fn({ ...ctx, instancesDir })
  ).finally(() => rmSync(instancesDir, { recursive: true, force: true }))
}

const SLUG = 'remote-github-initiative'
const definition = loadDefinition('design')
const [SHAPE] = definition.stages
const authHeader = { Authorization: `Basic ${Buffer.from(`:${GITHUB_VALID_PAT}`, 'utf8').toString('base64')}` }

function githubBearer() {
  return { Authorization: `Bearer ${GITHUB_VALID_PAT}`, 'Content-Type': 'application/json' }
}

async function fillShapeStage(github, branch) {
  const client = createGitHubClient(github)
  for (const moduleId of ['background', 'introduction', 'design-basis', 'solution-definition', 'team-and-estimates']) {
    await client.writeFile(`gantry-workspace/${SLUG}/modules/${moduleId}.md`, exampleModuleText(moduleId), { branch })
  }
  await client.writeFile(`gantry-workspace/${SLUG}/out/Remote Github Initiative - Solution on a Page.docx`, 'rendered soap', { branch })
}

function seedFiles() {
  return { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: shape\ndefinitionVersion: 2\n` }
}

test('POST /api/instance/request-approval (GitHub workspace) opens a Pull Request once the gate has passed, and GET /api/instance reflects it', async () => {
  await withScratchGitHubServer(
    async ({ gantryBase, providerBaseUrl, instancesDir }) => {
      registerInstance(SLUG, { kind: 'github', owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: providerBaseUrl }, { instancesDir })
      const github = { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl: providerBaseUrl }
      const branch = await resolveGitHubStageBranch(github, definition, SLUG, SHAPE.id)
      await fillShapeStage(github, branch)

      const res = await fetch(`${gantryBase}/api/instance/request-approval?slug=${SLUG}`, {
        method: 'POST',
        headers: authHeader,
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.stage.id, 'shape')
      assert.equal(body.branch, branch)
      assert.equal(typeof body.pullRequestId, 'number')
      assert.equal(body.status, 'active')

      const after = await (await fetch(`${gantryBase}/api/instance?slug=${SLUG}`, { headers: authHeader })).json()
      assert.equal(after.pullRequests.shape, body.pullRequestId)

      // A second request for the same stage is a genuine conflict, not a silent no-op.
      const second = await fetch(`${gantryBase}/api/instance/request-approval?slug=${SLUG}`, { method: 'POST', headers: authHeader })
      assert.equal(second.status, 400)
      const secondBody = await second.json()
      assert.match(secondBody.error, /already has a Pull Request/)
    },
    { fakeServerOptions: { files: seedFiles() } }
  )
})

test('POST /api/instance/request-approval (GitHub workspace) with no PAT returns the structured "authentication required" response naming GitHub', async () => {
  await withScratchGitHubServer(
    async ({ gantryBase, providerBaseUrl, instancesDir }) => {
      registerInstance(SLUG, { kind: 'github', owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: providerBaseUrl }, { instancesDir })

      const res = await fetch(`${gantryBase}/api/instance/request-approval?slug=${SLUG}`, { method: 'POST' })
      assert.equal(res.status, 401)
      const body = await res.json()
      assert.equal(body.error, 'authentication_required')
      assert.match(body.message, /GitHub Personal Access Token/)
    },
    { fakeServerOptions: { files: seedFiles() } }
  )
})

test('POST /api/instance/check-status (GitHub workspace) distinguishes approval, changes-requested and no-review, then merges on approval and advances the stage', async () => {
  await withScratchGitHubServer(
    async ({ gantryBase, providerBaseUrl, instancesDir }) => {
      registerInstance(SLUG, { kind: 'github', owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: providerBaseUrl }, { instancesDir })
      const github = { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl: providerBaseUrl }
      const branch = await resolveGitHubStageBranch(github, definition, SLUG, SHAPE.id)
      await fillShapeStage(github, branch)

      const opened = await (
        await fetch(`${gantryBase}/api/instance/request-approval?slug=${SLUG}`, { method: 'POST', headers: authHeader })
      ).json()
      const pullRequestId = opened.pullRequestId

      const pending = await (
        await fetch(`${gantryBase}/api/instance/check-status?slug=${SLUG}`, { method: 'POST', headers: authHeader })
      ).json()
      assert.equal(pending.review.state, 'pending')
      assert.equal(pending.merged, false)

      await fetch(`${providerBaseUrl}/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/pulls/${pullRequestId}/reviews`, {
        method: 'POST',
        headers: githubBearer(),
        body: JSON.stringify({ event: 'REQUEST_CHANGES' }),
      })
      const changesRequested = await (
        await fetch(`${gantryBase}/api/instance/check-status?slug=${SLUG}`, { method: 'POST', headers: authHeader })
      ).json()
      assert.equal(changesRequested.review.state, 'changes-requested')
      assert.equal(changesRequested.merged, false)

      await fetch(`${providerBaseUrl}/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/pulls/${pullRequestId}/reviews`, {
        method: 'POST',
        headers: githubBearer(),
        body: JSON.stringify({ event: 'APPROVE' }),
      })
      const approved = await (
        await fetch(`${gantryBase}/api/instance/check-status?slug=${SLUG}`, { method: 'POST', headers: authHeader })
      ).json()
      assert.equal(approved.review.state, 'approved')
      assert.equal(approved.merged, true)
      assert.ok(approved.advancedTo)
      assert.notEqual(approved.advancedTo.id, SHAPE.id)

      const instance = await (await fetch(`${gantryBase}/api/instance?slug=${SLUG}`, { headers: authHeader })).json()
      assert.equal(instance.currentStageId, approved.advancedTo.id)
    },
    { fakeServerOptions: { files: seedFiles() } }
  )
})

test('POST /api/instance/check-status (GitHub workspace) surfaces a branch-protection merge refusal verbatim, without advancing', async () => {
  await withScratchGitHubServer(
    async ({ gantryBase, providerBaseUrl, instancesDir }) => {
      registerInstance(SLUG, { kind: 'github', owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: providerBaseUrl }, { instancesDir })
      const github = { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl: providerBaseUrl }
      const branch = await resolveGitHubStageBranch(github, definition, SLUG, SHAPE.id)
      await fillShapeStage(github, branch)

      const opened = await (
        await fetch(`${gantryBase}/api/instance/request-approval?slug=${SLUG}`, { method: 'POST', headers: authHeader })
      ).json()

      await fetch(`${providerBaseUrl}/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/pulls/${opened.pullRequestId}/reviews`, {
        method: 'POST',
        headers: githubBearer(),
        body: JSON.stringify({ event: 'APPROVE' }),
      })

      const res = await fetch(`${gantryBase}/api/instance/check-status?slug=${SLUG}`, { method: 'POST', headers: authHeader })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(body.error, /approving review/)

      const instance = await (await fetch(`${gantryBase}/api/instance?slug=${SLUG}`, { headers: authHeader })).json()
      assert.equal(instance.currentStageId, SHAPE.id)
    },
    {
      fakeServerOptions: {
        files: seedFiles(),
        mergeRefusal: { status: 405, message: 'At least 1 approving review is required by reviewers with write access.' },
      },
    }
  )
})

test('POST /api/instance/stage/reopen (GitHub workspace) re-opens a completed stage: branch recreated from main, stage moved back, reopened marker set', async () => {
  await withScratchGitHubServer(
    async ({ gantryBase, providerBaseUrl, instancesDir }) => {
      registerInstance(SLUG, { kind: 'github', owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: providerBaseUrl }, { instancesDir })
      const github = { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl: providerBaseUrl }
      const branch = await resolveGitHubStageBranch(github, definition, SLUG, SHAPE.id)
      await fillShapeStage(github, branch)

      const opened = await (
        await fetch(`${gantryBase}/api/instance/request-approval?slug=${SLUG}`, { method: 'POST', headers: authHeader })
      ).json()
      await fetch(`${providerBaseUrl}/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/pulls/${opened.pullRequestId}/reviews`, {
        method: 'POST',
        headers: githubBearer(),
        body: JSON.stringify({ event: 'APPROVE' }),
      })
      const merged = await (
        await fetch(`${gantryBase}/api/instance/check-status?slug=${SLUG}`, { method: 'POST', headers: authHeader })
      ).json()
      assert.equal(merged.merged, true)

      // Our fake, like the Azure DevOps one, never auto-deletes a merged source branch — simulate
      // the "a stage branch was cleaned up after merge" precondition reopen assumes, the same way
      // tests/serverStageReopen.test.js deletes the Azure DevOps ref directly.
      await fetch(`${providerBaseUrl}/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/git/refs/heads/${encodeURIComponent(branch)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${GITHUB_VALID_PAT}` },
      })

      const reopenRes = await fetch(`${gantryBase}/api/instance/stage/reopen?slug=${SLUG}&stage=shape`, {
        method: 'POST',
        headers: authHeader,
      })
      assert.equal(reopenRes.status, 200)
      const reopenBody = await reopenRes.json()
      assert.equal(reopenBody.branch, branch)
      assert.ok(reopenBody.reopened.shape)

      const instance = await (await fetch(`${gantryBase}/api/instance?slug=${SLUG}`, { headers: authHeader })).json()
      assert.equal(instance.currentStageId, 'shape')
    },
    { fakeServerOptions: { files: seedFiles() } }
  )
})
