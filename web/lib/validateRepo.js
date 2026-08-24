// Real validate(repoUrl) contract for the instance-setup wizard (#94, under #88), replacing the original stub (#78): `web/lib/validateRepo.js` used to never contact Azure DevOps at all, only compare the URL's last path segment against gantry's own already-known instances (`GET /api/instances`, #76). Now it parses the standard Azure DevOps repo URL shape and asks the live repo-check route (`GET /api/azure-devops/repo-check`, #90) whether that location already holds instance data — the same three-way `empty`/`existing`/`error` contract callers (web/pages/setup-wizard.js) already depend on, just genuinely backed by Azure DevOps now.
//
// A non-`dev.azure.com` base URL (an on-premises Azure DevOps Server) is an explicit, known gap — out of scope here per docs/adr/0005 and #88's own "out of scope" list: this parser only recognizes the standard `https://dev.azure.com/{organization}/{project}/_git/{repository}` shape, and reports a clear `error` result for anything else, the same failure mode as a URL with no recognizable repo path at all.
//
// Uses `apiFetch` (not raw `fetch`), so a missing/rejected Azure DevOps PAT during the check triggers the same prompt-and-retry-once modal every other Azure-DevOps-backed request in the app already uses (#87) — this module never rolls its own credential handling.
import { apiFetch } from './apiFetch.js'

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

/**
 * @param {string} repoUrl
 * @returns {Promise< | { result: 'empty', slug: string, location: { organization: string, project: string, repository: string } } | { result: 'existing', slug: string, instance: { slug: string, definition: string, stage: string, status: string, assignee: string }, location: { organization: string, project: string, repository: string } } | { result: 'error', message: string } >}
 */
export async function validateRepo(repoUrl) {
  const location = parseRepoUrl(repoUrl)
  if (!location) {
    return {
      result: 'error',
      message:
        "Couldn't parse this as an Azure DevOps repo URL — expected " +
        'https://dev.azure.com/{organization}/{project}/_git/{repository} ' +
        '(an on-premises Azure DevOps Server URL is not yet supported).',
    }
  }

  const qs = new URLSearchParams(location).toString()
  let res
  try {
    res = await apiFetch(`/api/azure-devops/repo-check?${qs}`)
  } catch (err) {
    return { result: 'error', message: `Couldn't reach this repo — ${err.message}` }
  }

  const body = await res.json().catch(() => null)
  if (!res.ok) {
    return {
      result: 'error',
      message:
        body?.message ??
        body?.error ??
        `Couldn't reach this repo — check the URL and that gantry has access (HTTP ${res.status}).`,
    }
  }

  if (body?.result === 'found') {
    const instance = { slug: body.slug, definition: body.definition, stage: body.stage, status: body.status, assignee: body.assignee }
    return { result: 'existing', slug: instance.slug, instance, location }
  }

  // `'multiple'` (#100: one repo can now hold more than one instance under gantry-workspace/<slug>/) means data *was* found here — reporting it as `'empty'` (this function's fallback for "nothing recognizable here") would invite creating a new instance that could collide with one of the existing ones. This wizard has no way yet to let the user pick which of several existing instances to open (#101/#104), so this is surfaced as an error rather than silently treated as empty.
  if (body?.result === 'multiple') {
    return {
      result: 'error',
      message:
        body.message ??
        `This repo already holds more than one gantry instance (${(body.slugs ?? []).join(', ')}) — opening a specific one isn't supported by this wizard yet.`,
    }
  }

  return { result: 'empty', slug: location.repository, location }
}
