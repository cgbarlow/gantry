import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolveContentStore, resolvePullRequests, resolveIdentity } from './providerRegistry.js'
import { describeProviderLocation } from './provider.js'
import { providerDisplayName } from './providerErrors.js'
import { interpretReviewerVotes } from './stageStatus.js'
import { interpretGitHubReviews } from './githubPullRequestsClient.js'
import { interpretGitLabMergeRequest } from './gitlabPullRequestsClient.js'
import { mergeRequestUrl as gitlabMergeRequestUrl } from './gitlabFileUrl.js'
import { interpretBitbucketPullRequest } from './bitbucketPullRequestsClient.js'
import { pullRequestUrl as bitbucketPullRequestUrl } from './atlassianFileUrl.js'
import { missingLibraryPatMessage } from './libraryCache.js'

/**
 * WI #387 (Feature #380 phase 7, ADR-0036's "Promote" section) — takes a **published workspace**
 * definition version and opens one Pull Request per selected library repo, carrying the full
 * version folder across as a single commit on a fresh branch. Never writes directly to a library
 * repo's default branch (ADR-0036: "gantry proposes, it doesn't merge on their behalf") — every
 * write here is a branch + one push + a Pull Request, through each repo's own provider capabilities
 * (`lib/providerRegistry.js`, docs/adr/0039) rather than an Azure-DevOps-specific client.
 *
 * Cross-provider (#20, #36, docs/adr/0037/0039/0041): a fan-out's repos need not share a provider —
 * each resolves its own content-store/pull-requests/identity capability from `repo.provider`, and each
 * is credentialed independently (see `pat`/`pats` below). "Source" and "target" are independent
 * concepts here: this module never reads from a provider itself (see the next paragraph), so
 * "promoting across providers" reduces to "this fan-out's `repos` need not all share one provider" —
 * already true by construction once a provider (GitHub, then GitLab) registers these same three
 * capabilities.
 *
 * Credential: the server's own per-provider environment PAT (`lib/server.js`'s `libraryPats`, the
 * same map `lib/libraryCache.js` already reads every configured library repo with) — never a
 * per-browser one (ADR-0036, ADR-0039). ADR-0036's own "Consequences" section flagged this as an open
 * question ("hold, or obtain per-user, PR-creation credentials against each configured library repo")
 * without deciding it; this module's answer is to reuse the existing read credential rather than open
 * a second one, since a server that can already read a library repo's `definitions/` folder with this
 * PAT needs no new credential surface to also branch/push/open-a-PR against the same repo — see this
 * ticket's ADR amendment. `promoteDefinitionVersionToRepo` itself still takes a single `pat` (the
 * caller — `fanOutPromoteDefinitionVersion` — has already resolved it for that one repo's provider);
 * the fan-out and `checkPromotionStatus` are what resolve per-repo from a `pats` map.
 *
 * Deliberately keeps no notion of "workspace" itself — a caller supplies the version folder's files
 * directly (`readWorkspaceVersionFolderFiles` below, for a server workspace's own local disk; a
 * caller shipping a local workspace's browser-held files builds the same `{ path, content,
 * contentType }` shape itself, see `lib/server.js`'s `POST /api/local/definitions/promote`) — this
 * module only ever cares about "here are the files, here is where they're going."
 */

const PROMOTIONS_DIRNAME = '.promotions'

function definitionPromotionsDir(definitionsDir, definitionId) {
  return join(definitionsDir, definitionId, PROMOTIONS_DIRNAME)
}

/** Where a definition version's persisted promotion records live — a server-workspace's own `definitions/<id>/.promotions/<n>.json`, deliberately a sibling of (never inside) `definitions/<id>/<n>/` so it's never mistaken for part of the version folder `readWorkspaceVersionFolderFiles` ships. */
export function promotionsFilePath(definitionsDir, definitionId, version) {
  return join(definitionPromotionsDir(definitionsDir, definitionId), `${version}.json`)
}

/** The persisted promotion records for one definition version — `[]` if none have ever been recorded. */
export function readPromotions(definitionsDir, definitionId, version) {
  const path = promotionsFilePath(definitionsDir, definitionId, version)
  if (!existsSync(path)) return []
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  return Array.isArray(parsed.promotions) ? parsed.promotions : []
}

