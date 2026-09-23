import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

// n's hex digits, zero-padded to a *fixed* width (7) and placed at the *front* of the 40-character id, followed by a fixed run of zeroes — not simply end-padded ("n.toString(16).padEnd(40, '0')"), which is not actually collision-free: end-padding drops any distinction between how many significant hex digits n has, so e.g. objectIdFor(1) ("1" + 39 zeroes) and objectIdFor(16) ("10" + 38 zeroes) produce the exact same 40-character string. Fixing the width of the leading hex digits before the zero-fill avoids that collision for any n below 16^7 — far more pushes than any test here performs — while still keeping distinct commit numbers distinguishable in their first few characters (e.g. objectIdFor(1) -> "0000001...", objectIdFor(16) -> "0000010..."), which tests asserting on a render footer's short (first-N-character) commit hash (#98) need.
function objectIdFor(n) {
  return n.toString(16).padStart(7, '0') + '0'.repeat(33)
}

// Mirrors lib/azureDevOpsClient.js's own ZERO_OBJECT_ID — the all-zero id Azure DevOps uses in a ref update's oldObjectId/newObjectId to mean "this ref doesn't exist" (creating a new branch) or "delete this ref", respectively.
const ZERO_OBJECT_ID = '0'.repeat(40)

// Generic fallback states for any work item type not given an explicit entry in `workItemTypeStates` — plausible-looking but not meant to match any one real process template exactly (tests that care about a specific type's states pass `workItemTypeStates` explicitly).
const DEFAULT_WORK_ITEM_TYPE_STATES = [
  { name: 'New', category: 'Proposed', color: 'b2b2b2' },
  { name: 'Active', category: 'InProgress', color: '007acc' },
  { name: 'Resolved', category: 'Resolved', color: 'ff9d00' },
  { name: 'Closed', category: 'Completed', color: '339933' },
]

// Generic fallback project work item type list, used when a test doesn't
// pass its own `workItemTypes` — plausible-looking (mirrors a stock Basic
// process template) but not meant to match any one real process template
// exactly, the same "generic, not authoritative" spirit as
// DEFAULT_WORK_ITEM_TYPE_STATES above.
const DEFAULT_WORK_ITEM_TYPES = [
  { name: 'Epic', referenceName: 'Microsoft.VSTS.WorkItemTypes.Epic', description: 'Tracks a big initiative', color: 'ff7b00', icon: { id: 'icon_crown', url: '' }, isDisabled: false },
  { name: 'Feature', referenceName: 'Microsoft.VSTS.WorkItemTypes.Feature', description: 'Tracks a feature', color: '773b93', icon: { id: 'icon_trophy', url: '' }, isDisabled: false },
  { name: 'Task', referenceName: 'Microsoft.VSTS.WorkItemTypes.Task', description: 'Tracks work to be done', color: 'f2cb1d', icon: { id: 'icon_clipboard', url: '' }, isDisabled: false },
  { name: 'Bug', referenceName: 'Microsoft.VSTS.WorkItemTypes.Bug', description: 'Tracks a defect', color: 'cc293d', icon: { id: 'icon_insect', url: '' }, isDisabled: false },
]

/**
 * A minimal in-process fake of the Azure DevOps Git Items/Refs/Pushes REST API, standing in for a real `dev.azure.com` org/project/repo in tests (#84) — a real HTTP server on an ephemeral port that lib/azureDevOpsClient.js talks to over real `fetch` calls, never a mock of `fetch` itself. Extended by #99 to also fake the Work Items create/update/get-type-states endpoints lib/azureDevOpsWorkItemsClient.js talks to, the same way, and by #118 to actually track each branch's content independently (previously every read/write landed in one flat store regardless of what branch the client asked for — fine while no caller ever passed anything but the client's own `'main'` default, but unable to prove a non-`'main'` branch is genuinely isolated).
 *
 * `files` seeds `main`'s initial content, keyed by repo-relative path (leading "/" optional). `branchFiles`, if given, seeds one or more *other* branches the same way (`{ [branchName]: { [path]: content } }`) — for a test that needs a second branch to already exist (e.g. to prove a write to it doesn't leak into `main`) without first driving a real push to create it. `validPat` is the PAT (or, if an array, any one of several PATs — e.g. to exercise replacing one valid PAT with another) accepted as the password half of HTTP Basic auth (empty username) — anything else, or no Authorization header at all, gets a 401, mirroring how a rejected PAT surfaces from the real API.
 *
 * `repoExists` (default `true`) controls whether the GET .../_apis/git/repositories/{repo} endpoint reports the repository as existing. When `false`, the endpoint returns 404, simulating a nonexistent Azure DevOps repository — used by lib/repoCheck.js tests to exercise the "repository doesn't exist" path. Every other Git endpoint (items, refs, pushes) continues to work normally when `repoExists` is `false`, since the real Azure DevOps API treats the repository metadata check as independent from whether you have direct access to its contents.
 *
 *
 * `failAfterPushes`, if given, makes every push (POST .../pushes) once `failAfterPushes` pushes have already committed successfully *during this server's lifetime, across every branch* fail with a 500 — simulating a mid-flow outage (a network blip, an expired PAT) for tests that need to exercise a caller's partial-failure handling (e.g. a multi-file create like createInstance's Azure DevOps path) without that test depending on how many GETs the client happens to make per push. Counted separately from any branch's own commit count (each of which seeds at 1 when that branch is given non-empty `files`/`branchFiles` content) so `failAfterPushes` always means "N real pushes made against this server", regardless of how many branches were seeded with an initial commit. Reads (`items`/`refs`) are never affected by this — only the write path.
 *
 * `workItemTypeStates`, if given, maps a work item type name (e.g. "Task") to the array of valid states GET .../workitemtypes/{type}/states should report for it — either full `{ name, category, color }` entries (Azure DevOps's own shape) or plain state-name strings (auto-filled with placeholder category/color). Falls back to a generic 4-state list for any type not given an explicit entry.
 *
 * Extended by #120 to also fake the Pull Requests create/get/complete endpoints lib/azureDevOpsPullRequestsClient.js talks to, plus the "cast a vote" endpoint (PUT .../pullrequests/{id}/reviewers/{reviewerId}) — not something that client itself exposes (voting is the Owner's own action, performed in Azure DevOps's real UI, per ADR-0014), but faked here so tests can simulate "the Owner approved/rejected this" via a plain `fetch` call against this same fake server, the same way a real test would exercise "Check status" detecting that vote.
 * `denyReviewerVoteReset`, when true, makes vote-reset PUTs return 403 so
 * tests can exercise ADR-0018's automated-comment fallback.
 *
 * `workItemTypes`, if given, is the array GET .../workitemtypes (the whole project's list of work item types, #121) should report — either full Azure-DevOps-shaped entries or plain type-name strings (auto-filled with placeholder description/color/icon). Falls back to a generic 4-type list (Epic/Feature/Task/Bug) when omitted.
 */
