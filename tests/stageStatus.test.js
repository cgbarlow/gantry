import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkStageApprovalStatus, interpretReviewerVotes, summarizePullRequest } from '../lib/stageStatus.js'
import { reviewStatusFromVoteState } from '../lib/reviewStatus.js'
import { requestStageApproval } from '../lib/stageApproval.js'
import { readInstance } from '../lib/instance.js'
import { linkInstanceToWorkItem } from '../lib/workItemLink.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { loadDefinition } from '../lib/definition.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { resolveStageBranch } from '../lib/stageBranch.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'

// Lib-level tests for #125's "Check status" action (ADR-0014): reading a
// stage's Pull Request reviewer votes and distinguishing an explicit
// rejection/changes-requested from a merely-still-pending review, plus the
// full approve → auto-merge → advance-the-stage flow (including the linked
// work item's state push). Real HTTP against the fake in-process Azure
// DevOps server throughout — the Owner's vote is cast exactly as it would
// be in Azure DevOps's own UI, via the fake server's reviewers endpoint,
// the same way a real vote would exercise "Check status"'s detection.

const ORGANIZATION = 'fake-org'
const PROJECT = 'fake-project'
const REPOSITORY = 'fake-repo'
const VALID_PAT = 'valid-test-pat'
const SLUG = 'remote-initiative'

const definition = loadDefinition('design')
const [SHAPE] = definition.stages

function basicAuthHeader(pat) {
  return `Basic ${Buffer.from(`:${pat}`, 'utf8').toString('base64')}`
}

function withScratchInstances(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  return (async () => fn(instancesDir))().finally(() => rmSync(instancesDir, { recursive: true, force: true }))
}

async function fillShapeStage(azureDevOps, branch) {
  const client = createAzureDevOpsClient(azureDevOps)
  for (const moduleId of ['context', 'solution-definition', 'team-and-estimates']) {
    const text = readFileSync(join('instances', 'examples', 'modules', `${moduleId}.md`), 'utf8')
    await client.writeFile(`gantry-workspace/${SLUG}/modules/${moduleId}.md`, text, { branch })
  }
  await client.writeFile(`gantry-workspace/${SLUG}/out/Remote Initiative - Solution on a Page.docx`, 'rendered soap', { branch })
}

async function castVote(adoBaseUrl, pullRequestId, vote) {
  const res = await fetch(
    `${adoBaseUrl}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY}/pullrequests/${pullRequestId}/reviewers/owner-1`,
    {
      method: 'PUT',
      headers: { Authorization: basicAuthHeader(VALID_PAT), 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'The Owner', vote }),
    }
  )
  assert.equal(res.status, 200)
}

function waitForTimestampToAdvance() {
  return new Promise((resolve) => setTimeout(resolve, 10))
}

test('interpretReviewerVotes distinguishes approval, rejection, changes-requested and pending', () => {
  assert.equal(interpretReviewerVotes([]), 'pending')
  assert.equal(interpretReviewerVotes([{ displayName: 'a', vote: 0 }]), 'pending')
  assert.equal(interpretReviewerVotes([{ displayName: 'a', vote: 10 }]), 'approved')
  assert.equal(interpretReviewerVotes([{ displayName: 'a', vote: 5 }]), 'approved')
  assert.equal(interpretReviewerVotes([{ displayName: 'a', vote: -10 }]), 'rejected')
  assert.equal(interpretReviewerVotes([{ displayName: 'a', vote: -5 }]), 'changes-requested')
  // A single rejection blocks, no matter who else approved.
  assert.equal(interpretReviewerVotes([{ displayName: 'a', vote: 10 }, { displayName: 'b', vote: -10 }]), 'rejected')
})

// ADR-0024: sign-off's PR-vote-derived state mapped onto the same
// five-value vocabulary review work items use — one shared status
// language, not two.
test('reviewStatusFromVoteState maps every interpretReviewerVotes outcome (plus invalidation) onto the shared five-value vocabulary', () => {
  assert.equal(reviewStatusFromVoteState('pending'), 'In review')
  assert.equal(reviewStatusFromVoteState('approved'), 'Approved')
  assert.equal(reviewStatusFromVoteState('rejected'), 'Rejected')
  assert.equal(reviewStatusFromVoteState('changes-requested'), 'Changes requested')
  // A stale approval a later commit invalidated is back under review, not
  // itself a rejection (mirrors ADR-0014).
  assert.equal(reviewStatusFromVoteState('approved-then-invalidated'), 'In review')
  // An unrecognized/future vote-state value degrades to "In review" rather
  // than throwing or returning something blank.
  assert.equal(reviewStatusFromVoteState('some-unknown-state'), 'In review')
})