/** Replaces the persisted promotion record for `repoId` (matched by id) — every other repo's own record is left untouched, mirroring `lib/instance.js`'s "read current, only overwrite the one field" read-modify-write shape. */
export function upsertPromotion(definitionsDir, definitionId, version, record) {
  const existing = readPromotions(definitionsDir, definitionId, version)
  const next = [...existing.filter((p) => p.repoId !== record.repoId), record]
  const dir = definitionPromotionsDir(definitionsDir, definitionId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(promotionsFilePath(definitionsDir, definitionId, version), JSON.stringify({ promotions: next }, null, 2) + '\n')
  return next
}

// Which on-disk files under a version folder are binary (base64-shipped) rather than plain text —
// only the reference `.docx` (see lib/definition.js's own `isValidDocxBuffer`/`writeDefinitionReferenceDocx`);
// everything else this codebase ever writes under a version folder (definition.yaml, modules/*.yaml,
// templates/*.md, CHANGELOG.md) is UTF-8 text.
function isBinaryVersionFile(relPath) {
  return relPath.endsWith('.docx')
}

/**
 * Reads a server-workspace definition version's full on-disk folder — `definition.yaml`, every
 * `modules/*.yaml`, every `templates/*` (markdown templates and any reference `.docx`), and
 * `CHANGELOG.md` if the definition has one (WI #387's own file list) — as the flat `{ path,
 * content, contentType }` list `promoteDefinitionVersionToRepo` below ships in one push, `path`
 * relative to the version folder itself (e.g. `modules/intro.yaml`). Skips this module's own
 * `.promotions/` bookkeeping (a sibling of the version folder, never inside it — see
 * `promotionsFilePath`'s own doc comment — so there is nothing to skip in practice; the guard here
 * is only for a hand-edited version folder that happens to contain a stray one).
 */
export function readWorkspaceVersionFolderFiles(definitionsDir, definitionId, version) {
  const root = join(definitionsDir, definitionId, String(version))
  if (!existsSync(root)) {
    throw new Error(`No version folder for "${definitionId}" v${version}`)
  }
  const files = []
  function walk(dir, relPrefix) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (relPrefix === '' && entry.name === PROMOTIONS_DIRNAME) continue
      const abs = join(dir, entry.name)
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(abs, rel)
      } else {
        files.push(
          isBinaryVersionFile(rel)
            ? { path: rel, content: readFileSync(abs).toString('base64'), contentType: 'base64encoded' }
            : { path: rel, content: readFileSync(abs, 'utf8'), contentType: 'rawtext' }
        )
      }
    }
  }
  walk(root, '')
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

/** `definition/<id>-v<n>` (WI #387's exact branch-naming rule). */
export function promotionBranchName(definitionId, version) {
  return `definition/${definitionId}-v${version}`
}

// A provider-appropriate web URL for a promotion Pull Request (#20, #36) — Azure DevOps's own
// `_git/.../pullrequest/<id>` shape, GitHub's `/pull/<id>`, or GitLab's `/-/merge_requests/<iid>`.
// GitHub's REST `baseUrl` for an Enterprise Server host is `<host>/api/v3` (its own documented
// convention); the equivalent web UI is the bare host, so that suffix is stripped here rather than
// linking into the API host itself. GitLab's own web-URL derivation (stripping `/api/v4`, and — unlike
// GitHub's single-segment `owner` — splitting a multi-segment `namespace` into real path segments) is
// nontrivial enough that it lives once in `lib/gitlabFileUrl.js` and is reused here rather than
// reimplemented inline.
function pullRequestUrl(repo, pullRequestId) {
  if (repo.provider === 'github') {
    const base = (repo.location.baseUrl ?? 'https://github.com').replace(/\/api\/v3\/?$/, '').replace(/\/+$/, '')
    return `${base}/${encodeURIComponent(repo.location.owner)}/${encodeURIComponent(repo.location.repository)}/pull/${pullRequestId}`
  }
  if (repo.provider === 'gitlab') {
    return gitlabMergeRequestUrl(repo.location, pullRequestId)
  }
  if (repo.provider === 'atlassian') {
    return bitbucketPullRequestUrl(repo.location, pullRequestId)
  }
  const base = repo.location.baseUrl ?? 'https://dev.azure.com'
  return `${base}/${encodeURIComponent(repo.location.organization)}/${encodeURIComponent(repo.location.project)}/_git/${encodeURIComponent(repo.location.repository)}/pullrequest/${pullRequestId}`
}

