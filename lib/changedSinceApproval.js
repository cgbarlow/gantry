import { splitArtefactRequirement } from './definition.js'
import {
  readModule,
  parseModuleFile,
  migrateModuleHeadingScale,
  azureDevOpsModulePath,
  githubModulePath,
  gitlabModulePath,
} from './instance.js'
import { resolveContentStore } from './providerRegistry.js'
import { AuthenticationError, NotFoundError } from './providerErrors.js'
import { findStageBranch } from './stageBranch.js'
import { findGitHubStageBranch } from './githubStageBranch.js'
import { findGitLabStageBranch } from './gitlabStageBranch.js'
import { createAzureDevOpsPullRequestsClient } from './azureDevOpsPullRequestsClient.js'
import { createGitHubPullRequestsClient } from './githubPullRequestsClient.js'
import { createGitLabPullRequestsClient } from './gitlabPullRequestsClient.js'

// "Changed since approval" (#273, docs/adr/0069): an approved stage of a remote Instance is flagged when
// a later stage has changed a Field one of that stage's Artefacts prints. This file answers one question
// per Instance — which earlier approved stages are flagged, and by which Fields — and nothing else. It
// reads; it never writes (restoring the approved text is #274, re-approving through the later stage's
// Pull Request is #275).
//
// How Gantry "remembers the content at each stage's approval": it doesn't copy anything. A stage's
// approval is its Pull Request merging, instance.yaml already records that Pull Request's id
// (`pullRequests[stageId]`), and the Provider holds the merge commit — so the commit to compare against
// is the merge commit of that Pull Request. That is also why an Instance approved before this rule
// existed is covered with no migration: its Pull Request is recorded and merged already.

const PROVIDERS = {
  azureDevOps: {
    optionKey: 'azureDevOps',
    contentStoreId: 'azure-devops',
    modulePath: azureDevOpsModulePath,
    findStageBranch,
    pullRequests: createAzureDevOpsPullRequestsClient,
    // Azure DevOps reports the merge commit as `lastMergeCommit` once a Pull Request is completed.
    mergeCommitOf: (pullRequest) => (pullRequest.status === 'completed' ? pullRequest.lastMergeCommit?.commitId ?? null : null),
    // Reading a file at a commit instead of a branch needs the version type spelled out.
    readAtCommit: (store, path, commit) => store.getFileContent(path, { branch: commit, versionType: 'commit' }),
    repoKey: (base) => `ado:${base.baseUrl ?? ''}/${base.organization}/${base.project}/${base.repository}`,
  },
  github: {
    optionKey: 'github',
    contentStoreId: 'github',
    modulePath: githubModulePath,
    findStageBranch: findGitHubStageBranch,
    pullRequests: createGitHubPullRequestsClient,
    mergeCommitOf: (pullRequest) => (pullRequest.status === 'completed' ? pullRequest.mergeCommit ?? null : null),
    // GitHub's Contents API takes a commit id wherever it takes a branch name.
    readAtCommit: (store, path, commit) => store.getFileContent(path, { branch: commit }),
    repoKey: (base) => `github:${base.baseUrl ?? ''}/${base.owner}/${base.repository}`,
  },
  gitlab: {
    optionKey: 'gitlab',
    contentStoreId: 'gitlab',
    modulePath: gitlabModulePath,
    findStageBranch: findGitLabStageBranch,
    pullRequests: createGitLabPullRequestsClient,
    mergeCommitOf: (pullRequest) => (pullRequest.status === 'completed' ? pullRequest.mergeCommit ?? null : null),
    // GitLab's Repository Files API takes a commit id as `ref`.
    readAtCommit: (store, path, commit) => store.getFileContent(path, { branch: commit }),
    repoKey: (base) => `gitlab:${base.baseUrl ?? ''}/${base.namespace}/${base.repository}`,
  },
}

// Immutable by construction — a merge commit and the files at it never change — so these never need
// invalidating. Bounded only so a long-running server can't grow them without limit.
const MAX_CACHE_ENTRIES = 5000
const approvalCommitCache = new Map() // `${repoKey} #${pullRequestId}` -> merge commit id
const approvedFieldsCache = new Map() // `${repoKey} ${slug} ${commit} ${moduleId}` -> fields | null

