// The GitHub twin of lib/azureDevOpsFileUrl.js — builds the GitHub *web* URL for a repo file and for a
// commit, given the same `{ owner, repository, baseUrl? }` location shape every GitHub-backed call site
// already carries (#8, #11). Keeping this construction shared avoids the render pipeline's source
// citation and its Document Control commit link disagreeing about how a GitHub Enterprise Server host
// is derived.
//
// `baseUrl` on a GitHub location is always the *API* root (`lib/githubClient.js`'s own `baseUrl`,
// `https://api.github.com` by default, or `<host>/api/v3` for GitHub Enterprise Server, GitHub's own
// documented convention) — never the web root, since that's what every existing caller
// (`createGitHubClient`, `checkGitHubRepo`) already passes it as. A file/commit *link* a person clicks
// needs the web root instead, so `webBaseUrl` below derives it: the public default maps to
// `https://github.com`, and a GHE API root has its `/api/v3` suffix stripped to reach the bare host the
// web UI lives at.
function webBaseUrl(github) {
  const raw = (github.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '')
  if (raw === 'https://api.github.com') return 'https://github.com'
  return raw.replace(/\/api\/v3$/i, '')
}

function repositoryUrl(github) {
  return new URL(`${webBaseUrl(github)}/${encodeURIComponent(github.owner)}/${encodeURIComponent(github.repository)}`)
}

// Builds the GitHub web URL for a file at a specific ref (branch or commit sha) — GitHub's own
// `/<owner>/<repo>/blob/<ref>/<path>` convention.
export function artefactFileUrl(github, path, ref) {
  const url = repositoryUrl(github)
  const encodedPath = path
    .replace(/^\/+/, '')
    .split('/')
    .map(encodeURIComponent)
    .join('/')
  url.pathname += `/blob/${encodeURIComponent(ref)}/${encodedPath}`
  return url.toString()
}

// Builds the GitHub web URL for a specific commit.
export function commitUrl(github, commitSha) {
  const url = repositoryUrl(github)
  url.pathname += `/commit/${encodeURIComponent(commitSha)}`
  return url.toString()
}

// Builds the GitHub web URL for a pull request (#13) — the link `lib/stageApproval.js`'s
// `requestGitHubStageApproval` hands back alongside the Azure DevOps path's own `webUrl`, so a caller
// never has to construct it itself from separate owner/repository fields.
export function pullRequestUrl(github, pullRequestId) {
  const url = repositoryUrl(github)
  url.pathname += `/pull/${encodeURIComponent(pullRequestId)}`
  return url.toString()
}

// Builds the GitHub web URL for a specific issue — #15's Request Review issues, and a linked
// parent/stage issue, share this one builder rather than each call site deriving the web root itself.
export function issueUrl(github, number) {
  const url = repositoryUrl(github)
  url.pathname += `/issues/${encodeURIComponent(number)}`
  return url.toString()
}
