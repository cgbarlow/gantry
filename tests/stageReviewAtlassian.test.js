import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AuthenticationError } from '../lib/providerErrors.js'
import { readInstance } from '../lib/instance.js'
import { requestStageReview, checkStageReviewStatus } from '../lib/stageReview.js'
import { createBitbucketClient } from '../lib/bitbucketClient.js'
import { createJiraWorkItemsClient } from '../lib/jiraWorkItemsClient.js'
import { JIRA_REVIEW_LABEL_PREFIX } from '../lib/reviewStatus.js'
import { withFakeBitbucketServer, BITBUCKET_OWNER, BITBUCKET_REPOSITORY, BITBUCKET_VALID_PAT } from './helpers/fakeBitbucketServer.js'
import { withFakeJiraServer, JIRA_SITE, JIRA_PROJECT_KEY, JIRA_VALID_PAT } from './helpers/fakeJiraServer.js'

// #47 — Request Review for Atlassian workspaces. The Atlassian twin of tests/serverGitLabReview.test.js
// (#34's own GitLab coverage), parameterizing the same two capabilities — requestStageReview,
// checkStageReviewStatus — against real fake Bitbucket and Jira Cloud servers. Unlike every other
// provider's own review suite, this is exercised by calling lib/stageReview.js's exported functions
// directly rather than through gantry's own HTTP server: ADR-0042's Atlassian location schema has no
// `baseUrl` field at all (Cloud-only, both products' API hosts fixed), so there is no way for a
// registered workspace to point a real `gantry serve` route at a fake Bitbucket/Jira pair the way the
// GitHub/GitLab suites' own `baseUrl`-in-location convention allows — the same reasoning
// tests/renderAtlassian.test.js's own doc comment already gives for #43's coverage, and the reason
// `lib/server.js`'s own `resolveAtlassianLocation`/route wiring is deliberately deferred to a later
// ticket.
//
// Where behaviour genuinely diverges from GitHub/GitLab, that's its own explicit assertion rather than
// a silently absent one: reviewer identity is resolved against **Jira's** own user directory (#45), by
// `accountId` rather than a username/login; the reserved `gantry:review/<status>` label lives on Jira's
// own freeform `labels` field, set once at issue creation (no GitHub/GitLab-style `ensureLabelsExist`
// registry step first); and a review request's own `workItemId` is the Jira issue's globally-unique
// numeric `id`, not its human-facing key — see lib/stageReview.js's own `requestStageReviewAtlassian`
// doc comment for why.

const SLUG = 'my-initiative'
const INSTANCE_PATH = 'gantry-workspace/my-initiative/instance.yaml'

function withServers({ jiraOptions = {}, bitbucketOptions = {} } = {}, fn) {
  return withFakeJiraServer({ jiraProjectKey: JIRA_PROJECT_KEY, validPat: JIRA_VALID_PAT, ...jiraOptions }, (jiraBaseUrl) =>
    withFakeBitbucketServer({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT, ...bitbucketOptions }, (bitbucketBaseUrl) =>
      fn({ jiraBaseUrl, bitbucketBaseUrl })
    )
  )
}

// The `{ atlassian: ... }` options half every requestStageReview/checkStageReviewStatus/readInstance
// call below passes — `pat` (Bitbucket, for the instance.yaml content store) and `jiraPat` (Jira, for
// the review issue itself), the two-tokens-one-workspace shape ADR-0042/#40 established. `jiraSite`,
// `jiraProjectKey` and Jira's own fake-server `baseUrl` override are deliberately *not* here: they're
// read off the stage's own linked `instance.workItem` instead, exactly like every other provider's
// stageReview.js twin reads its identity/work-items client config off `instance.workItem`, not off its
// own content-store options.
function atlassianOptions(bitbucketBaseUrl, overrides = {}) {
  return {
    owner: BITBUCKET_OWNER,
    repository: BITBUCKET_REPOSITORY,
    pat: BITBUCKET_VALID_PAT,
    jiraPat: JIRA_VALID_PAT,
    baseUrl: bitbucketBaseUrl,
    ...overrides,
  }
}

function instanceYamlText({ stage = 'shape', parentKey, shapeKey, hldKey, jiraBaseUrl }) {
  let text =
    `definition: design\n` +
    `slug: ${SLUG}\n` +
    `stage: ${stage}\n` +
    `workItem:\n` +
    `  provider: atlassian\n` +
    `  jiraSite: ${JIRA_SITE}\n` +
    `  jiraProjectKey: ${JIRA_PROJECT_KEY}\n` +
    `  parentKey: ${parentKey}\n` +
    `  baseUrl: ${jiraBaseUrl}\n` +
    `  stages:\n` +
    `    shape: ${shapeKey}\n`
  if (hldKey) text += `    hld-define: ${hldKey}\n`
  return text
}

async function writeInstanceYaml(bitbucketBaseUrl, text) {
  const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl: bitbucketBaseUrl })
  await client.writeFile(INSTANCE_PATH, text, { branch: 'main' })
}

