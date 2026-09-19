// The GitLab twin of lib/githubFileUrl.js — builds the GitLab *web* URL for a repo file, a commit, a
// merge request and an issue, given the `{ namespace, repository, baseUrl? }` location shape every
// GitLab-backed call site carries (ADR-0041, #26). Keeping this construction shared avoids the render
// pipeline's source citation and its Document Control commit link disagreeing about how a self-hosted
// GitLab host is derived.
//
// `baseUrl` on a GitLab location is always the *API* root (`lib/gitlabClient.js`'s own `baseUrl`,
// `https://gitlab.com/api/v4` by default, or `<host>/api/v4` for a self-hosted CE/EE instance, GitLab's
// own documented convention) — never the web root, since that's what every existing caller
// (`createGitLabClient`) already passes it as. A file/commit/MR/issue *link* a person clicks needs the
// web root instead, so `webBaseUrl` below derives it: the public default maps to `https://gitlab.com`,
// and a self-hosted API root has its `/api/v4` suffix stripped to reach the bare host the web UI lives at.
function webBaseUrl(gitlab) {
  const raw = (gitlab.baseUrl ?? 'https://gitlab.com/api/v4').replace(/\/+$/, '')
  if (raw === 'https://gitlab.com/api/v4') return 'https://gitlab.com'
  return raw.replace(/\/api\/v4$/i, '')
}

// `namespace` is GitLab's full group/subgroup path as one opaque string, however many segments deep
// (ADR-0041) — e.g. `engineering/platform/backend-services`. Unlike GitHub's single-segment `owner`,
// this has to be split and each segment encoded individually so a literal `/` inside it becomes a real
// path separator in the resulting URL rather than a percent-encoded `%2F` that would 404 against
// GitLab's own web UI (which — unlike its API's `:id` parameter — expects real path segments here).
function repositoryUrl(gitlab) {
  const namespaceSegments = String(gitlab.namespace)
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/')
  return new URL(`${webBaseUrl(gitlab)}/${namespaceSegments}/${encodeURIComponent(gitlab.repository)}`)
}

// Builds the GitLab web URL for a file at a specific ref (branch or commit sha) — GitLab's own
// `/<namespace>/<repository>/-/blob/<ref>/<path>` convention (the `-/` scope marker GitLab inserts
// ahead of every non-repository-root route, distinguishing it from a same-named top-level page).
export function artefactFileUrl(gitlab, path, ref) {
  const url = repositoryUrl(gitlab)
  const encodedPath = path
    .replace(/^\/+/, '')
    .split('/')
    .map(encodeURIComponent)
    .join('/')
  url.pathname += `/-/blob/${encodeURIComponent(ref)}/${encodedPath}`
  return url.toString()
}

// Builds the GitLab web URL for a specific commit.
export function commitUrl(gitlab, commitSha) {
  const url = repositoryUrl(gitlab)
  url.pathname += `/-/commit/${encodeURIComponent(commitSha)}`
  return url.toString()
}

// Builds the GitLab web URL for a merge request, addressed by its project-scoped `iid` (GitLab's own
// "internal id", the number shown in its own UI — distinct from the globally-unique `id` its API also
// returns, the same `iid`-not-`id` distinction GitLab draws for issues below).
export function mergeRequestUrl(gitlab, iid) {
  const url = repositoryUrl(gitlab)
  url.pathname += `/-/merge_requests/${encodeURIComponent(iid)}`
  return url.toString()
}

// Builds the GitLab web URL for a specific issue, addressed by its project-scoped `iid`.
export function issueUrl(gitlab, iid) {
  const url = repositoryUrl(gitlab)
  url.pathname += `/-/issues/${encodeURIComponent(iid)}`
  return url.toString()
}
