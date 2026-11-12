import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withRunningServer, withScratchInstances, basicAuthHeader, GITLAB_NAMESPACE, GITLAB_REPOSITORY, GITLAB_VALID_PAT, BITBUCKET_OWNER, BITBUCKET_REPOSITORY, BITBUCKET_VALID_PAT, JIRA_SITE, JIRA_PROJECT_KEY } from './helpers/lifecycle.js'

// #370: POST /api/instances only knows how to create an Instance on Azure DevOps, GitHub or a server
// workspace. A GitLab or Atlassian workspace can be registered but can't hold a new Instance yet, and
// the wizard used to send such a workspace's location under `azureDevOps` (the "every other Provider"
// branch), so the request came back as an Azure DevOps "location is missing: organization, project"
// error that named the wrong Provider. A location sent under its own Provider's key is now refused
// with a 400 that names that Provider, before anything is written.

function postInstance(base, body, pat) {
  return fetch(`${base}/api/instances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(pat) },
    body: JSON.stringify(body),
  })
}

test('POST /api/instances for a GitLab location is refused with a 400 that names GitLab, and writes nothing', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withRunningServer({ instancesDir }, async (base) => {
      const res = await postInstance(base, { definition: 'design', slug: 'gitlab-one', gitlab: { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY } }, GITLAB_VALID_PAT)
      assert.equal(res.status, 400)
      const { error } = await res.json()
      assert.equal(error, "A new Instance can't be created in a GitLab workspace yet.")
      assert.doesNotMatch(error, /Azure DevOps|azureDevOps|organization/)

      const listing = await (await fetch(`${base}/api/instances`)).json()
      assert.equal(listing.length, 0)
    })
  })
})

test('POST /api/instances for an Atlassian location is refused with a 400 that names Atlassian, and writes nothing', async () => {
  await withScratchInstances(async (instancesDir) => {
    await withRunningServer({ instancesDir }, async (base) => {
      const atlassian = { owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, jiraSite: JIRA_SITE, jiraProjectKey: JIRA_PROJECT_KEY }
      const res = await postInstance(base, { definition: 'design', slug: 'atlassian-one', atlassian }, BITBUCKET_VALID_PAT)
      assert.equal(res.status, 400)
      const { error } = await res.json()
      assert.equal(error, "A new Instance can't be created in an Atlassian workspace yet.")
      assert.doesNotMatch(error, /Azure DevOps|azureDevOps|organization/)

      const listing = await (await fetch(`${base}/api/instances`)).json()
      assert.equal(listing.length, 0)
    })
  })
})
