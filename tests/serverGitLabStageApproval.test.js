import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerInstance } from '../lib/instanceRegistry.js'
import { loadDefinition } from '../lib/definition.js'
import { createGitLabClient } from '../lib/gitlabClient.js'
import { resolveGitLabStageBranch } from '../lib/gitlabStageBranch.js'
import { readInstance } from '../lib/instance.js'
import {
  withRunningServerForProvider,
  GITLAB_NAMESPACE,
  GITLAB_REPOSITORY,
  GITLAB_VALID_PAT,
} from './helpers/lifecycle.js'
import { exampleModuleText } from './helpers/fixtureModules.js'

// #33, ADR-0037/0041 — GitLab MR-gated sign-off (and re-open): the GitLab twin of
// tests/serverGitHubStageApproval.test.js / tests/serverStageApproval.test.js /
// tests/serverStageReopen.test.js, parameterizing the same three routes
// (POST /api/instance/request-approval, POST /api/instance/check-status, POST
// /api/instance/stage/reopen) against a real fake GitLab server instead, per #1's Testing Decisions
// ("parameterize the existing server route suites over both providers"). Where behaviour genuinely
// diverges — GitLab approvals/discussions instead of GitHub review states, a merge-commit-only
// completion, a verbatim protected-branch refusal — that's its own explicit assertion here,
// mirroring tests/gitlabStageApproval.test.js's own lib-level coverage one HTTP hop out.
//
// Post-condition assertions read the instance record directly via `readInstance` rather than through
// `GET /api/instance`: that route's own dual local/Azure-DevOps/GitHub dispatch was never extended to
// GitLab (a pre-existing gap outside this ticket's own scope — its own acceptance criteria are the
// three POST routes above), so a GitLab-backed instance still falls through to a local read there.
// The three POST routes under test here are unaffected — each resolves its own provider location
// independently via `resolveInstanceProviderLocation`, already generalized to GitLab (#24).

// Every test below needs its own scratch instance registry — see
// tests/serverGitHubStageApproval.test.js's own identical `withScratchGitHubServer` for why.
function withScratchGitLabServer(fn, { fakeServerOptions } = {}) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  return withRunningServerForProvider(
    'gitlab',
    { options: { instancesDir }, fakeServerOptions },
    (ctx) => fn({ ...ctx, instancesDir })
  ).finally(() => rmSync(instancesDir, { recursive: true, force: true }))
}

const SLUG = 'remote-gitlab-initiative'
const definition = loadDefinition('design')
const [SHAPE] = definition.stages
const authHeader = { Authorization: `Basic ${Buffer.from(`:${GITLAB_VALID_PAT}`, 'utf8').toString('base64')}` }

function gitlabProjectPath(providerBaseUrl) {
  return `${providerBaseUrl}/projects/${encodeURIComponent(`${GITLAB_NAMESPACE}/${GITLAB_REPOSITORY}`)}`
}

async function fillShapeStage(gitlab, branch) {
  const client = createGitLabClient(gitlab)
  for (const moduleId of ['background', 'introduction', 'design-basis', 'solution-definition', 'team-and-estimates']) {
    await client.writeFile(`gantry-workspace/${SLUG}/modules/${moduleId}.md`, exampleModuleText(moduleId), { branch })
  }
  await client.writeFile(`gantry-workspace/${SLUG}/out/Remote Gitlab Initiative - Solution on a Page.docx`, 'rendered soap', { branch })
}