function remember(cache, key, value) {
  if (cache.size >= MAX_CACHE_ENTRIES) cache.clear()
  cache.set(key, value)
  return value
}

/**
 * The Fields an earlier stage's Artefacts print: a Map of moduleId -> Set of fieldIds, from the `requires`
 * lists of every Artefact at the stage's Gate. A bare module entry prints all of that module's Fields; a
 * `module.field` entry (optional or not) prints that one. Fields only later Artefacts print are not in it,
 * which is what keeps a shared module growing across stages from raising the flag (ADR-0069).
 */
export function printedFields(definition, stage) {
  const printed = new Map()
  for (const artefact of definition.artefacts.filter((a) => a.gate === stage.gate)) {
    for (const requirement of artefact.requires ?? []) {
      const { moduleId, fieldId } = splitArtefactRequirement(requirement)
      const moduleSpec = definition.modules.get(moduleId)
      if (!moduleSpec) continue
      const ids = printed.get(moduleId) ?? new Set()
      if (fieldId) ids.add(fieldId)
      else for (const field of moduleSpec.fields) ids.add(field.id)
      printed.set(moduleId, ids)
    }
  }
  return printed
}

// A Field's value as compared for this check: surrounding whitespace and line-ending style don't count
// as a change, and an absent Field, an empty one and an empty list are the same "nothing".
function comparableValue(value) {
  if (Array.isArray(value)) {
    const items = value.map((item) => String(item).trim()).filter(Boolean)
    return items.length ? JSON.stringify(items) : ''
  }
  if (value === undefined || value === null) return ''
  return String(value).replace(/\r\n/g, '\n').trim()
}

/**
 * Which printed Fields differ between two reads of the same Instance. `approved` and `current` are Maps of
 * moduleId -> parsed fields object (or `null`/absent for a Module with no saved data). Returns
 * `module.field` references in the Definition's order.
 */
export function changedPrintedFields(definition, printed, approved, current) {
  const changed = []
  for (const [moduleId, fieldIds] of printed) {
    const moduleSpec = definition.modules.get(moduleId)
    for (const field of moduleSpec.fields) {
      if (!fieldIds.has(field.id)) continue
      if (comparableValue(approved.get(moduleId)?.[field.id]) !== comparableValue(current.get(moduleId)?.[field.id])) {
        changed.push(`${moduleId}.${field.id}`)
      }
    }
  }
  return changed
}

async function approvalCommitFor(provider, base, pullRequestId) {
  const key = `${provider.repoKey(base)} #${pullRequestId}`
  if (approvalCommitCache.has(key)) return approvalCommitCache.get(key)
  let pullRequest
  try {
    pullRequest = await provider.pullRequests(base).getPullRequest(pullRequestId)
  } catch (err) {
    // A Pull Request the Provider no longer has can't be an approval to compare against.
    if (err instanceof NotFoundError) return null
    throw err
  }
  const commit = provider.mergeCommitOf(pullRequest)
  // Only a merged Pull Request has a settled answer; an open or abandoned one is looked at again next time.
  return commit ? remember(approvalCommitCache, key, commit) : null
}

async function approvedModuleFields(definition, provider, base, slug, commit, moduleId) {
  const key = `${provider.repoKey(base)} ${slug} ${commit} ${moduleId}`
  if (approvedFieldsCache.has(key)) return approvedFieldsCache.get(key)
  const moduleSpec = definition.modules.get(moduleId)
  // Deliberately not `readModule`: that writes a heading-scale migration back to "the branch", and here
  // the "branch" is a commit. Migrate in memory only, so old and new files compare alike.
  // No shared read cache either — it asks for a branch's ref, and a commit id isn't one.
  const { sharedCache: _sharedCache, branch: _branch, ...uncachedBase } = base
  const store = resolveContentStore(provider.contentStoreId, uncachedBase)
  let fields = null
  try {
    const text = await provider.readAtCommit(store, provider.modulePath(slug, moduleId), commit)
    fields = parseModuleFile(migrateModuleHeadingScale(text, moduleSpec), moduleSpec).fields
  } catch (err) {
    // A Module with no file at the approval commit was simply empty then.
    if (!(err instanceof NotFoundError)) throw err
  }
  return remember(approvedFieldsCache, key, fields)
}

