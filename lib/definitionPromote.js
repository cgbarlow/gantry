import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createAzureDevOpsClient, AzureDevOpsRequestError } from './azureDevOpsClient.js'
import { createAzureDevOpsPullRequestsClient } from './azureDevOpsPullRequestsClient.js'
import { createAzureDevOpsIdentityClient } from './azureDevOpsIdentityClient.js'
import { interpretReviewerVotes } from './stageStatus.js'

/**
 * WI #387 (Feature #380 phase 7, ADR-0036's "Promote" section) — takes a **published workspace**
 * definition version and opens one Pull Request per selected library repo, carrying the full
 * version folder across as a single commit on a fresh branch. Never writes directly to a library
 * repo's default branch (ADR-0036: "gantry proposes, it doesn't merge on their behalf") — every
 * write here is a branch + one push + a Pull Request, reusing `lib/azureDevOpsClient.js` (phase 3's
 * commit primitives) and `lib/azureDevOpsPullRequestsClient.js` (ADR-0014's PR primitives)
 * unchanged, rather than a third Azure DevOps client.
 *
 * Credential: the server's own `GANTRY_LIBRARY_PAT` (`lib/server.js`'s `libraryPat`, the same one
 * `lib/libraryCache.js` already reads every configured library repo with) — never a per-browser
 * one. ADR-0036's own "Consequences" section flagged this as an open question ("hold, or obtain
 * per-user, PR-creation credentials against each configured library repo") without deciding it;
 * this module's answer is to reuse the existing read credential rather than open a second one, since
 * a server that can already read a library repo's `definitions/` folder with this PAT needs no new
 * credential surface to also branch/push/open-a-PR against the same repo — see this ticket's ADR
 * amendment.
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

function pullRequestUrl(repo, pullRequestId) {
  const base = repo.baseUrl ?? 'https://dev.azure.com'
  return `${base}/${encodeURIComponent(repo.organization)}/${encodeURIComponent(repo.project)}/_git/${encodeURIComponent(repo.repository)}/pullrequest/${pullRequestId}`
}

function repoDisplayName(repo) {
  return `${repo.organization}/${repo.project}/${repo.repository}`
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
  const client = createAzureDevOpsClient({ organization: repo.organization, project: repo.project, repository: repo.repository, baseUrl: repo.baseUrl, pat })
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

  const prClient = createAzureDevOpsPullRequestsClient({ organization: repo.organization, project: repo.project, repository: repo.repository, baseUrl: repo.baseUrl, pat })
  const pr = await prClient.createPullRequest({
    sourceBranch: branch,
    targetBranch: 'main',
    title: `Promote definition "${definitionId}" v${version}`,
    description: `Promotes definition "${definitionId}" v${version} from a gantry workspace into this library repo. Merging this Pull Request makes it available to every gantry instance reading this repo.`,
  })

  let reviewerResolved = false
  let reviewerError = null
  if (repo.codeOwner && repo.codeOwner.trim()) {
    const identityClient = createAzureDevOpsIdentityClient({ organization: repo.organization, project: repo.project, baseUrl: repo.baseUrl, pat })
    const resolved = await identityClient.resolveIdentity(repo.codeOwner)
    if (resolved) {
      await prClient.addReviewers(pr.pullRequestId, [{ id: resolved.id, required: true }])
      reviewerResolved = true
    } else {
      reviewerError = `The configured code owner ("${repo.codeOwner}") could not be resolved to a known Azure DevOps identity — the Pull Request was opened with no required reviewer.`
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
    review: { state: interpretReviewerVotes(pr.reviewers) },
    reviewerResolved,
    reviewerError,
    promotedAt: new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(),
  }
}

/**
 * Promotes one definition version to every repo in `repos`, independently — the multi-repo fan-out
 * WI #387 calls for ("promoting to 2+ repos at once"). One repo's failure (already-open branch,
 * rejected PAT, unreachable, or any other `AzureDevOpsRequestError`/plain error) is reported as
 * `{ repoId, repoName, ok: false, error }` and never stops the others, mirroring
 * `lib/libraryCache.js`'s `refreshAllLibraryRepos` — "a remote system this server doesn't control is
 * a less predictable failure domain than local disk."
 */
export async function fanOutPromoteDefinitionVersion({ definitionId, version, files, repos, pat }) {
  const results = []
  for (const repo of repos) {
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
 * previously-opened promotion Pull Request's current status and reviewer votes straight from Azure
 * DevOps. Never merges it — unlike a sign-off Pull Request, a promotion PR's merge is the *library
 * repo's own* code owner's decision, made in Azure DevOps itself, unaffected by anything gantry does
 * (ADR-0036: "gantry proposes, it doesn't merge on their behalf").
 */
export async function checkPromotionStatus({ promotion, repo, pat }) {
  if (!promotion.pullRequestId) return promotion
  const prClient = createAzureDevOpsPullRequestsClient({ organization: repo.organization, project: repo.project, repository: repo.repository, baseUrl: repo.baseUrl, pat })
  const pr = await prClient.getPullRequest(promotion.pullRequestId)
  return {
    ...promotion,
    status: pr.status,
    review: { state: interpretReviewerVotes(pr.reviewers) },
    lastCheckedAt: new Date().toISOString(),
  }
}

export { AzureDevOpsRequestError }