test('summarizePullRequest reads a reviewer\'s required flag off Azure DevOps\'s real isRequired field (WI199), not the wrong `required` field', () => {
  const pullRequest = {
    pullRequestId: 1,
    status: 'active',
    reviewers: [
      // No isRequired at all — must default to not-required, not throw.
      { id: 'optional-1', displayName: 'Optional Reviewer', vote: 0 },
      // isRequired explicitly false.
      { id: 'optional-2', displayName: 'Optional Reviewer 2', vote: 0, isRequired: false },
      // Azure DevOps's real shape carries isRequired — a stray `required`
      // field (e.g. left over from a caller still using the old wrong
      // name, or from some other source) must never be trusted instead.
      // Listed last, so a correct pick below proves `required` (not
      // array order) drove the selection.
      { id: 'owner-1', displayName: 'The Owner', vote: 0, isRequired: true, required: false },
    ],
  }

  const summary = summarizePullRequest(pullRequest)
  assert.equal(summary.review.reviewers[0].required, false)
  assert.equal(summary.review.reviewers[1].required, false)
  assert.equal(summary.review.reviewers[2].required, true)
  // The picked "approver" for display purposes should be the required
  // reviewer, not just the first one in the array — proving `required`
  // actually drove that selection rather than being reported but ignored.
  assert.equal(summary.review.approver.id, 'owner-1')
})

test('checkStageApprovalStatus is Workspace-backed only', async () => {
  await assert.rejects(() => checkStageApprovalStatus('any-slug'), /Workspace-backed/)
})

test('checkStageApprovalStatus throws when no Pull Request has been opened for the stage yet', async () => {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: shape\n` },
    },
    async (adoBaseUrl) => {
      await withScratchInstances(async (instancesDir) => {
        registerInstance(
          SLUG,
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          { instancesDir }
        )
        const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl }

        await assert.rejects(
          () => checkStageApprovalStatus(SLUG, { azureDevOps }),
          /has no Pull Request open requesting approval for stage "shape"/
        )
      })
    }
  )
})

async function withOpenPullRequest(fn, serverOverrides = {}) {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: shape\n` },
      ...serverOverrides,
    },
    async (adoBaseUrl) => {
      await withScratchInstances(async (instancesDir) => {
        registerInstance(
          SLUG,
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          { instancesDir }
        )
        const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl }
        const branch = await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)
        await fillShapeStage(azureDevOps, branch)

        const opened = await requestStageApproval(SLUG, { azureDevOps })
        await fn({ adoBaseUrl, azureDevOps, instancesDir, branch, pullRequestId: opened.pullRequestId })
      })
    }
  )
}

async function getPrStatus(azureDevOps, pullRequestId) {
  const res = await fetch(`${azureDevOps.baseUrl}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY}/pullrequests/${pullRequestId}`, {
    headers: { Authorization: `Basic ${Buffer.from(`:${azureDevOps.pat}`, 'utf8').toString('base64')}` },
  })
  return (await res.json()).status
}

test('a still-pending review reports pending and merges nothing', async () => {
  await withOpenPullRequest(async ({ azureDevOps, pullRequestId }) => {
    await castVote(azureDevOps.baseUrl, pullRequestId, 0)

    const result = await checkStageApprovalStatus(SLUG, { azureDevOps })
    assert.equal(result.review.state, 'pending')
    // ADR-0024: the same five-value vocabulary review work items use.
    assert.equal(result.review.reviewStatus, 'In review')
    assert.equal(result.merged, false)
    assert.equal(result.advancedTo, null)
    assert.equal(result.prStatus, 'active')
    assert.equal(await getPrStatus(azureDevOps, pullRequestId), 'active')

    const instance = await readInstanceAfter(azureDevOps)
    assert.equal(instance.stage, 'shape')
  })
})

test('an explicit rejection is reported as rejected — not merged, stage untouched', async () => {
  await withOpenPullRequest(async ({ azureDevOps, pullRequestId }) => {
    await castVote(azureDevOps.baseUrl, pullRequestId, -10)

    const result = await checkStageApprovalStatus(SLUG, { azureDevOps })
    assert.equal(result.review.state, 'rejected')
    assert.equal(result.review.reviewStatus, 'Rejected')
    assert.equal(result.merged, false)
    assert.equal(result.advancedTo, null)
    assert.equal(await getPrStatus(azureDevOps, pullRequestId), 'active')

    const instance = await readInstanceAfter(azureDevOps)
    assert.equal(instance.stage, 'shape')
  })
})