async function currentModuleFields(definition, provider, base, slug, branch, moduleId) {
  try {
    const read = await readModule(definition, slug, moduleId, { [provider.optionKey]: { ...base, branch } })
    return read.fields
  } catch (err) {
    if (/has no saved data/.test(err.message)) return null
    throw err
  }
}

/**
 * Every earlier approved stage of a remote Instance whose printed Fields the Instance's current content
 * has changed since that stage's approval, in stage order:
 *
 *   [{ stageId, title, pullRequestId, approvalCommit, fields: ['module.field', ...], count }]
 *
 * - `providerKey`: `'azureDevOps'`, `'github'` or `'gitlab'`; any other provider has no flag.
 * - `base`: that provider's credentialed location (what `readInstance` takes as `options[providerKey]`),
 *   without a branch.
 * - `instance`: the Instance record as read from `main` — `stage` is the current stage and
 *   `pullRequests` holds each stage's approval Pull Request.
 * - `currentBranch`: the branch holding the current stage's content, or `null` for `main`. Left out
 *   (`undefined`), it is looked up — read-only, never creating a branch.
 *
 * "Earlier" means before the current stage; the current stage's own approval is the one being worked
 * towards. A stage whose Pull Request is recorded but not merged, or whose approval can't be found, is
 * not approved and is skipped. Local and server workspaces have no Pull Requests and never reach here.
 */
export async function findChangedSinceApproval({ providerKey, base, slug, definition, instance, currentBranch }) {
  const provider = PROVIDERS[providerKey]
  // Bitbucket has no stage-approval content reads wired in yet, so there is nothing to compare against.
  if (!provider) return []

  const currentIndex = definition.stages.findIndex((stage) => stage.id === instance.stage)
  if (currentIndex <= 0) return []

  const candidates = []
  for (const stage of definition.stages.slice(0, currentIndex)) {
    const pullRequestId = instance.pullRequests?.[stage.id]
    if (!pullRequestId) continue
    const printed = printedFields(definition, stage)
    if (printed.size === 0) continue
    candidates.push({ stage, pullRequestId, printed })
  }
  if (candidates.length === 0) return []

  const branch = currentBranch === undefined ? await provider.findStageBranch(base, slug, instance.stage) : currentBranch
  const approvals = await Promise.all(
    candidates.map(async (candidate) => ({ ...candidate, commit: await approvalCommitFor(provider, base, candidate.pullRequestId) }))
  )
  const approved = approvals.filter((candidate) => candidate.commit)
  if (approved.length === 0) return []

  const moduleIds = [...new Set(approved.flatMap((candidate) => [...candidate.printed.keys()]))]
  const current = new Map(
    await Promise.all(
      moduleIds.map(async (moduleId) => [moduleId, await currentModuleFields(definition, provider, base, slug, branch || undefined, moduleId)])
    )
  )

  const flagged = []
  for (const candidate of approved) {
    const approvedFields = new Map(
      await Promise.all(
        [...candidate.printed.keys()].map(async (moduleId) => [
          moduleId,
          await approvedModuleFields(definition, provider, base, slug, candidate.commit, moduleId),
        ])
      )
    )
    const fields = changedPrintedFields(definition, candidate.printed, approvedFields, current)
    if (fields.length > 0) {
      flagged.push({
        stageId: candidate.stage.id,
        title: candidate.stage.title,
        pullRequestId: candidate.pullRequestId,
        approvalCommit: candidate.commit,
        fields,
        count: fields.length,
      })
    }
  }
  return flagged
}

/**
 * `findChangedSinceApproval` for callers that are building a larger answer (the instance read, a dashboard
 * row) and must not fail it over this advisory flag: a credential problem still propagates so the usual
 * "authentication required" handling applies, but any other failure reading the Provider yields no flag.
 */
export async function findChangedSinceApprovalSafely(args) {
  try {
    return await findChangedSinceApproval(args)
  } catch (err) {
    if (err instanceof AuthenticationError) throw err
    console.error(`lib/changedSinceApproval.js: could not check "${args.slug}" for changes since approval — ${err.message}`)
    return []
  }
}
