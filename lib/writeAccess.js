import { createGitHubClient } from './githubClient.js'
import { createGitLabClient } from './gitlabClient.js'
import { createAzureDevOpsClient } from './azureDevOpsClient.js'

// #126 (parent #109, docs/adr/0047): "a viewer who cannot write sees a read-only interface ... whether
// someone can write is established by an explicit check ... not inferred from the mere presence of a
// token". A personal Provider PAT that happens to be in the browser is common and grants nothing on
// someone else's repo — so #125's shared-read fallback existing is precisely what makes "has a
// credential" and "may edit" two different questions for the first time. This module answers the
// second question, once, for a `{ provider, location }` (a workspace's own registry shape,
// `lib/workspaceRegistry.js`'s `resolveWorkspace`, `location` already carrying that credential's own
// `pat`) — never inferred from a successful read, since a shared workspace's reads succeed for every
// visitor regardless of their own credential (or lack of one).
//
// Every provider branch below is read-only in effect: each asks exactly one already-fetched-elsewhere
// piece of repo/project metadata for a permission field the Provider itself computes for the supplied
// credential — no repo content is touched, no branch created, nothing written, and nothing here is
// itself a mutation that would need its own undo.
//
// GitLab's own access-level scale (see lib/gitlabIdentityClient.js's `MINIMUM_ASSIGNABLE_ACCESS_LEVEL`
// doc comment for the full 10/20/30/40/50 scale). Deliberately a *different* constant than that one's
// 20 (Reporter, sufficient to be assigned an issue) — Reporter can read but cannot push, so write
// access needs the next tier up: Developer (30), the lowest level GitLab itself allows to push to a
// non-protected branch.
export const GITLAB_MINIMUM_WRITE_ACCESS_LEVEL = 30

async function checkGitHubWriteAccess(location) {
  const repo = await createGitHubClient(location).getRepo()
  // GitHub's own `GET /repos/{owner}/{repo}` includes a `permissions` object (admin/maintain/push/
  // triage/pull) scoped to the token that made the request, whenever that token is authenticated —
  // exactly "can this credential push here", asked of GitHub itself rather than inferred.
  return Boolean(repo.permissions?.push)
}

async function checkGitLabWriteAccess(location) {
  const project = await createGitLabClient(location).getRepo()
  // GitLab's own `GET /projects/:id` includes a `permissions` object with `project_access`/
  // `group_access`, each an `{ access_level }` when access is granted directly vs. via a group this
  // credential's account belongs to — the higher of the two is this credential's effective level.
  const projectLevel = project.permissions?.project_access?.access_level ?? 0
  const groupLevel = project.permissions?.group_access?.access_level ?? 0
  return Math.max(projectLevel, groupLevel) >= GITLAB_MINIMUM_WRITE_ACCESS_LEVEL
}

async function checkAzureDevOpsWriteAccess(location) {
  return createAzureDevOpsClient(location).hasWriteAccess()
}

const CHECKERS = {
  github: checkGitHubWriteAccess,
  gitlab: checkGitLabWriteAccess,
  'azure-devops': checkAzureDevOpsWriteAccess,
}

/**
 * Whether `location`'s own credential (a workspace's `{ provider, location }`, `location` already
 * carrying `pat`, from `lib/workspaceRegistry.js`'s `resolveWorkspace`) can actually write to this
 * repo — the single explicit check #126 needs, called once per credential entry and remembered by the
 * caller (`web/lib/credential.js`), never re-derived from "a credential is present" or from a
 * successful read. Throws whatever the underlying provider client throws for a rejected PAT
 * (`AuthenticationError`) — propagated untouched, so a caller (`lib/server.js`'s own
 * `withGitHubCredential`/`withGitLabCredential`/`withAzureDevOpsCredential`) tells a rejected
 * credential apart from a merely read-only one exactly the way it already tells apart every other
 * provider-rejected PAT.
 */
export async function checkWriteAccess(provider, location) {
  const checker = CHECKERS[provider]
  if (!checker) throw new Error(`checkWriteAccess: unsupported provider "${provider}"`)
  return checker(location)
}