test('a waiting-for-author vote is reported as changes-requested — distinct from pending', async () => {
  await withOpenPullRequest(async ({ azureDevOps, pullRequestId }) => {
    await castVote(azureDevOps.baseUrl, pullRequestId, -5)

    const result = await checkStageApprovalStatus(SLUG, { azureDevOps })
    assert.equal(result.review.state, 'changes-requested')
    assert.equal(result.review.reviewStatus, 'Changes requested')
    assert.equal(result.merged, false)
    assert.equal(await getPrStatus(azureDevOps, pullRequestId), 'active')
  })
})

test('a commit after approval invalidates auto-merge, persists the state, and can be reset on request approval again', async () => {
  await withOpenPullRequest(async ({ azureDevOps, branch, pullRequestId }) => {
    await castVote(azureDevOps.baseUrl, pullRequestId, 10)
    await waitForTimestampToAdvance()

    const client = createAzureDevOpsClient(azureDevOps)
    const current = readFileSync(join('instances', 'examples', 'modules', 'context.md'), 'utf8')
    await client.writeFile(`gantry-workspace/${SLUG}/modules/context.md`, `${current}\nPost-approval edit.\n`, {
      branch,
      message: 'Post-approval edit',
    })

    const invalidated = await checkStageApprovalStatus(SLUG, { azureDevOps })
    assert.equal(invalidated.review.state, 'approved-then-invalidated')
    // A stale, invalidated approval reads as back "In review", not
    // "Approved" — ADR-0024 mirrors ADR-0014's invalidation treatment.
    assert.equal(invalidated.review.reviewStatus, 'In review')
    assert.equal(invalidated.merged, false)
    assert.equal(invalidated.approvalState.state, 'invalidated')
    assert.equal(invalidated.pullRequest.commits.some((commit) => commit.message === 'Post-approval edit'), true)

    const persisted = await readInstance(SLUG, { azureDevOps: { ...azureDevOps, branch } })
    assert.equal(persisted.approvalStates.shape.state, 'invalidated')

    const reapproved = await requestStageApproval(SLUG, { azureDevOps })
    assert.equal(reapproved.pullRequestId, pullRequestId)
    assert.equal(reapproved.reapproval.method, 'vote-reset')
    assert.equal(reapproved.pullRequest.review.state, 'pending')

    const cleared = await readInstance(SLUG, { azureDevOps: { ...azureDevOps, branch } })
    assert.equal(cleared.approvalStates, undefined)
    const afterReset = await checkStageApprovalStatus(SLUG, { azureDevOps })
    assert.equal(afterReset.review.state, 'pending')
    assert.equal(afterReset.merged, false)
  })
})

test('request approval again posts a fallback comment when Azure DevOps denies resetting the stale vote', async () => {
  await withOpenPullRequest(
    async ({ azureDevOps, branch, pullRequestId }) => {
      await castVote(azureDevOps.baseUrl, pullRequestId, 10)
      await waitForTimestampToAdvance()
      const client = createAzureDevOpsClient(azureDevOps)
      const current = readFileSync(join('instances', 'examples', 'modules', 'context.md'), 'utf8')
      await client.writeFile(`gantry-workspace/${SLUG}/modules/context.md`, `${current}\nAnother edit.\n`, { branch })
      await checkStageApprovalStatus(SLUG, { azureDevOps })

      const result = await requestStageApproval(SLUG, { azureDevOps })
      assert.equal(result.reapproval.method, 'comment')
      assert.equal(result.pullRequest.review.state, 'approved')
    },
    { denyReviewerVoteReset: true },
  )
})

test('detecting approval merges the Pull Request itself and advances the stage pointer', async () => {
  await withOpenPullRequest(async ({ azureDevOps, pullRequestId }) => {
    await castVote(azureDevOps.baseUrl, pullRequestId, 10)

    const result = await checkStageApprovalStatus(SLUG, { azureDevOps })
    assert.equal(result.review.state, 'approved')
    assert.equal(result.review.reviewStatus, 'Approved')
    assert.equal(result.merged, true)
    assert.equal(result.prStatus, 'completed')
    assert.deepEqual(result.advancedTo, { id: 'hld-define', title: 'High-level Design', gate: 'hld-tac-approved' })

    // The merge happened on Azure DevOps's side…
    assert.equal(await getPrStatus(azureDevOps, pullRequestId), 'completed')
    // …and gantry's own stage pointer moved with it (read back from main).
    const instance = await readInstanceAfter(azureDevOps)
    assert.equal(instance.stage, 'hld-define')
  })
})