function jiraClient(jiraBaseUrl) {
  return createJiraWorkItemsClient({ jiraSite: JIRA_SITE, jiraProjectKey: JIRA_PROJECT_KEY, pat: JIRA_VALID_PAT, baseUrl: jiraBaseUrl })
}

// Creates a genuinely Atlassian-backed, already-linked instance the same way setUpLinkedInstance does
// in tests/serverGitLabReview.test.js: a real parent issue and a real "shape"-stage child issue already
// created on the fake Jira server and referenced from the seeded instance.yaml's own `workItem` block,
// written onto the fake Bitbucket server's own `main` branch.
async function setUpLinkedInstance(jiraBaseUrl, bitbucketBaseUrl) {
  const client = jiraClient(jiraBaseUrl)
  const parent = await client.createIssue({ title: 'Parent initiative', body: '', issueType: 'Task' })
  const shape = await client.createIssue({ title: 'Shape — my-initiative', body: 'Tracks the Shape stage.', issueType: 'Task' })
  await writeInstanceYaml(bitbucketBaseUrl, instanceYamlText({ parentKey: parent.key, shapeKey: shape.key, jiraBaseUrl }))
  return { parentKey: parent.key, shapeKey: shape.key }
}

test('Request Review (atlassian) creates one Jira issue assigned via accountId and labelled requested, related-linked to the stage issue', async () => {
  await withServers(
    { jiraOptions: { users: [{ accountId: 'acc-1', displayName: 'Reviewer One', emailAddress: 'reviewer1@example.com', assignable: true }] } },
    async ({ jiraBaseUrl, bitbucketBaseUrl }) => {
      const { shapeKey } = await setUpLinkedInstance(jiraBaseUrl, bitbucketBaseUrl)

      const result = await requestStageReview(
        SLUG,
        { reviewer: 'acc-1', stageId: 'shape', instanceUrl: 'https://gantry.example/instance/my-initiative' },
        { atlassian: atlassianOptions(bitbucketBaseUrl) }
      )
      assert.equal(result.review.status, 'Requested')
      assert.equal(result.review.reviewer, 'acc-1')
      assert.equal(result.review.reviewerDisplayName, 'Reviewer One')
      assert.match(result.webUrl, new RegExp(`^https://${JIRA_SITE}/browse/`))

      const issue = await jiraClient(jiraBaseUrl).getIssue(String(result.review.workItemId))
      assert.equal(issue.assignee, 'acc-1')
      assert.deepEqual(issue.labels, [`${JIRA_REVIEW_LABEL_PREFIX}requested`])
      assert.match(issue.body, new RegExp(`Related to ${shapeKey}`))
      assert.match(issue.body, /gantry\.example\/instance\/my-initiative/)

      const instance = await readInstance(SLUG, { atlassian: atlassianOptions(bitbucketBaseUrl) })
      assert.equal(instance.reviewRequests.shape.length, 1)
      assert.equal(instance.reviewRequests.shape[0].status, 'Requested')
      assert.equal(instance.reviewRequests.shape[0].workItemId, result.review.workItemId)
    }
  )
})

test('Request Review (atlassian) requires a reviewer, and rejects a stage with no linked work item', async () => {
  await withServers({}, async ({ bitbucketBaseUrl }) => {
    await writeInstanceYaml(bitbucketBaseUrl, `definition: design\nslug: ${SLUG}\nstage: shape\n`)

    await assert.rejects(
      () => requestStageReview(SLUG, { reviewer: '   ', stageId: 'shape' }, { atlassian: atlassianOptions(bitbucketBaseUrl) }),
      /A reviewer is required/
    )

    await assert.rejects(
      () => requestStageReview(SLUG, { reviewer: 'acc-1', stageId: 'shape' }, { atlassian: atlassianOptions(bitbucketBaseUrl) }),
      /has no linked work item for stage "shape"/
    )
  })
})

test('Request Review (atlassian) rejects a reviewer that does not resolve to any known identity, without creating an issue', async () => {
  await withServers({}, async ({ jiraBaseUrl, bitbucketBaseUrl }) => {
    await setUpLinkedInstance(jiraBaseUrl, bitbucketBaseUrl)

    await assert.rejects(
      () => requestStageReview(SLUG, { reviewer: 'nobody-matches-this-query', stageId: 'shape' }, { atlassian: atlassianOptions(bitbucketBaseUrl) }),
      /could not be resolved to a known Jira identity/
    )

    const instance = await readInstance(SLUG, { atlassian: atlassianOptions(bitbucketBaseUrl) })
    assert.equal(instance.reviewRequests, undefined)
  })
})

test('Request Review (atlassian) rejects a reviewer who resolves but lacks Assignable User permission, without creating an issue (docs/adr/0042)', async () => {
  await withServers(
    { jiraOptions: { users: [{ accountId: 'acc-2', displayName: 'Guest User', emailAddress: 'guest@example.com', assignable: false }] } },
    async ({ jiraBaseUrl, bitbucketBaseUrl }) => {
      await setUpLinkedInstance(jiraBaseUrl, bitbucketBaseUrl)

      await assert.rejects(
        () => requestStageReview(SLUG, { reviewer: 'acc-2', stageId: 'shape' }, { atlassian: atlassianOptions(bitbucketBaseUrl) }),
        /does not have the "Assignable User" permission/
      )

      const instance = await readInstance(SLUG, { atlassian: atlassianOptions(bitbucketBaseUrl) })
      assert.equal(instance.reviewRequests, undefined)
    }
  )
})

