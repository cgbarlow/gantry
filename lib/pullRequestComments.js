import { readInstance } from './instance.js'
import { findStageBranch } from './stageBranch.js'
import { findGitHubStageBranch } from './githubStageBranch.js'
import { createAzureDevOpsPullRequestsClient } from './azureDevOpsPullRequestsClient.js'
import { createGitHubPullRequestsClient } from './githubPullRequestsClient.js'

/**
 * #299 (parent #238): every comment on the Pull Request open for a Stage, resolved or not, for the AI interview's revision of a Stage the Owner
 * sent back. Azure DevOps and GitHub only (the two Providers the AI interview requests approval on); another Provider is a plain refusal.
 * Read-only: nothing here, and nothing the AI interview does, posts, replies to or resolves anything on a Pull Request.
 *
 * Reads the Pull Request id from the Stage's own branch's copy of `instance.yaml` (where Request approval recorded it), the same copy Check
 * status reads. `stageId` defaults to the Instance's current Stage.
 *
 * @returns {Promise<{stage: string, pullRequestId: number, comments: object[]}>}
 */
export async function readPullRequestComments(slug, { stageId, azureDevOps, github, gitlab, atlassian } = {}) {
  if (!azureDevOps && !github) {
    const other = gitlab ? 'GitLab' : atlassian ? 'Atlassian' : 'this kind of workspace'
    throw new Error(`Reading Pull Request comments is available on Azure DevOps and GitHub workspaces, not on ${other}.`)
  }
  const providerKey = github ? 'github' : 'azureDevOps'
  const base = github ?? azureDevOps
  const bootstrap = await readInstance(slug, { [providerKey]: base })
  const stage = stageId ?? bootstrap.stage
  const branch = github ? await findGitHubStageBranch(base, slug, stage) : await findStageBranch(base, slug, stage)
  const instance = branch ? await readInstance(slug, { [providerKey]: { ...base, branch } }) : bootstrap
  const pullRequestId = instance.pullRequests?.[stage]
  if (!pullRequestId) {
    throw new Error(`Instance "${slug}" has no Pull Request open for stage "${stage}", so there are no comments to read.`)
  }
  const client = github ? createGitHubPullRequestsClient(base) : createAzureDevOpsPullRequestsClient(base)
  return { stage, pullRequestId, comments: await client.getPullRequestComments(pullRequestId) }
}