// The reviewer-vote/review-state interpretation differs per provider (Azure DevOps's signed vote
// scale, GitHub's APPROVED/CHANGES_REQUESTED/COMMENTED/DISMISSED per docs/adr/0040, GitLab's
// approval-toggle-plus-unresolved-thread reading per docs/adr/0041, or Bitbucket's own genuine
// approved/changes_requested/pending tri-state per docs/adr/0042 — no toggle-workaround needed
// there) — each provider's own pull-requests client returns whichever raw shape its API produces
// (`reviewers`, `reviews`, `approvals`/`discussions`, or `participants`), so this is the one place
// that picks the right interpreter for it.
function interpretReviewState(provider, pr) {
  if (provider === 'github') return interpretGitHubReviews(pr.reviews)
  if (provider === 'gitlab') return interpretGitLabMergeRequest(pr)
  if (provider === 'atlassian') return interpretBitbucketPullRequest(pr)
  return interpretReviewerVotes(pr.reviewers)
}

function repoDisplayName(repo) {
  return describeProviderLocation(repo.provider, repo.location)
}

// #49 (ADR-0042): the config a reviewer-identity lookup resolves against. Every other provider's own
// location IS its one identity directory, so `{ ...repo.location, pat }` is unambiguous. Atlassian's
// own location, even a Library repo's, always carries *both* halves of the split suite —
// `owner`/`repository` (Bitbucket) and `jiraSite`/`jiraProjectKey` (Jira) — so spreading it whole
// into `lib/providerRegistry.js`'s own `createAtlassianIdentityClient` (which discriminates by
// *which* of those fields are present) would always see `jiraSite` and wrongly resolve against Jira's
// user directory instead. A promotion's required reviewer is always a *pull-request* reviewer — per
// ADR-0042's own "identity stays per-product: PR reviewers come from Bitbucket's own member list" —
// so this scopes the config down to Bitbucket's own two fields before ever reaching that dispatch,
// exactly the same "Bitbucket-only, never the full split-suite location" restriction
// `lib/definitionAtlassian.js`'s own `clientFor` already applies to reading `definitions/`.
function reviewerIdentityConfig(repo, pat) {
  if (repo.provider === 'atlassian') {
    return { owner: repo.location.owner, repository: repo.location.repository, baseUrl: repo.location.baseUrl, pat }
  }
  return { ...repo.location, pat }
}

/**
 * Promotes one definition version to one library repo: branch `definition/<id>-v<n>` from the
 * repo's default branch (`main` — every write path in this codebase already assumes this, see
 * `lib/definitionAzureDevOps.js`'s own "straight to the workspace repo's `main`"), one push
 * carrying every file in `files` as a single commit, then a Pull Request from that branch back into
 * `main` with the repo's configured `codeOwner` (if any, `lib/librarySettings.js`) attached as a
 * *required* reviewer (WI #387) — resolved the same way `lib/stageApproval.js` resolves a required
 * reviewer (`lib/azureDevOpsIdentityClient.js`), so a `codeOwner` that doesn't resolve to a real
 * identity is reported back rather than silently opening the PR with no reviewer at all.
 *
 * Refuses to re-promote onto a branch that already exists (an earlier promotion of this exact
 * version to this exact repo, still open) rather than silently pushing a second commit onto
 * somebody's in-review branch — the caller sees this as a normal per-repo failure in the fan-out
 * result, not a thrown exception that would abort every other repo's own promotion.
 */