test('Request Review (atlassian) rejects a stage other than the instance\'s current stage', async () => {
  await withServers(
    { jiraOptions: { users: [{ accountId: 'acc-1', displayName: 'Reviewer One', assignable: true }] } },
    async ({ jiraBaseUrl, bitbucketBaseUrl }) => {
      const client = jiraClient(jiraBaseUrl)
      const parent = await client.createIssue({ title: 'Parent initiative', body: '', issueType: 'Task' })
      const shape = await client.createIssue({ title: 'Shape — my-initiative', body: '', issueType: 'Task' })
      const hld = await client.createIssue({ title: 'HLD — my-initiative', body: '', issueType: 'Task' })
      await writeInstanceYaml(bitbucketBaseUrl, instanceYamlText({ parentKey: parent.key, shapeKey: shape.key, hldKey: hld.key, jiraBaseUrl }))

      await assert.rejects(
        () => requestStageReview(SLUG, { reviewer: 'acc-1', stageId: 'hld-define' }, { atlassian: atlassianOptions(bitbucketBaseUrl) }),
        /Review requests are only available for the instance's current stage \("shape"\)/
      )
    }
  )
})

test('Request Review (atlassian) surfaces a rejected Jira token as AuthenticationError while resolving the reviewer', async () => {
  await withServers(
    { jiraOptions: { users: [{ accountId: 'acc-1', displayName: 'Reviewer One', assignable: true }] } },
    async ({ jiraBaseUrl, bitbucketBaseUrl }) => {
      await setUpLinkedInstance(jiraBaseUrl, bitbucketBaseUrl)

      await assert.rejects(async () => {
        try {
          await requestStageReview(
            SLUG,
            { reviewer: 'acc-1', stageId: 'shape' },
            { atlassian: atlassianOptions(bitbucketBaseUrl, { jiraPat: 'wrong-jira-pat' }) }
          )
        } catch (err) {
          assert.ok(err instanceof AuthenticationError)
          assert.equal(err.operation, 'resolving the reviewer for Request Review')
          throw err
        }
      })
    }
  )
})

test('Review status (atlassian) is read only on explicit Check status, from the issue\'s current gantry:review/* label — never polling', async () => {
  await withServers(
    { jiraOptions: { users: [{ accountId: 'acc-1', displayName: 'Reviewer One', assignable: true }] } },
    async ({ jiraBaseUrl, bitbucketBaseUrl }) => {
      await setUpLinkedInstance(jiraBaseUrl, bitbucketBaseUrl)

      const requested = await requestStageReview(SLUG, { reviewer: 'acc-1', stageId: 'shape' }, { atlassian: atlassianOptions(bitbucketBaseUrl) })

      // A reviewer's real decision in Jira's own UI — modelled here as a direct label PUT against the
      // fake server, bypassing gantry entirely, exactly like the GitHub/GitLab suites' own PATCH/PUT
      // against their own fake servers simulates a reviewer's decision.
      const putRes = await fetch(`${jiraBaseUrl}/rest/api/3/issue/${requested.review.workItemId}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${JIRA_VALID_PAT}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { labels: [`${JIRA_REVIEW_LABEL_PREFIX}changes-requested`] } }),
      })
      assert.equal(putRes.status, 204)

      // Not reflected until the explicit Check action re-reads it.
      const beforeCheck = await readInstance(SLUG, { atlassian: atlassianOptions(bitbucketBaseUrl) })
      assert.equal(beforeCheck.reviewRequests.shape[0].status, 'Requested')

      const status = await checkStageReviewStatus(
        SLUG,
        { reviewId: requested.review.workItemId, stageId: 'shape' },
        { atlassian: atlassianOptions(bitbucketBaseUrl) }
      )
      assert.equal(status.review.status, 'Changes requested')

      const afterCheck = await readInstance(SLUG, { atlassian: atlassianOptions(bitbucketBaseUrl) })
      assert.equal(afterCheck.reviewRequests.shape[0].status, 'Changes requested')
    }
  )
})

test('Review status (atlassian) rejects an invalid review id and a review id with no matching request', async () => {
  await withServers({}, async ({ jiraBaseUrl, bitbucketBaseUrl }) => {
    await setUpLinkedInstance(jiraBaseUrl, bitbucketBaseUrl)

    await assert.rejects(
      () => checkStageReviewStatus(SLUG, { reviewId: 'not-a-number', stageId: 'shape' }, { atlassian: atlassianOptions(bitbucketBaseUrl) }),
      /A valid review work item id is required/
    )

    await assert.rejects(
      () => checkStageReviewStatus(SLUG, { reviewId: 999999, stageId: 'shape' }, { atlassian: atlassianOptions(bitbucketBaseUrl) }),
      /has no review request for work item #999999 on stage "shape"/
    )
  })
})
