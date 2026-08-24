// Parses the standard Azure DevOps repo URL shape into its organization/project/repository location — the one piece of this module still in production use, by the "+ New Workspace" wizard's own registration form (web/pages/new-workspace-wizard.js, #110).
//
// This module used to also export a live `validateRepo(repoUrl)` contract (#94, under #88) that asked `GET /api/azure-devops/repo-check` whether a parsed location already held instance data, for the old URL-first "+ New instance" wizard (web/pages/setup-wizard.js). That wizard — and `validateRepo` along with it, since it had no other caller — was removed by #110: the new wizard registers a workspace directly (`POST /api/workspaces`, which itself proves repo access) rather than pre-checking it, so there is no remaining use for a standalone check-then-report step.
//
// A non-`dev.azure.com` base URL (an on-premises Azure DevOps Server) is an explicit, known gap — out of scope here per docs/adr/0005: this parser only recognizes the standard `https://dev.azure.com/{organization}/{project}/_git/{repository}` shape, returning `null` for anything else.
const AZURE_DEVOPS_REPO_URL_RE = /^https:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)\/?$/

/**
 * Parses a repo URL into its Azure DevOps location — `{ organization, project, repository }` — or `null` if it doesn't match the standard `https://dev.azure.com/{organization}/{project}/_git/{repository}` shape (including any non-`dev.azure.com` base URL, or a malformed percent-escape in one of the path segments).
 */
export function parseRepoUrl(repoUrl) {
  const match = typeof repoUrl === 'string' ? repoUrl.trim().match(AZURE_DEVOPS_REPO_URL_RE) : null
  if (!match) return null
  const [, organization, project, repository] = match
  try {
    return {
      organization: decodeURIComponent(organization),
      project: decodeURIComponent(project),
      repository: decodeURIComponent(repository),
    }
  } catch {
    return null
  }
}

/** The repository name a repo URL parses to as its instance slug — '' if it doesn't parse at all. */
export function repoSlug(repoUrl) {
  return parseRepoUrl(repoUrl)?.repository ?? ''
}