test('checking status again after a successful merge is a safe no-op, not a second completion or advance', async () => {
  await withOpenPullRequest(async ({ azureDevOps, pullRequestId }) => {
    await castVote(azureDevOps.baseUrl, pullRequestId, 10)
    const first = await checkStageApprovalStatus(SLUG, { azureDevOps })
    assert.equal(first.merged, true)
    assert.equal(first.advancedTo.id, 'hld-define')

    const second = await checkStageApprovalStatus(SLUG, {
      // A re-click after the advance now resolves the instance's current
      // stage to the *next* one — a stale screen still asking about the
      // completed stage does so via its gate, exactly as the API allows.
      azureDevOps,
      gate: 'business-case',
    })
    assert.equal(second.prStatus, 'completed')
    assert.equal(second.merged, true)
    assert.equal(second.advancedTo, null)

    const instance = await readInstanceAfter(azureDevOps)
    assert.equal(instance.stage, 'hld-define')
  })
})

test('approving the final stage completes its Pull Request without attempting an advance', async () => {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: handover\n` },
    },
    async (adoBaseUrl) => {
      await withScratchInstances(async (instancesDir) => {
        registerInstance(
          SLUG,
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          { instancesDir }
        )
        const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl }
        const handover = definition.stages.find((s) => s.id === 'handover')
        const branch = await resolveStageBranch(azureDevOps, definition, SLUG, handover.id)
        const client = createAzureDevOpsClient(azureDevOps)
        // WI #227: the handover gate now spans the shared glossary / introduction /
        // recovery-plan / data-security-controls modules as well as as-built-notes.
        for (const moduleId of ['glossary', 'introduction', 'as-built-notes', 'recovery-plan', 'data-security-controls']) {
          const text = readFileSync(join('instances', 'examples', 'modules', `${moduleId}.md`), 'utf8')
          await client.writeFile(`gantry-workspace/${SLUG}/modules/${moduleId}.md`, text, { branch })
        }
        await client.writeFile(`gantry-workspace/${SLUG}/out/Remote Initiative - As-built.docx`, 'rendered as-built', { branch })

        const opened = await requestStageApproval(SLUG, { azureDevOps })
        await castVote(adoBaseUrl, opened.pullRequestId, 10)

        const result = await checkStageApprovalStatus(SLUG, { azureDevOps })
        assert.equal(result.merged, true)
        assert.equal(result.advancedTo, null)

        const instance = await readInstanceAfter(azureDevOps)
        assert.equal(instance.stage, 'handover')
      })
    }
  )
})

test('a linked stage work item is pushed to its gate-passed state as part of the same check', async () => {
  await withOpenPullRequest(async ({ azureDevOps, adoBaseUrl, instancesDir, pullRequestId }) => {
    // Link the instance first (the real route writes the link through the
    // stage's own branch-scoped instance.yaml copy, so mirror that here).
    await linkInstanceToWorkItem(
      SLUG,
      { organization: ORGANIZATION, project: PROJECT, parentId: 42, workItemType: 'Task', pat: VALID_PAT, baseUrl: azureDevOps.baseUrl },
      { azureDevOps: { ...azureDevOps, branch: 'gantry-workspace/remote-initiative/shape' } }
    )

    await castVote(azureDevOps.baseUrl, pullRequestId, 10)
    const result = await checkStageApprovalStatus(SLUG, { azureDevOps })
    assert.ok(result.workItemSync)
    assert.equal(result.workItemSync.ok, true)
    assert.equal(typeof result.workItemSync.workItemId, 'number')
    assert.equal(result.workItemSync.state, 'Closed')

    const res = await fetch(`${adoBaseUrl}/${ORGANIZATION}/${PROJECT}/_apis/wit/workitems/${result.workItemSync.workItemId}`, {
      headers: { Authorization: basicAuthHeader(VALID_PAT) },
    })
    const workItem = await res.json()
    assert.equal(workItem.fields['System.State'], 'Closed')
  })
})

// Reads instance.yaml back from main (no branch override) — where the
// post-merge stage-pointer advance lands (#125).
async function readInstanceAfter(azureDevOps) {
  return readInstance(SLUG, { azureDevOps })
}
