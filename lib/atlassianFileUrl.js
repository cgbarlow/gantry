// The Bitbucket twin of lib/githubFileUrl.js/lib/gitlabFileUrl.js — builds the Bitbucket Cloud *web*
// URL for a repo file and for a commit, given the `{ owner, repository }` location shape every
// Bitbucket-backed call site carries (ADR-0042: `owner`/`repository` reuse GitHub's own keys, since
// Bitbucket Cloud addresses a repo identically — `workspace-slug/repo-slug` is structurally
// `owner/repository`). Keeping this construction shared avoids the render pipeline's source citation
// and its Document Control commit link disagreeing about how the Bitbucket web host is derived.
//
// Unlike GitHub/GitLab's own `baseUrl`, there is nothing to derive a web root from here at all —
// ADR-0042: Atlassian v1 is Cloud-only, so Bitbucket's own web host is always `https://bitbucket.org`,
// never a self-hosted override. `lib/bitbucketClient.js`'s own `baseUrl` (its *API* root, overridable
// only in tests to point at `tests/helpers/fakeBitbucketServer.js`) has no bearing on this file's own
// web-URL construction — a link a person clicks always targets the real `bitbucket.org`, even when the
// content itself was read through a fake API server in a test.

function repositoryUrl(bitbucket) {
  return new URL(`https://bitbucket.org/${encodeURIComponent(bitbucket.owner)}/${encodeURIComponent(bitbucket.repository)}`)
}

// Builds the Bitbucket Cloud web URL for a file at a specific ref (branch or commit hash) —
// Bitbucket's own `/<owner>/<repository>/src/<ref>/<path>` convention.
export function artefactFileUrl(bitbucket, path, ref) {
  const url = repositoryUrl(bitbucket)
  const encodedPath = path
    .replace(/^\/+/, '')
    .split('/')
    .map(encodeURIComponent)
    .join('/')
  url.pathname += `/src/${encodeURIComponent(ref)}/${encodedPath}`
  return url.toString()
}

// Builds the Bitbucket Cloud web URL for a specific commit — `/<owner>/<repository>/commits/<hash>`.
export function commitUrl(bitbucket, commitHash) {
  const url = repositoryUrl(bitbucket)
  url.pathname += `/commits/${encodeURIComponent(commitHash)}`
  return url.toString()
}

// Builds the Bitbucket Cloud web URL for a pull request, addressed by its repo-scoped id — a later
// ticket's own concern (mirroring GitHub's #13/GitLab's #33 sign-off tickets), included now so every
// provider's file-URL module has the same shape from the start.
export function pullRequestUrl(bitbucket, pullRequestId) {
  const url = repositoryUrl(bitbucket)
  url.pathname += `/pull-requests/${encodeURIComponent(pullRequestId)}`
  return url.toString()
}