export async function promoteDefinitionVersionToRepo({ definitionId, version, files, repo, pat }) {
  const client = resolveContentStore(repo.provider, { ...repo.location, pat })
  const branch = promotionBranchName(definitionId, version)

  if (await client.branchExists(branch)) {
    throw new Error(`Branch "${branch}" already exists in "${repoDisplayName(repo)}" — a promotion of this version is already in progress there.`)
  }
  await client.createBranch(branch, { from: 'main' })

  const versionPrefix = `definitions/${definitionId}/${version}`
  await client.writeFiles(
    files.map((f) => ({ path: `${versionPrefix}/${f.path}`, content: f.content, contentType: f.contentType })),
    { branch, message: `Promote definition "${definitionId}" v${version}` }
  )

  const prClient = resolvePullRequests(repo.provider, { ...repo.location, pat })
  const pr = await prClient.createPullRequest({
    sourceBranch: branch,
    targetBranch: 'main',
    title: `Promote definition "${definitionId}" v${version}`,
    description: `Promotes definition "${definitionId}" v${version} from a gantry workspace into this library repo. Merging this Pull Request makes it available to every gantry instance reading this repo.`,
  })

  let reviewerResolved = false
  let reviewerError = null
  if (repo.codeOwner && repo.codeOwner.trim()) {
    const identityClient = resolveIdentity(repo.provider, reviewerIdentityConfig(repo, pat))
    const resolved = await identityClient.resolveIdentity(repo.codeOwner)
    if (resolved) {
      // `id` (Azure DevOps's identity GUID) and `login` (GitHub's own reviewer identifier,
      // `resolved.uniqueName` — `lib/githubIdentityClient.js`'s own result shape) both ride along;
      // each provider's `addReviewers` reads whichever field its own API needs (#20).
      await prClient.addReviewers(pr.pullRequestId, [{ id: resolved.id, login: resolved.uniqueName, required: true }])
      reviewerResolved = true
    } else {
      reviewerError = `The configured code owner ("${repo.codeOwner}") could not be resolved to a known ${providerDisplayName(repo.provider)} identity — the Pull Request was opened with no required reviewer.`
    }
  }

  return {
    repoId: repo.id,
    repoName: repoDisplayName(repo),
    ok: true,
    branch,
    pullRequestId: pr.pullRequestId,
    pullRequestUrl: pullRequestUrl(repo, pr.pullRequestId),
    status: pr.status,
    review: { state: interpretReviewState(repo.provider, pr) },
    reviewerResolved,
    reviewerError,
    promotedAt: new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(),
  }
}

/**
 * Promotes one definition version to every repo in `repos`, independently — the multi-repo fan-out
 * WI #387 calls for ("promoting to 2+ repos at once"), now cross-provider (#20): `repos` need not
 * share a provider, so each repo's credential is resolved from `pats` (`{ 'azure-devops': <pat|null>,
 * github: <pat|null> }`, mirroring `lib/libraryCache.js`'s `refreshAllLibraryRepos`) by its own
 * `provider` rather than one credential shared across every repo. A repo whose provider has no
 * configured server PAT is reported as a failure with the same actionable, provider-naming message
 * `refreshAllLibraryRepos` uses (`missingLibraryPatMessage`) — no network call is even attempted for
 * it — never a thrown exception that would abort every other repo's own promotion.
 *
 * One repo's failure (already-open branch, rejected PAT, unreachable, or any other
 * `RequestError`/plain error) is reported as `{ repoId, repoName, ok: false, error }` and never stops
 * the others, mirroring `lib/libraryCache.js`'s `refreshAllLibraryRepos` — "a remote system this
 * server doesn't control is a less predictable failure domain than local disk."
 */
export async function fanOutPromoteDefinitionVersion({ definitionId, version, files, repos, pats }) {
  const results = []
  for (const repo of repos) {
    const pat = pats[repo.provider]
    if (!pat) {
      results.push({ repoId: repo.id, repoName: repoDisplayName(repo), ok: false, error: missingLibraryPatMessage(repo.provider) })
      continue
    }
    try {
      results.push(await promoteDefinitionVersionToRepo({ definitionId, version, files, repo, pat }))
    } catch (err) {
      results.push({ repoId: repo.id, repoName: repoDisplayName(repo), ok: false, error: err.message })
    }
  }
  return results
}

/**
 * The explicit "Check" action (WI #387: "status is read on an explicit Check, not polled — same
 * posture as sign-off", ADR-0014/lib/stageStatus.js's own `checkStageApprovalStatus`): re-reads one
 * previously-opened promotion Pull Request's current status and review state straight from its own
 * provider. Never merges it — unlike a sign-off Pull Request, a promotion PR's merge is the *library
 * repo's own* code owner's decision, made on the provider itself, unaffected by anything gantry does
 * (ADR-0036: "gantry proposes, it doesn't merge on their behalf").
 */
export async function checkPromotionStatus({ promotion, repo, pat }) {
  if (!promotion.pullRequestId) return promotion
  const prClient = resolvePullRequests(repo.provider, { ...repo.location, pat })
  const pr = await prClient.getPullRequest(promotion.pullRequestId)
  return {
    ...promotion,
    status: pr.status,
    review: { state: interpretReviewState(repo.provider, pr) },
    lastCheckedAt: new Date().toISOString(),
  }
}