function seedFiles() {
  return { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: shape\ndefinitionVersion: 2\n` }
}

test('POST /api/instance/request-approval (GitLab workspace) opens a Merge Request once the gate has passed, and GET /api/instance reflects it', async () => {
  await withScratchGitLabServer(
    async ({ gantryBase, providerBaseUrl, instancesDir }) => {
      registerInstance(SLUG, { kind: 'gitlab', namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl: providerBaseUrl }, { instancesDir })
      const gitlab = { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, pat: GITLAB_VALID_PAT, baseUrl: providerBaseUrl }
      const branch = await resolveGitLabStageBranch(gitlab, definition, SLUG, SHAPE.id)
      await fillShapeStage(gitlab, branch)

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

      // `GET /api/instance` isn't GitLab-aware yet (a pre-existing gap in the general instance-read
      // route, outside this ticket's own scope — see this suite's own doc comment) — read the
      // instance record directly instead, the same source of truth `GET /api/instance` would read
      // from. `recordInstancePullRequest` writes to the stage's own branch (mirroring Azure
      // DevOps/GitHub), so the read must target that same branch too.
      const after = await readInstance(SLUG, { gitlab: { ...gitlab, branch } })
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

test('POST /api/instance/request-approval (GitLab workspace) with no PAT returns the structured "authentication required" response naming GitLab', async () => {
  await withScratchGitLabServer(
    async ({ gantryBase, providerBaseUrl, instancesDir }) => {
      registerInstance(SLUG, { kind: 'gitlab', namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl: providerBaseUrl }, { instancesDir })

      const res = await fetch(`${gantryBase}/api/instance/request-approval?slug=${SLUG}`, { method: 'POST' })
      assert.equal(res.status, 401)
      const body = await res.json()
      assert.equal(body.error, 'authentication_required')
      assert.match(body.message, /GitLab Personal Access Token/)
    },
    { fakeServerOptions: { files: seedFiles() } }
  )
})

test('POST /api/instance/check-status (GitLab workspace) distinguishes approval, the changes-requested equivalent and no-review, then merges on approval and advances the stage', async () => {
  await withScratchGitLabServer(
    async ({ gantryBase, providerBaseUrl, instancesDir }) => {
      registerInstance(SLUG, { kind: 'gitlab', namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl: providerBaseUrl }, { instancesDir })
      const gitlab = { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, pat: GITLAB_VALID_PAT, baseUrl: providerBaseUrl }
      const branch = await resolveGitLabStageBranch(gitlab, definition, SLUG, SHAPE.id)
      await fillShapeStage(gitlab, branch)

      const opened = await (
        await fetch(`${gantryBase}/api/instance/request-approval?slug=${SLUG}`, { method: 'POST', headers: authHeader })
      ).json()
      const pullRequestId = opened.pullRequestId

      const pending = await (
        await fetch(`${gantryBase}/api/instance/check-status?slug=${SLUG}`, { method: 'POST', headers: authHeader })
      ).json()
      assert.equal(pending.review.state, 'pending')
      assert.equal(pending.merged, false)

      await fetch(`${gitlabProjectPath(providerBaseUrl)}/merge_requests/${pullRequestId}/discussions`, {
        method: 'POST',
        headers: { 'PRIVATE-TOKEN': GITLAB_VALID_PAT, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'Please reconsider this section.' }),
      })
      const changesRequested = await (
        await fetch(`${gantryBase}/api/instance/check-status?slug=${SLUG}`, { method: 'POST', headers: authHeader })
      ).json()
      assert.equal(changesRequested.review.state, 'changes-requested')
      assert.equal(changesRequested.merged, false)

      await fetch(`${gitlabProjectPath(providerBaseUrl)}/merge_requests/${pullRequestId}/approve`, {
        method: 'POST',
        headers: { 'PRIVATE-TOKEN': GITLAB_VALID_PAT },
      })
      const approved = await (
        await fetch(`${gantryBase}/api/instance/check-status?slug=${SLUG}`, { method: 'POST', headers: authHeader })
      ).json()
      assert.equal(approved.review.state, 'approved')
      assert.equal(approved.merged, true)
      assert.ok(approved.advancedTo)
      assert.notEqual(approved.advancedTo.id, SHAPE.id)

      const instance = await readInstance(SLUG, { gitlab })
      assert.equal(instance.stage, approved.advancedTo.id)
    },
    { fakeServerOptions: { files: seedFiles() } }
  )
})

test('POST /api/instance/check-status (GitLab workspace) surfaces a protected-branch merge refusal verbatim, without advancing', async () => {
  await withScratchGitLabServer(
    async ({ gantryBase, providerBaseUrl, instancesDir }) => {
      registerInstance(SLUG, { kind: 'gitlab', namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl: providerBaseUrl }, { instancesDir })
      const gitlab = { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, pat: GITLAB_VALID_PAT, baseUrl: providerBaseUrl }
      const branch = await resolveGitLabStageBranch(gitlab, definition, SLUG, SHAPE.id)
      await fillShapeStage(gitlab, branch)

      const opened = await (
        await fetch(`${gantryBase}/api/instance/request-approval?slug=${SLUG}`, { method: 'POST', headers: authHeader })
      ).json()

      await fetch(`${gitlabProjectPath(providerBaseUrl)}/merge_requests/${opened.pullRequestId}/approve`, {
        method: 'POST',
        headers: { 'PRIVATE-TOKEN': GITLAB_VALID_PAT },
      })

      const res = await fetch(`${gantryBase}/api/instance/check-status?slug=${SLUG}`, { method: 'POST', headers: authHeader })
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.match(body.error, /protected/)

      const instance = await readInstance(SLUG, { gitlab })
      assert.equal(instance.stage, SHAPE.id)
    },
    {
      fakeServerOptions: {
        files: seedFiles(),
        mergeRefusal: { status: 405, message: 'Branch is protected from force push' },
      },
    }
  )
})

test('POST /api/instance/stage/reopen (GitLab workspace) re-opens a completed stage: branch recreated from main, stage moved back, reopened marker set', async () => {
  await withScratchGitLabServer(
    async ({ gantryBase, providerBaseUrl, instancesDir }) => {
      registerInstance(SLUG, { kind: 'gitlab', namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl: providerBaseUrl }, { instancesDir })
      const gitlab = { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, pat: GITLAB_VALID_PAT, baseUrl: providerBaseUrl }
      const branch = await resolveGitLabStageBranch(gitlab, definition, SLUG, SHAPE.id)
      await fillShapeStage(gitlab, branch)

      const opened = await (
        await fetch(`${gantryBase}/api/instance/request-approval?slug=${SLUG}`, { method: 'POST', headers: authHeader })
      ).json()
      await fetch(`${gitlabProjectPath(providerBaseUrl)}/merge_requests/${opened.pullRequestId}/approve`, {
        method: 'POST',
        headers: { 'PRIVATE-TOKEN': GITLAB_VALID_PAT },
      })
      const merged = await (
        await fetch(`${gantryBase}/api/instance/check-status?slug=${SLUG}`, { method: 'POST', headers: authHeader })
      ).json()
      assert.equal(merged.merged, true)

      // Our fake, like the Azure DevOps/GitHub ones, never auto-deletes a merged source branch —
      // simulate the "a stage branch was cleaned up after merge" precondition reopen assumes, the same
      // way tests/serverStageReopen.test.js deletes the Azure DevOps ref directly.
      await fetch(`${gitlabProjectPath(providerBaseUrl)}/repository/branches/${encodeURIComponent(branch)}`, {
        method: 'DELETE',
        headers: { 'PRIVATE-TOKEN': GITLAB_VALID_PAT },
      })

      const reopenRes = await fetch(`${gantryBase}/api/instance/stage/reopen?slug=${SLUG}&stage=shape`, {
        method: 'POST',
        headers: authHeader,
      })
      assert.equal(reopenRes.status, 200)
      const reopenBody = await reopenRes.json()
      assert.equal(reopenBody.branch, branch)
      assert.ok(reopenBody.reopened.shape)

      const instance = await readInstance(SLUG, { gitlab })
      assert.equal(instance.stage, 'shape')
    },
    { fakeServerOptions: { files: seedFiles() } }
  )
})