export function createFakeAzureDevOpsServer({
  organization,
  project,
  repository,
  validPat,
  files = {},
  branchFiles = {},
  failAfterPushes,
  workItemTypeStates = {},
  workItemTypes,
  denyReviewerVoteReset = false,
  rejectIdentityRequests = false,
  repoExists = true,
  connectionDataUser,
  simulateMissingReviewStatusField = false,
  // #126: whether this PAT's account has GenericContribute (push) access to this repository — the
  // fake's answer to the Permissions "Has Permissions" endpoint `lib/azureDevOpsClient.js`'s own
  // `hasWriteAccess` calls. Defaults to `true`; pass `false` to simulate a PAT that reads fine but
  // cannot write.
  canWrite = true,
} = {}) {
  // One independent { store, objectId } per branch — a branch with no
  // entry here has never had a commit (mirrors the pre-#118 "commitCount
  // === 0" case for `main`): its ref doesn't exist yet and every path
  // under it 404s/lists empty, exactly like an unset repo did before any
  // branch other than `main` existed at all.
  const branches = new Map()
  // A single counter shared across every branch, not one per branch —
  // real Azure DevOps commit ids are globally unique regardless of which
  // ref they're reachable from, and `failAfterPushes`'s "N real pushes"
  // contract (above) already depends on counting pushes globally too.
  let globalCommitCount = 0

  function seedBranch(name, seedFiles) {
    const entries = Object.entries(seedFiles)
    if (entries.length === 0) return
    const store = new Map(entries.map(([path, content]) => [path.startsWith('/') ? path : `/${path}`, content]))
    globalCommitCount += 1
    const objectId = objectIdFor(globalCommitCount)
    const now = new Date().toISOString()
    branches.set(name, {
      store,
      objectId,
      commits: [{ commitId: objectId, comment: 'Initial repository content', author: { name: 'Fake Seeder', date: now }, committer: { name: 'Fake Seeder', date: now } }],
      baseStore: new Map(store),
      baseObjectId: objectId,
    })
  }
  seedBranch('main', files)
  for (const [branchName, seedFiles] of Object.entries(branchFiles)) {
    seedBranch(branchName, seedFiles)
  }

  let pushesMade = 0

  const basePath = `/${organization}/${project}/_apis/git/repositories/${repository}`
  const witBasePath = `/${organization}/${project}/_apis/wit`
  const orgWorkItemsPath = `/${organization}/_apis/wit/workItems`

  // In-memory Work Items store, separate from the Git `store` above — keyed by numeric id, seeded empty (no `files`-style seeding option; tests create whatever work items they need via the client itself).
  const workItems = new Map()
  let nextWorkItemId = 1

  // In-memory Pull Requests store, separate from both the Git `store` and the Work Items store above — keyed by numeric id, seeded empty (tests create whatever pull requests they need via the client itself).
  const pullRequests = new Map()
  let nextPullRequestId = 1

  // Applies an Azure DevOps JSON Patch document (as sent by lib/azureDevOpsWorkItemsClient.js's fieldsToPatch) to a fake work item's fields/relations — only the "add a field" and "append a relation" shapes that client actually produces, not general JSON Patch (this fake only needs to satisfy its one real caller).
  function applyWorkItemPatch(workItem, patch) {
    for (const op of patch) {
      if (op.path === '/relations/-' && op.op === 'add') {
        workItem.relations.push(op.value)
      } else if (op.path.startsWith('/fields/')) {
        const field = op.path.slice('/fields/'.length)
        if (op.op === 'remove') delete workItem.fields[field]
        else workItem.fields[field] = op.value
      }
    }
  }

  function workItemResponseBody(workItem) {
    return {
      id: workItem.id,
      rev: workItem.rev,
      fields: workItem.fields,
      relations: workItem.relations,
      url: `${orgWorkItemsPath}/${workItem.id}`,
    }
  }

  function pullRequestResponseBody(pr) {
    return {
      pullRequestId: pr.pullRequestId,
      codeReviewId: pr.pullRequestId,
      status: pr.status,
      title: pr.title,
      description: pr.description,
      sourceRefName: pr.sourceRefName,
      targetRefName: pr.targetRefName,
      reviewers: pr.reviewers,
      creationDate: pr.creationDate,
      closedDate: pr.closedDate,
      mergeStatus: pr.mergeStatus,
      lastMergeSourceCommit: pr.lastMergeSourceCommit,
      lastMergeTargetCommit: pr.lastMergeTargetCommit,
      completionOptions: pr.completionOptions,
      url: `${basePath}/pullRequests/${pr.pullRequestId}`,
    }
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake-azure-devops.invalid')
    // Decode percent-encoded path segments before route-matching, the way a real HTTP server/router does — lets this fake exercise the client's URL-encoding of organisation/project/repository names (which may contain spaces or other reserved characters) rather than only matching when those names happen to need no encoding.
    const pathname = decodeURIComponent(url.pathname)
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    const [, encoded] = (req.headers['authorization'] ?? '').split(' ')
    const decoded = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : ''
    const providedPat = decoded.startsWith(':') ? decoded.slice(1) : undefined
    const validPats = Array.isArray(validPat) ? validPat : [validPat]
    if (!validPats.includes(providedPat)) {
      return json(401, { message: 'TF400813: The user is not authorized (fake: invalid or missing PAT).' })
    }

    // GET the repository metadata itself — lib/azureDevOpsClient.js's
    // repoExists() calls this to distinguish "repository doesn't exist" from
    // "empty repository".  `repoExists` (the test fixture param, default
    // true) controls this independently of whether files were seeded.
    if (req.method === 'GET' && pathname === `${basePath}`) {
      if (!repoExists) {
        return json(404, { message: `TF401174: Repository ${repository} not found (fake server).` })
      }
      return json(200, { id: repository, name: repository, defaultBranch: 'refs/heads/main', project: { id: project, name: project } })
    }

    if (req.method === 'GET' && pathname === `${basePath}/commits`) {
      const branchName = url.searchParams.get('searchCriteria.itemVersion.version') ?? 'main'
      const compareBranchName = url.searchParams.get('searchCriteria.compareVersion.version')
      let commits = branches.get(branchName)?.commits ?? []
      if (compareBranchName) {
        const compareCommits = branches.get(compareBranchName)?.commits ?? []
        const compareIds = new Set(compareCommits.map((c) => c.commitId))
        commits = commits.filter((c) => !compareIds.has(c.commitId))
      }
      const top = Number(url.searchParams.get('$top') ?? commits.length)
      return json(200, { count: commits.length, value: commits.slice().reverse().slice(0, top) })
    }

    // #140: the Diffs "commit-diffs" endpoint lib/azureDevOpsClient.js's
    // getCommitDiffs talks to — modeled on real Azure DevOps's own documented
    // contract (learn.microsoft.com/.../git/diffs/get): `aheadCount` is how
    // many commits `targetVersion` has that `baseVersion` lacks, `behindCount`
    // the reverse, and `commonCommit` their merge base. Both `baseVersion` and
    // `targetVersion` here are always one of this fake's own branch names (its
    // one real caller, WI256/#140's stage-sync code, never asks it for a bare
    // commit id) — each branch's `commits` array is itself a full, ordered
    // history back to the repo's root (branch-creation clones its source's
    // array, a push appends to it), so two branches' shared history is always
    // an exact, same-order prefix of both arrays, making "the last commit at
    // which the two arrays still agree" a correct merge base for this fake's
    // model (never a real 3-way-merge DAG, but git-diffs/get.md#140's one
    // caller never sees a case that would need one).
    if (req.method === 'GET' && pathname === `${basePath}/diffs/commits`) {
      const baseVersion = url.searchParams.get('baseVersion')
      const targetVersion = url.searchParams.get('targetVersion')
      const diffCommonCommit = url.searchParams.get('diffCommonCommit') === 'true'
      const baseBranch = branches.get(baseVersion)
      const targetBranch = branches.get(targetVersion)
      const baseCommits = baseBranch?.commits ?? []
      const targetCommits = targetBranch?.commits ?? []
      const baseIds = new Set(baseCommits.map((c) => c.commitId))
      const targetIds = new Set(targetCommits.map((c) => c.commitId))
      const aheadCount = targetCommits.filter((c) => !baseIds.has(c.commitId)).length
      const behindCount = baseCommits.filter((c) => !targetIds.has(c.commitId)).length
      let commonCommit = null
      const sharedLen = Math.min(baseCommits.length, targetCommits.length)
      for (let i = 0; i < sharedLen; i++) {
        if (baseCommits[i].commitId === targetCommits[i].commitId) commonCommit = baseCommits[i].commitId
        else break
      }
      // The tree at `commonCommit`: whichever of the two branches actually
      // diverged from it still has that exact snapshot in its own `baseStore`
      // (captured once, at branch-creation/last-fast-forward time, and never
      // touched by a later push to either side — see `seedBranch`/the refs
      // and pushes handlers above). Diffing straight `baseVersion`→`targetVersion`
      // (diffCommonCommit: false) needs no such lookup — it just compares
      // both branches' current stores directly.
      let oldStore
      if (diffCommonCommit) {
        if (baseBranch?.baseObjectId === commonCommit) oldStore = baseBranch.baseStore
        else if (targetBranch?.baseObjectId === commonCommit) oldStore = targetBranch.baseStore
        else oldStore = new Map()
      } else {
        oldStore = baseBranch?.store ?? new Map()
      }
      const newStore = targetBranch?.store ?? new Map()
      const changes = []
      const allPaths = new Set([...oldStore.keys(), ...newStore.keys()])
      for (const path of allPaths) {
        const before = oldStore.get(path)
        const after = newStore.get(path)
        if (before === after) continue
        changes.push({ item: { path, isFolder: false }, changeType: before === undefined ? 'add' : after === undefined ? 'delete' : 'edit' })
      }
      changes.sort((a, b) => a.item.path.localeCompare(b.item.path))
      // Mirrors the real endpoint's own `$top`/`allChangesIncluded` contract (learn.microsoft.com/.../git/diffs/get):
      // more changed paths than `$top` asked for means the page sent back is a truncated prefix, and
      // `allChangesIncluded` says so — lib/azureDevOpsClient.js's getCommitDiffs (its `$top=2000`) and its
      // callers (#140's stage-sync advisory) rely on this flag to notice when `changes` might be incomplete.
      const top = Number(url.searchParams.get('$top') ?? changes.length)
      const allChangesIncluded = changes.length <= top
      return json(200, { aheadCount, behindCount, commonCommit, changes: changes.slice(0, top), allChangesIncluded })
    }

    if (req.method === 'GET' && pathname === `${basePath}/items`) {
      // Every real call here (lib/azureDevOpsClient.js's getFileContent/
      // listFolder) always sends `versionDescriptor.version` — defaulting
      // to `'main'` here too only guards a test hitting this fake directly
      // without going through that client. #118: this is what makes reads
      // branch-aware — each branch has its own independent store below,
      // never one shared flat one.
      const branchName = url.searchParams.get('versionDescriptor.version') ?? 'main'
      const branch = branches.get(branchName)
      const store = branch?.store ?? new Map()

      const scopePath = url.searchParams.get('scopePath')
      // A `scopePath` (+`recursionLevel`, always `OneLevel` for this fake's one real caller, lib/azureDevOpsClient.js's `listFolder`) requests a folder listing instead of a single file's content — the fake repo's flat `store` has no real notion of folders, so a folder's existence/children are derived from whatever file paths happen to start with `${scopePath}/`: the first remaining path segment is an immediate child, a folder itself if more segments follow it, a file otherwise. 404s (matching a real not-found path) if nothing in the store starts with that prefix, mirroring how a single-file `path` lookup 404s below.
      if (scopePath !== null) {
        const recursionLevel = url.searchParams.get('recursionLevel') ?? 'OneLevel'
        const includeContentMetadata = url.searchParams.get('includeContentMetadata') === 'true'
        const normalizedScope = scopePath === '/' ? '' : scopePath.replace(/\/+$/, '')
        const prefix = `${normalizedScope}/`
        if (recursionLevel === 'Full') {
          const hasAny = [...store.keys()].some((k) => k === normalizedScope || k.startsWith(prefix))
          if (!hasAny) {
            return json(404, { message: `TF401174: Item ${scopePath} not found (fake server).` })
          }
          const value = [{ path: normalizedScope || '/', isFolder: true }]
          const folders = new Set()
          for (const [path, content] of store.entries()) {
            if (!path.startsWith(prefix)) continue
            const entry = { path, isFolder: false }
            if (includeContentMetadata) {
              const hash = createHash('sha1').update(content, 'utf8').digest('hex')
              entry.gitObjectId = hash
              entry.objectId = hash
            }
            value.push(entry)
            const rest = path.slice(prefix.length)
            const parts = rest.split('/')
            let cur = normalizedScope
            for (let i = 0; i < parts.length - 1; i++) {
              cur = `${cur}/${parts[i]}`
              folders.add(cur)
            }
          }
          for (const f of folders) value.push({ path: f, isFolder: true })
          value.sort((a, b) => a.path.localeCompare(b.path))
          return json(200, { count: value.length, value })
        }
        const children = new Map() // name -> isFolder
        for (const key of store.keys()) {
          if (!key.startsWith(prefix)) continue
          const rest = key.slice(prefix.length)
          if (rest === '') continue
          const [name, ...more] = rest.split('/')
          const isFolder = more.length > 0
          children.set(name, (children.get(name) ?? false) || isFolder)
        }
        if (children.size === 0) {
          return json(404, { message: `TF401174: Item ${scopePath} not found (fake server).` })
        }
        // A real `recursionLevel=OneLevel` response includes the queried
        // folder itself (its own scopePath, isFolder: true) as one of the
        // `value` entries alongside its immediate children — reproduced
        // here (rather than only ever returning children) so tests
        // against this fake actually exercise lib/azureDevOpsClient.js's
        // `listFolder` filtering that self-entry back out (#116), instead
        // of passing vacuously against a fake that never produced the bug
        // in the first place.
        const value = [
          { path: normalizedScope || '/', isFolder: true },
          ...[...children.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, isFolder]) => ({ path: `${normalizedScope}/${name}`, isFolder })),
        ]
        return json(200, { count: value.length, value })
      }

      const path = url.searchParams.get('path')
      if (!store.has(path)) {
        return json(404, { message: `TF401174: Item ${path} not found (fake server).` })
      }
      return json(200, { path, content: store.get(path), objectId: branch.objectId })
    }

    if (req.method === 'GET' && pathname === `${basePath}/refs`) {
      // Real Azure DevOps filters server-side by the `filter` query param
      // (e.g. `heads/<branch>`) — this fake instead always returns every
      // branch that has at least one commit and lets the one real caller,
      // lib/azureDevOpsClient.js's getBranchObjectId, find its own exact
      // `refs/heads/<branch>` match, the same way it would against a real
      // server's (possibly broader) filtered result set.
      const value = [...branches.entries()].map(([name, b]) => ({ name: `refs/heads/${name}`, objectId: b.objectId }))
      return json(200, { count: value.length, value })
    }

    // Create/update/delete a ref — lib/azureDevOpsClient.js's createBranch
    // calls this to create a new branch pointing at another branch's
    // current tip, distinct from POST .../pushes (which also moves a
    // ref, but only as a side effect of committing file changes). Mirrors
    // the real Update Refs API: HTTP 200 even for a rejected individual
    // update — success/failure is reported per-entry in the response body
    // (`success`/`updateStatus`/`customMessage`), not via HTTP status.
    if (req.method === 'POST' && pathname === `${basePath}/refs`) {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const updates = JSON.parse(raw)

      const value = updates.map((update) => {
        const branchName = update.name.replace(/^refs\/heads\//, '')
        const existingBranch = branches.get(branchName)
        const existingObjectId = existingBranch ? existingBranch.objectId : ZERO_OBJECT_ID

        if (update.oldObjectId !== existingObjectId) {
          // Mirrors the real Update Refs API's two distinct rejection
          // reasons: the ref already exists with a different tip than the
          // caller thought (only reachable path today, since
          // lib/azureDevOpsClient.js's createBranch always presents the
          // all-zero oldObjectId when creating), vs. a caller presenting a
          // non-zero oldObjectId for a ref that doesn't exist at all — no
          // current caller does the latter, but the message stays accurate
          // if one ever does.
          const alreadyExists = existingObjectId !== ZERO_OBJECT_ID
          return {
            name: update.name,
            oldObjectId: update.oldObjectId,
            newObjectId: update.newObjectId,
            success: false,
            updateStatus: alreadyExists ? 'refNameConflict' : 'staleOldObjectId',
            customMessage: alreadyExists
              ? `Ref ${update.name} already exists (fake server).`
              : `Ref ${update.name} does not exist yet; cannot update from oldObjectId ${update.oldObjectId} (fake server).`,
          }
        }

        if (update.newObjectId === ZERO_OBJECT_ID) {
          // Deleting a ref — not exercised by any current caller, but a
          // real possibility per the Update Refs API's own contract.
          branches.delete(branchName)
        } else {
          // Creating a new branch. #118 made every branch carry its own
          // real content (`store`), so a freshly created branch clones
          // whichever existing branch currently sits at `newObjectId` (the
          // source branch's tip, as read by createBranch's own
          // getBranchObjectId call just before this request) — exactly
          // like real git, the new branch starts out identical to its
          // source and the two diverge independently from here on.
          const sourceBranch = [...branches.values()].find((b) => b.objectId === update.newObjectId)
          const store = sourceBranch ? new Map(sourceBranch.store) : new Map()
          const commits = sourceBranch ? [...(sourceBranch.commits ?? [])] : []
          branches.set(branchName, { store, objectId: update.newObjectId, commits, baseStore: new Map(store), baseObjectId: update.newObjectId })
        }

        return {
          name: update.name,
          oldObjectId: update.oldObjectId,
          newObjectId: update.newObjectId,
          success: true,
          updateStatus: 'succeeded',
        }
      })
      return json(200, { count: value.length, value })
    }

    if (req.method === 'POST' && pathname === `${basePath}/pushes`) {
      if (failAfterPushes !== undefined && pushesMade >= failAfterPushes) {
        return json(500, { message: 'Simulated Azure DevOps outage (fake server, for fault-injection tests).' })
      }
      let raw = ''
      for await (const chunk of req) raw += chunk
      const push = JSON.parse(raw)
      const [refUpdate] = push.refUpdates
      // e.g. "refs/heads/feature/foo" -> "feature/foo" — the exact inverse
      // of how lib/azureDevOpsClient.js's writeFile/deleteFile build
      // `refUpdates[0].name` from a branch name.
      const branchName = refUpdate.name.replace(/^refs\/heads\//, '')
      const existingBranch = branches.get(branchName)

      // A branch with no commits yet (never seeded, never pushed to)
      // pushes from the zero object id — Azure DevOps's own documented
      // convention for "this ref doesn't exist yet" — exactly like `main`
      // did pre-#118, just per-branch now: pushing a brand-new branch name
      // starts it with an empty store of its own, never main's or any
      // other branch's content (creating a branch that stacks on another
      // branch's real history, #119/#122, is a distinct, later capability
      // from this fake's push-to-an-empty-new-ref support).
      const expectedOldObjectId = existingBranch ? existingBranch.objectId : objectIdFor(0)
      if (refUpdate.oldObjectId !== expectedOldObjectId) {
        return json(409, { message: `TF401028: The push (oldObjectId ${refUpdate.oldObjectId}) is out of date (fake server).` })
      }

      const store = existingBranch ? existingBranch.store : new Map()
      for (const commit of push.commits) {
        for (const change of commit.changes) {
          if (change.changeType === 'delete') {
            store.delete(change.item.path)
          } else {
            store.set(change.item.path, change.newContent.content)
          }
        }
      }
      globalCommitCount += 1
      pushesMade += 1
      const newObjectId = objectIdFor(globalCommitCount)
      const now = new Date().toISOString()
      const commits = existingBranch ? [...(existingBranch.commits ?? [])] : []
      commits.push(
        ...push.commits.map((commit) => ({
          commitId: newObjectId,
          comment: commit.comment,
          author: { name: 'Fake Pusher', date: now },
          committer: { name: 'Fake Pusher', date: now },
        })),
      )
      const baseStore = existingBranch?.baseStore ?? new Map()
      const baseObjectId = existingBranch?.baseObjectId ?? (existingBranch ? existingBranch.objectId : objectIdFor(0))
      branches.set(branchName, { store, objectId: newObjectId, commits, baseStore, baseObjectId })
      // A real push response's `commits[]` entries carry full commit metadata (author/committer name+date, not just the commitId) — this is what lib/render.js's Azure-DevOps-backed render path (#98) reads its footer's commit hash/date from, rather than a separate call, so the fake mirrors that shape rather than the bare `{ commitId }` a caller uninterested in it might expect.
      return json(201, {
        pushId: globalCommitCount,
        date: now,
        refUpdates: [{ name: refUpdate.name, newObjectId }],
        commits: push.commits.map((commit) => ({
          commitId: newObjectId,
          comment: commit.comment,
          author: { name: 'Fake Pusher', date: now },
          committer: { name: 'Fake Pusher', date: now },
        })),
      })
    }

    if (req.method === 'POST' && pathname.startsWith(`${witBasePath}/workitems/$`)) {
      const type = pathname.slice(`${witBasePath}/workitems/$`.length)
      let raw = ''
      for await (const chunk of req) raw += chunk
      const patch = JSON.parse(raw)
      if (simulateMissingReviewStatusField && patch.some((op) => op.path === '/fields/Custom.GantryReviewStatus')) {
        return json(400, { message: 'TF51535: Cannot find field Custom.GantryReviewStatus (fake server, simulateMissingReviewStatusField).', typeKey: 'FieldNotFoundException' })
      }

      const now = new Date().toISOString()
      const id = nextWorkItemId++
      const workItem = {
        id,
        rev: 1,
        fields: {
          'System.WorkItemType': type,
          'System.TeamProject': project,
          'System.State': 'New',
          'System.CreatedDate': now,
          'System.ChangedDate': now,
        },
        relations: [],
      }
      applyWorkItemPatch(workItem, patch)
      workItems.set(id, workItem)
      // Azure DevOps itself returns 200 (not 201) for work item creation.
      return json(200, workItemResponseBody(workItem))
    }

    if (req.method === 'PATCH' && pathname.startsWith(`${witBasePath}/workitems/`)) {
      const idSegment = pathname.slice(`${witBasePath}/workitems/`.length)
      if (/^\d+$/.test(idSegment)) {
        const id = Number(idSegment)
        const workItem = workItems.get(id)
        if (!workItem) {
          return json(404, { message: `TF401232: Work item ${id} does not exist (fake server).` })
        }
        let raw = ''
        for await (const chunk of req) raw += chunk
        const patch = JSON.parse(raw)
        applyWorkItemPatch(workItem, patch)
        workItem.rev += 1
        workItem.fields['System.ChangedDate'] = new Date().toISOString()
        return json(200, workItemResponseBody(workItem))
      }
    }

    if (req.method === 'GET' && pathname.startsWith(`${witBasePath}/workitemtypes/`) && pathname.endsWith('/states')) {
      const type = pathname.slice(`${witBasePath}/workitemtypes/`.length, -'/states'.length)
      const states = workItemTypeStates[type] ?? DEFAULT_WORK_ITEM_TYPE_STATES
      const value = states.map((state) =>
        typeof state === 'string' ? { name: state, category: 'InProgress', color: '007acc' } : state
      )
      return json(200, { count: value.length, value })
    }

    if (req.method === 'POST' && pathname === `${basePath}/pullrequests`) {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw)

      const id = nextPullRequestId++
      const now = new Date().toISOString()
      // #118 made the store branch-aware — the target branch's *current*
      // objectId (not a single flat `currentObjectId`, which no longer
      // exists) is whatever that branch's own head happens to be right now.
      const targetBranchName = body.targetRefName.replace(/^refs\/heads\//, '')
      const targetObjectId = branches.get(targetBranchName)?.objectId ?? objectIdFor(0)
      const pr = {
        pullRequestId: id,
        status: 'active',
        title: body.title,
        description: body.description,
        sourceRefName: body.sourceRefName,
        targetRefName: body.targetRefName,
        reviewers: (body.reviewers ?? []).map((r) => ({ id: r.id, displayName: r.displayName ?? r.id, vote: 0 })),
        creationDate: now,
        mergeStatus: 'succeeded',
        // Not a real merge simulation (this fake's Git store has no
        // merge-commit-graph modeling — see #122) — just a stable,
        // distinguishable-from-real-pushes fake commit id so a caller
        // completing this pull request (which must echo it back, per
        // Azure DevOps's own optimistic-concurrency check) has something
        // consistent to round-trip.
        lastMergeSourceCommit: { commitId: objectIdFor(1000000 + id) },
        lastMergeTargetCommit: { commitId: targetObjectId },
      }
      pullRequests.set(id, pr)
      return json(201, pullRequestResponseBody(pr))
    }

    if (pathname.startsWith(`${basePath}/pullrequests/`)) {
      const rest = pathname.slice(`${basePath}/pullrequests/`.length)
      const [idSegment, subResource, reviewerId] = rest.split('/')
      const id = Number(idSegment)
      const pr = /^\d+$/.test(idSegment) ? pullRequests.get(id) : undefined

      if (!pr) {
        return json(404, { message: `TF401180: Pull request ${idSegment} does not exist (fake server).` })
      }

      if (subResource === undefined && req.method === 'GET') {
        return json(200, pullRequestResponseBody(pr))
      }

      if (subResource === 'commits' && req.method === 'GET') {
        const sourceBranchName = pr.sourceRefName.replace(/^refs\/heads\//, '')
        return json(200, { count: branches.get(sourceBranchName)?.commits?.length ?? 0, value: branches.get(sourceBranchName)?.commits ?? [] })
      }

      if (subResource === undefined && req.method === 'PATCH') {
        let raw = ''
        for await (const chunk of req) raw += chunk
        const patch = JSON.parse(raw)
        // Mirrors the same optimistic-concurrency check the Git push route
        // above already enforces via oldObjectId: completing a pull
        // request must echo back its *current* lastMergeSourceCommit, so a
        // caller that fetched a stale one (or forgot to fetch it at all)
        // is rejected here rather than silently "succeeding" against
        // whichever value it happened to send — the same failure mode a
        // real Azure DevOps org would reject with a 409.
        if (patch.status === 'completed') {
          const suppliedCommitId = patch.lastMergeSourceCommit?.commitId
          if (suppliedCommitId !== pr.lastMergeSourceCommit?.commitId) {
            return json(409, {
              message: `TF401027: The pull request has been updated since last read (fake server, lastMergeSourceCommit mismatch).`,
            })
          }
          // WI256: actually merge source into target for main→stage sync PRs
          const sourceBranchName = pr.sourceRefName.replace(/^refs\/heads\//, '')
          const targetBranchName = pr.targetRefName.replace(/^refs\/heads\//, '')
          const sourceBranch = branches.get(sourceBranchName)
          const targetBranch = branches.get(targetBranchName)
          if (sourceBranch && targetBranch && sourceBranch.objectId !== targetBranch.objectId) {
            const sourceCommitsSet = new Set((sourceBranch.commits ?? []).map((c) => c.commitId))
            sourceCommitsSet.add(sourceBranch.objectId)
            if (sourceCommitsSet.has(targetBranch.objectId)) {
              // Fast-forward
              const newStore = new Map(sourceBranch.store)
              const newCommits = [...(sourceBranch.commits ?? [])]
              branches.set(targetBranchName, { store: newStore, objectId: sourceBranch.objectId, commits: newCommits, baseStore: targetBranch.baseStore ?? new Map(), baseObjectId: targetBranch.baseObjectId ?? targetBranch.objectId })
              pr.mergeStatus = 'succeeded'
              pr.lastMergeTargetCommit = { commitId: sourceBranch.objectId }
            } else {
              // Divergent: check for conflicts scoped to gantry-workspace/<slug>/
              let scopePrefix = '/'
              const wsMatch = targetBranchName.match(/^gantry-workspace\/([^/]+)\//)
              if (wsMatch) scopePrefix = `/gantry-workspace/${wsMatch[1]}/`
              else if (sourceBranchName.match(/^gantry-workspace\/([^/]+)\//)) scopePrefix = `/gantry-workspace/${sourceBranchName.match(/^gantry-workspace\/([^/]+)\//)[1]}/`
              const baseStore = targetBranch.baseStore ?? new Map()
              const conflicts = []
              const allPaths = new Set()
              for (const k of sourceBranch.store.keys()) if (k.startsWith(scopePrefix)) allPaths.add(k)
              for (const k of targetBranch.store.keys()) if (k.startsWith(scopePrefix)) allPaths.add(k)
              for (const k of baseStore.keys()) if (k.startsWith(scopePrefix)) allPaths.add(k)
              for (const path of allPaths) {
                const base = baseStore.get(path)
                const src = sourceBranch.store.get(path)
                const tgt = targetBranch.store.get(path)
                if (src !== base && tgt !== base && src !== tgt) conflicts.push(path)
              }
              if (conflicts.length > 0) {
                conflicts.sort()
                pr.mergeStatus = 'conflicts'
                return json(409, { message: `TF401034: Merge conflicts in ${conflicts.join(', ')} (fake server)`, mergeStatus: 'conflicts', conflicts })
              }
              globalCommitCount += 1
              const newObjectId = objectIdFor(globalCommitCount)
              const now = new Date().toISOString()
              const newStore = new Map(targetBranch.store)
              for (const path of allPaths) {
                const base = baseStore.get(path)
                const src = sourceBranch.store.get(path)
                if (src !== base) {
                  if (src === undefined) newStore.delete(path)
                  else newStore.set(path, src)
                }
              }
              const targetCommitsSet = new Set((targetBranch.commits ?? []).map((c) => c.commitId))
              const sourceUniqueCommits = (sourceBranch.commits ?? []).filter((c) => !targetCommitsSet.has(c.commitId))
              const newCommits = [...(targetBranch.commits ?? []), ...sourceUniqueCommits, { commitId: newObjectId, comment: `Merge ${sourceBranchName} into ${targetBranchName}`, author: { name: 'Fake Merger', date: now }, committer: { name: 'Fake Merger', date: now } }]
              branches.set(targetBranchName, { store: newStore, objectId: newObjectId, commits: newCommits, baseStore: targetBranch.baseStore ?? new Map(), baseObjectId: targetBranch.baseObjectId ?? targetBranch.objectId })
              pr.mergeStatus = 'succeeded'
              pr.lastMergeTargetCommit = { commitId: newObjectId }
            }
          } else if (sourceBranch && targetBranch) {
            pr.mergeStatus = 'succeeded'
          }
        }
        if (patch.status !== undefined) pr.status = patch.status
        if (patch.completionOptions !== undefined) pr.completionOptions = patch.completionOptions
        if (patch.title !== undefined) pr.title = patch.title
        if (patch.description !== undefined) pr.description = patch.description
        if (patch.status === 'completed' && pr.mergeStatus !== 'conflicts') pr.closedDate = new Date().toISOString()
        if (pr.mergeStatus === 'conflicts') {
          return json(409, { message: 'TF401034: Merge conflicts', mergeStatus: 'conflicts' })
        }
        return json(200, pullRequestResponseBody(pr))
      }

      // Not exercised by lib/azureDevOpsPullRequestsClient.js itself (that
      // client deliberately exposes no "cast a vote" function — voting is
      // the Owner's own action in Azure DevOps's real UI, per ADR-0014) —
      // faked here purely so a test can simulate that vote directly (a
      // plain `fetch` PUT against this server), then assert the client's
      // own `getPullRequest` reads it back correctly.
      if (subResource === 'reviewers' && reviewerId !== undefined && req.method === 'PUT') {
        if (denyReviewerVoteReset && req.headers['content-type']?.includes('application/json')) {
          let raw = ''
          for await (const chunk of req) raw += chunk
          const body = JSON.parse(raw)
          if (body.vote === 0) return json(403, { message: 'Vote reset is not permitted (fake server).' })
          // Continue below with the already-consumed request body.
          let reviewer = pr.reviewers.find((r) => r.id === reviewerId)
          if (!reviewer) {
            reviewer = { id: reviewerId, displayName: body.displayName ?? reviewerId, vote: 0 }
            pr.reviewers.push(reviewer)
          }
          if (body.vote !== undefined) {
            reviewer.vote = body.vote
            reviewer.voteUpdatedDate = new Date().toISOString()
          }
          return json(200, reviewer)
        }
        let raw = ''
        for await (const chunk of req) raw += chunk
        const body = JSON.parse(raw)
        let reviewer = pr.reviewers.find((r) => r.id === reviewerId)
        if (!reviewer) {
          reviewer = { id: reviewerId, displayName: body.displayName ?? reviewerId, vote: 0 }
          pr.reviewers.push(reviewer)
        }
        if (body.vote !== undefined) {
          reviewer.vote = body.vote
          reviewer.voteUpdatedDate = new Date().toISOString()
        }
        return json(200, reviewer)
      }

      // DELETE reviewers/{id} endpoint — backs lib/azureDevOpsPullRequestsClient.js's
      // `removeReviewer` (previously untested against this fake server at
      // all). Mirrors the real Azure DevOps API: removing a reviewer who
      // isn't currently on the pull request is a no-op, not an error.
      if (subResource === 'reviewers' && reviewerId !== undefined && req.method === 'DELETE') {
        pr.reviewers = pr.reviewers.filter((r) => r.id !== reviewerId)
        return json(200, {})
      }

      if (subResource === 'threads' && req.method === 'POST') {
        let raw = ''
        for await (const chunk of req) raw += chunk
        const body = JSON.parse(raw)
        pr.comments ??= []
        pr.comments.push(...(body.comments ?? []))
        return json(201, { id: pr.comments.length, comments: body.comments ?? [], status: body.status ?? 'active' })
      }
    }

    // Project-wide work item type list (#121) — distinct from the
    // per-type `/workitemtypes/{type}/states` route above, so this must be
    // matched only when nothing follows `workitemtypes` (no trailing
    // `/{type}/states` segment).
    if (req.method === 'GET' && pathname === `${witBasePath}/workitemtypes`) {
      const types = workItemTypes ?? DEFAULT_WORK_ITEM_TYPES
      const value = types.map((type) =>
        typeof type === 'string'
          ? { name: type, referenceName: `Custom.WorkItemTypes.${type}`, description: '', color: '999999', icon: { id: 'icon_clipboard', url: '' }, isDisabled: false }
          : type
      )
      return json(200, { count: value.length, value })
    }

    // Single work item read by id (#121 — "fetch a specific work item's
    // current field values by id"), distinct from the create (POST
    // .../workitems/$Type) and update (PATCH .../workitems/{id}) routes
    // above. `fields` (if supplied) narrows the response the same way the
    // real API does, rather than this fake always returning every field.
    //
    // Unlike this fake's create/update responses (`workItemResponseBody`,
    // used unconditionally above — matching the real Create/Update
    // endpoints, whose own documented examples include `relations` with
    // no `$expand` needed), the real single-item Get endpoint's default
    // `$expand` is `None`, and its own documented sample response omits
    // `relations` entirely when no `$expand` is given. This route mirrors
    // that distinction — `relations` is only included here when
    // `$expand=relations` or `$expand=all` (case-insensitive) is actually
    // requested — rather than reusing `workItemResponseBody` unmodified,
    // which would silently paper over a real difference in the two
    // endpoints' default shapes.
    if (req.method === 'GET' && pathname.startsWith(`${witBasePath}/workitems/`)) {
      const idSegment = pathname.slice(`${witBasePath}/workitems/`.length)
      if (/^\d+$/.test(idSegment)) {
        const id = Number(idSegment)
        const workItem = workItems.get(id)
        if (!workItem) {
          return json(404, { message: `TF401232: Work item ${id} does not exist (fake server).` })
        }
        const expand = (url.searchParams.get('$expand') ?? '').toLowerCase()
        const includeRelations = expand === 'relations' || expand === 'all'
        const body = includeRelations
          ? workItemResponseBody(workItem)
          : { id: workItem.id, rev: workItem.rev, fields: workItem.fields, url: `${orgWorkItemsPath}/${workItem.id}` }

        const fieldsParam = url.searchParams.get('fields')
        if (!fieldsParam) return json(200, body)
        if (simulateMissingReviewStatusField && fieldsParam.includes('Custom.GantryReviewStatus')) {
          return json(400, { message: 'TF51535: Cannot find field Custom.GantryReviewStatus (fake server, simulateMissingReviewStatusField).', typeKey: 'FieldNotFoundException' })
        }

        const requestedFields = fieldsParam.split(',').map((f) => f.trim())
        const narrowedFields = Object.fromEntries(
          requestedFields.filter((f) => f in workItem.fields).map((f) => [f, workItem.fields[f]])
        )
        return json(200, { ...body, fields: narrowedFields })
      }
    }

    // Identity search endpoint (#145 Part 2) — a minimal fake of the real
    // Identities REST API (organization-scoped, no project segment — see
    // lib/azureDevOpsIdentityClient.js's own comment on why) that returns a
    // single hardcoded identity (`fakeUser`) when the query matches its
    // display name or account name, an empty result otherwise. Just enough
    // to prove lib/azureDevOpsIdentityClient.js resolves identities
    // correctly in tests without needing to spin up a real Azure DevOps
    // directory.
    //
    // Shape mirrors a real Identity object (confirmed against a live org):
    // the envelope is `{count, value}`, not a bare array, and there is no
    // top-level `uniqueName`/`displayName`/`mailAddress` — those live under
    // `customDisplayName`/`providerDisplayName` and
    // `properties.Account.$value`/`properties.Mail.$value`.
    //
    // Reads `filterValue` — the real API's actual search-text parameter
    // (`searchFilter` names which field to match, e.g. 'General'; it is
    // never the query text itself).
    // Connection data endpoint (lib/azureDevOpsWorkItemsClient.js's
    // getCurrentUser, #197) — a minimal fake of the real
    // `_apis/connectionData` response, returning `connectionDataUser` as
    // `authenticatedUser` verbatim when the caller supplied one, otherwise
    // `null` (a PAT the endpoint recognizes but with no resolvable identity —
    // exercises the "no requester attribution available" fallback).
    if (req.method === 'GET' && pathname === `/${organization}/_apis/connectionData`) {
      return json(200, { authenticatedUser: connectionDataUser ?? null })
    }

    // Permissions "Has Permissions" endpoint (#126) — lib/azureDevOpsClient.js's own hasWriteAccess()
    // calls this against the Git Repositories security namespace, asking about the GenericContribute
    // bit. Matched loosely by prefix rather than the exact namespace-id/permission-bit path segments
    // the real client sends, so this fake stays agnostic of which bit means what — `canWrite` (the
    // fixture param, default `true`) is the fake's whole answer, mirroring the real endpoint's own
    // bare-boolean response body.
    if (req.method === 'GET' && pathname.startsWith(`/${organization}/_apis/permissions/`)) {
      return json(200, canWrite)
    }

    if (req.method === 'GET' && pathname === `/${organization}/_apis/identities`) {
      if (rejectIdentityRequests) return json(403, { message: 'TF400813: Identity scope rejected (fake server).' })
      const query = (url.searchParams.get('filterValue') ?? url.searchParams.get('query') ?? '').toLowerCase()
      if (!query) return json(200, { count: 0, value: [] })
      const fakeIdentity = {
        id: 'fake-identity-id-001',
        customDisplayName: 'Test User',
        providerDisplayName: 'Test User',
        properties: {
          Account: { $type: 'System.String', $value: 'testuser@example.com' },
          Mail: { $type: 'System.String', $value: 'testuser@example.com' },
        },
      }
      const matches =
        fakeIdentity.customDisplayName.toLowerCase().includes(query) ||
        fakeIdentity.properties.Account.$value.toLowerCase().includes(query)
      const value = matches ? [fakeIdentity] : []
      return json(200, { count: value.length, value })
    }

    // POST reviewers endpoint (#145 Part 2) — adds reviewers to an
    // existing pull request (mirrors PUT .../reviewers/{id} but takes an
    // array and POSTs, the shape lib/azureDevOpsPullRequestsClient.js's
    // `addReviewers` produces).
    if (pathname.startsWith(`${basePath}/pullrequests/`) && pathname.endsWith('/reviewers') && req.method === 'POST') {
      const rest = pathname.slice(`${basePath}/pullrequests/`.length)
      const idSegment = rest.replace(/\/reviewers$/, '')
      const id = Number(idSegment)
      const pr = pullRequests.get(id)
      if (!pr) {
        return json(404, { message: `TF401180: Pull request ${idSegment} does not exist (fake server).` })
      }
      let raw = ''
      for await (const chunk of req) raw += chunk
      // The real endpoint's bulk-add body is a bare array (`addReviewers`
      // sends `[{id, vote, isRequired}]` directly, not `{reviewers: [...]}`)
      // — this used to read `body.reviewers`, which is always undefined on
      // an array, so this endpoint silently added nothing no matter what was
      // sent. Nothing caught it because no prior test checked the resulting
      // PR's reviewers list after a real addReviewers call.
      const body = JSON.parse(raw)
      const added = []
      for (const r of (Array.isArray(body) ? body : [])) {
        const existing = pr.reviewers.find((rev) => rev.id === r.id)
        if (existing) {
          if (r.isRequired !== undefined) existing.isRequired = r.isRequired
          added.push(existing)
        } else {
          const reviewer = { id: r.id, displayName: r.displayName ?? r.id, vote: 0, isRequired: r.isRequired ?? false }
          pr.reviewers.push(reviewer)
          added.push(reviewer)
        }
      }
      return json(200, { count: added.length, value: added })
    }

    return json(404, { message: `No fake route for ${req.method} ${pathname}` })
  })
}

/**
 * Starts a `createFakeAzureDevOpsServer` on an ephemeral port for the duration of `fn(baseUrl)`, then closes it — mirrors `tests/server.test.js`'s `withRunningServer` helper's shape (per #82's testing decisions). Shared by `tests/azureDevOpsClient.test.js` and `tests/instance.test.js` so this lifecycle isn't duplicated across both.
 */
export function withFakeAzureDevOpsServer(
  { organization, project, repository, validPat, files, branchFiles, failAfterPushes, workItemTypeStates, workItemTypes, denyReviewerVoteReset, rejectIdentityRequests, repoExists, connectionDataUser, simulateMissingReviewStatusField, canWrite },
  fn
) {
  return new Promise((resolve, reject) => {
    const server = createFakeAzureDevOpsServer({
      organization,
      project,
      repository,
      validPat,
      files,
      branchFiles,
      failAfterPushes,
      workItemTypeStates,
      workItemTypes,
      denyReviewerVoteReset,
      rejectIdentityRequests,
      repoExists,
      connectionDataUser,
      simulateMissingReviewStatusField,
      canWrite,
    })
    server.listen(0, async () => {
      const { port } = server.address()
      try {
        await fn(`http://localhost:${port}`)
        resolve()
      } catch (err) {
        reject(err)
      } finally {
        server.close()
      }
    })
  })
}
