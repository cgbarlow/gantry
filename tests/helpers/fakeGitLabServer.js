import { createServer } from 'node:http'

/**
 * A minimal in-process fake of the GitLab REST API (v4), standing in for a real `gitlab.com` (or
 * self-hosted CE/EE) namespace/repository in tests (#26) — a real HTTP server on an ephemeral port
 * that `lib/gitlabClient.js` talks to over real `fetch` calls, never a mock of `fetch` itself. Mirrors
 * `tests/helpers/fakeGitHubServer.js`'s own shape and conventions so the two fakes read the same way
 * to a caller working across both providers.
 *
 * Covers the subset `lib/gitlabClient.js` implements so far (#26's content-store scope): the project
 * metadata endpoint (`GET /projects/:id`), the Repository Files API (get a file), the Repository Tree
 * API (list a folder), the Repository Branches API (get/create a branch), and the Commits API (write
 * one or several files as a single commit) — plus, per #30, the Issues API (`lib/gitlabWorkItemsClient.js`'s
 * work-items capability): create/read/update a project issue by its `iid` (GitLab's own project-scoped
 * issue number, the "iid" — `id` stays a separate, global-across-all-projects identifier this fake also
 * assigns but which `lib/gitlabWorkItemsClient.js` never addresses an issue by). #34 extends the Issues
 * API with `assignee_ids`/`labels` support plus the Labels API (`GET`/`POST /projects/:id/labels`),
 * backing Request Review. Later tickets (#29 stage branches, #33 merge requests, ...) extend this the
 * same incremental way `fakeGitHubServer.js` grew — new endpoints added here as the GitLab client
 * itself grows them, never a parallel second fake.
 *
 * A project's `:id` is GitLab's own `namespace%2Frepository` URL-encoded path — both the project id
 * and a file's `file_path` are single path *segments* that may themselves contain `%2F`-encoded
 * slashes (GitLab's own convention). Node's `URL#pathname` deliberately leaves `%2F` un-decoded (it
 * would otherwise be indistinguishable from a real `/` path separator), so this fake matches routes
 * against the *raw* (still-`%2F`-encoded) pathname and only `decodeURIComponent`s an individual
 * captured segment once its boundaries are known — never the pathname as a whole.
 *
 * `files` seeds `main`'s initial content, keyed by repo-relative path (leading "/" optional).
 * `branchFiles`, if given, seeds one or more other branches the same way. `validPat` is the PAT (or,
 * if an array, any one of several) accepted in the `PRIVATE-TOKEN` header GitLab itself expects —
 * anything else, or a missing header, gets a 401, mirroring a rejected PAT's real shape. `repoExists`
 * (default `true`) controls whether `GET /projects/:id` reports the project as existing; `false`
 * returns 404, simulating both a genuinely nonexistent project and a PAT whose scopes can't see an
 * otherwise-real one — GitLab, like GitHub, reports both cases identically.
 *
 * `members` (#28, default `[]`) seeds `GET /projects/:id/members/all` — GitLab's own Members API,
 * already folding inherited group membership server-side (unlike GitHub's own separate
 * collaborators/org-members endpoints), so a test seeds one flat list regardless of whether a given
 * member is direct or inherited. Each entry is `{ id, username, name, access_level }` — `access_level`
 * is GitLab's own 10/20/30/40/50 (Guest/Reporter/Developer/Maintainer/Owner) scale, exercising
 * `lib/gitlabIdentityClient.js`'s own Reporter-or-above assignability gate. The fake's `query` param
 * handling matches real GitLab's own substring, case-insensitive match against `username` or `name`.
 */
export function createFakeGitLabServer({
  namespace,
  repository,
  validPat,
  files = {},
  branchFiles = {},
  repoExists = true,
  members = [],
  mergeRefusal = null,
  // #126: the access level *this supplied PAT*'s account effectively has on the project — GitLab's own
  // `permissions.project_access.access_level` field on the authenticated project-metadata response.
  // Defaults to Developer (30), GitLab's own lowest level that can push to a non-protected branch; pass
  // 20 (Reporter) or lower to simulate a read-only PAT.
  viewerAccessLevel = 30,
} = {}) {
  const branches = new Map() // branch name -> Map<path, Buffer>
  const branchTips = new Map() // branch name -> { commitId, committedDate, authoredDate }
  let commitCounter = 0

  // #30: issues, keyed by their project-scoped `iid` — the id `lib/gitlabWorkItemsClient.js` addresses
  // every issue by (GitLab's own "internal id", equivalent to GitHub's issue `number`). `id` is a
  // separate, globally-unique-across-the-whole-GitLab-instance identifier real GitLab also assigns;
  // this fake mints one too so a response shape-checks the same as the real API's, even though nothing
  // in `lib/gitlabWorkItemsClient.js` currently addresses an issue by it.
  const issues = new Map() // iid -> issue object
  let issueIidCounter = 0
  let issueIdCounter = 5000

  // #33: Merge Requests, keyed by their project-scoped `iid` (GitLab's own "internal id", the number
  // shown in its own UI and what `lib/gitlabPullRequestsClient.js` addresses every MR by — the same
  // iid-not-id distinction the issues fixture above already draws). Each MR carries its own approvals
  // summary (`approved`, `approved_by`) and discussion list, so a test can drive
  // `interpretGitLabMergeRequest`'s three readings (approved / changes-requested-equivalent / pending)
  // directly against a real HTTP response, mirroring `fakeGitHubServer.js`'s own Pull Requests section.
  const mergeRequests = new Map() // iid -> { iid, source_branch, target_branch, title, description, state, approved, approved_by, discussions }
  let mrIidCounter = 0
  let mrIdCounter = 9000
  let discussionIdCounter = 0
  const FAKE_APPROVER = { id: 777, username: 'fake-approver', name: 'Fake Approver' }

  // #34: label definitions, keyed by name — `POST /projects/:id/labels` (name/color/description) and
  // an issue's own `assignee_ids`/`labels` fields, backing `lib/gitlabWorkItemsClient.js`'s
  // `ensureLabelsExist` and Request Review's assigned-and-labelled create-issue call. Real GitLab
  // auto-creates a label from a bare name the first time it's attached to an issue if no such label
  // already exists — mirrored here the same way `fakeGitHubServer.js`'s own `resolveLabelObjects`
  // does, except GitLab's Issues API reports `labels` back as an array of plain name strings, never
  // `{ name, color, description }` objects (this fake's own `getIssue`/create response mirrors that).
  const labelDefs = new Map() // name -> { name, color, description }
  function resolveLabelNames(labelsField) {
    const names = Array.isArray(labelsField)
      ? labelsField
      : typeof labelsField === 'string' && labelsField.trim()
        ? labelsField.split(',').map((name) => name.trim()).filter(Boolean)
        : []
    for (const name of names) {
      if (!labelDefs.has(name)) labelDefs.set(name, { name, color: '#ededed', description: null })
    }
    return names
  }

  // #26: every stored file is a real Buffer — a fixture may pass either a plain string (a text file's
  // UTF-8 content) or a Buffer (a binary file's real bytes) — matching how a write via the Commits API
  // below also ends up storing real bytes, and mirroring `fakeGitHubServer.js`'s own identical
  // convention.
  function seedBranch(name, seedFiles) {
    const entries = Object.entries(seedFiles)
    const store = new Map(
      entries.map(([path, content]) => [path.startsWith('/') ? path : `/${path}`, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')])
    )
    branches.set(name, store)
    commitCounter += 1
    const date = new Date().toISOString()
    branchTips.set(name, { commitId: `fake-commit-${commitCounter}`, committedDate: date, authoredDate: date })
  }
  seedBranch('main', files)
  for (const [branchName, seedFiles] of Object.entries(branchFiles)) {
    seedBranch(branchName, seedFiles)
  }

  const projectIdEncoded = encodeURIComponent(`${namespace}/${repository}`)
  const projectBasePath = `/api/v4/projects/${projectIdEncoded}`

  async function readJsonBody(req) {
    let raw = ''
    for await (const chunk of req) raw += chunk
    return raw ? JSON.parse(raw) : {}
  }

  return createServer(async (req, res) => {
    // Deliberately NOT decoded up front — the project id segment and any file_path segment carry
    // GitLab's own `%2F`-encoded internal slashes, which must survive route matching intact; see this
    // module's own doc comment above.
    const url = new URL(req.url, 'http://fake-gitlab.invalid')
    const rawPathname = url.pathname
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    const validPats = Array.isArray(validPat) ? validPat : [validPat]
    if (!validPats.includes(req.headers['private-token'])) {
      return json(401, { message: '401 Unauthorized (fake server: invalid or missing PRIVATE-TOKEN)' })
    }

    if (!rawPathname.startsWith(projectBasePath)) {
      return json(404, { message: `No fake route for ${req.method} ${rawPathname}` })
    }
    const rest = rawPathname.slice(projectBasePath.length)

    // GET /projects/:id — lib/gitlabClient.js's getRepo()/repoExists() call this.
    if (req.method === 'GET' && rest === '') {
      if (!repoExists) {
        return json(404, { message: '404 Project Not Found (fake: project does not exist, or PAT scope insufficient to see it)' })
      }
      return json(200, {
        id: 1,
        name: repository,
        path: repository,
        path_with_namespace: `${namespace}/${repository}`,
        namespace: { full_path: namespace },
        default_branch: 'main',
        permissions: { project_access: { access_level: viewerAccessLevel }, group_access: null },
      })
    }

    // GET /projects/:id/repository/files/:file_path?ref=<branch> — a single file's metadata + base64
    // content, GitLab's own Repository Files API. `:file_path` is itself a single, `%2F`-encoded path
    // segment (real internal slashes are already literal `/` in the raw pathname at this point, since
    // this route only ever matches the *remainder* after the fixed `/repository/files/` prefix).
    if (req.method === 'GET' && rest.startsWith('/repository/files/')) {
      const encodedFilePath = rest.slice('/repository/files/'.length)
      const filePath = decodeURIComponent(encodedFilePath)
      const branchName = url.searchParams.get('ref') ?? 'main'
      const store = branches.get(branchName)
      const key = filePath.startsWith('/') ? filePath : `/${filePath}`
      const content = store?.get(key)
      if (content === undefined) {
        return json(404, { message: '404 File Not Found (fake server)' })
      }
      return json(200, {
        file_name: filePath.split('/').pop(),
        file_path: filePath,
        encoding: 'base64',
        content: content.toString('base64'),
        ref: branchName,
      })
    }

    // GET /projects/:id/repository/tree?path=&ref=&per_page= — immediate children of `path` (or the
    // repo root if omitted), derived from the stored flat paths the same "no real folder concept,
    // infer from flat paths" approach `fakeGitHubServer.js` uses for GitHub's own Contents API.
    if (req.method === 'GET' && rest === '/repository/tree') {
      const branchName = url.searchParams.get('ref') ?? 'main'
      const store = branches.get(branchName) ?? new Map()
      const scopePath = (url.searchParams.get('path') ?? '').replace(/^\/+|\/+$/g, '')
      const prefix = scopePath === '' ? '/' : `/${scopePath}/`
      const children = new Map() // name -> isFolder
      for (const key of store.keys()) {
        if (!key.startsWith(prefix)) continue
        const restOfKey = key.slice(prefix.length)
        if (restOfKey === '') continue
        const [name, ...more] = restOfKey.split('/')
        const isFolder = more.length > 0
        children.set(name, (children.get(name) ?? false) || isFolder)
      }
      const value = [...children.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, isFolder]) => ({
          id: `fake-tree-${name}`,
          name,
          type: isFolder ? 'tree' : 'blob',
          path: scopePath === '' ? name : `${scopePath}/${name}`,
          mode: isFolder ? '040000' : '100644',
        }))
      return json(200, value)
    }

    // GET /projects/:id/members/all?query=&per_page= — GitLab's own Members API (#28), already
    // folding inherited group membership into one flat list (see this factory's own doc comment
    // above). `query`, when present, filters `members` by substring against `username` or `name`,
    // case-insensitive — mirroring real GitLab's own documented behaviour for this parameter.
    if (req.method === 'GET' && rest === '/members/all') {
      const q = (url.searchParams.get('query') ?? '').toLowerCase()
      const matched = q
        ? members.filter((m) => m.username.toLowerCase().includes(q) || (m.name ?? '').toLowerCase().includes(q))
        : members
      return json(
        200,
        matched.map((m) => ({ id: m.id, username: m.username, name: m.name ?? m.username, access_level: m.access_level }))
      )
    }

    // GET /projects/:id/repository/branches/:branch — GitLab's own Repository Branches API,
    // lib/gitlabClient.js's getBranchObjectId's single request (unlike GitHub's own two-step
    // ref-then-commit lookup, the branch's tip commit is already embedded here).
    const branchGetMatch = rest.match(/^\/repository\/branches\/(.+)$/)
    if (req.method === 'GET' && branchGetMatch) {
      const branchName = decodeURIComponent(branchGetMatch[1])
      const tip = branchTips.get(branchName)
      if (!tip) return json(404, { message: `404 Branch Not Found (fake: "${branchName}")` })
      return json(200, { name: branchName, commit: { id: tip.commitId, committed_date: tip.committedDate } })
    }

    // DELETE /projects/:id/repository/branches/:branch — real GitLab's own branch-deletion endpoint.
    // Not called by any gantry client (merging never deletes the source branch itself, #33's own
    // `should_remove_source_branch: false`), but test-facing: mirrors the "a stage branch was cleaned
    // up after merge, by a repo setting or a human, before a later re-open" scenario
    // tests/gitlabStageApproval.test.js simulates, the same way fakeGitHubServer.js's own DELETE ref
    // route exists for GitHub.
    if (req.method === 'DELETE' && branchGetMatch) {
      const branchName = decodeURIComponent(branchGetMatch[1])
      if (!branchTips.has(branchName)) return json(404, { message: `404 Branch Not Found (fake: "${branchName}")` })
      branchTips.delete(branchName)
      branches.delete(branchName)
      res.writeHead(204)
      res.end()
      return
    }

    // POST /projects/:id/repository/branches?branch=&ref= — creates a new branch pointing at `ref`'s
    // current tip. Mirrors real GitLab's own two documented failure modes: `ref` not existing (404)
    // and `branch` already existing (400 "Branch already exists").
    if (req.method === 'POST' && rest === '/repository/branches') {
      const branchName = url.searchParams.get('branch')
      const fromName = url.searchParams.get('ref')
      if (!branchName || !fromName) return json(400, { message: 'branch and ref are required' })
      if (branchTips.has(branchName)) {
        return json(400, { message: 'Branch already exists' })
      }
      const fromTip = branchTips.get(fromName)
      if (!fromTip) return json(404, { message: `404 Branch Not Found (fake: "${fromName}")` })
      branches.set(branchName, new Map(branches.get(fromName)))
      branchTips.set(branchName, fromTip)
      return json(201, { name: branchName, commit: { id: fromTip.commitId, committed_date: fromTip.committedDate } })
    }

    // POST /projects/:id/repository/commits — GitLab's Commits API: several file `actions`
    // (create/update/delete) landed as a single commit. A `branch` that doesn't exist yet is accepted
    // as this project's very first commit only when the project is otherwise completely empty (no
    // branch has ever existed) — GitLab's own real behaviour for an empty project; any other
    // nonexistent `branch` here is a caller error this fake refuses with 400, the same shape a real,
    // non-empty GitLab project would refuse it with for lacking `start_branch`.
    if (req.method === 'POST' && rest === '/repository/commits') {
      const body = await readJsonBody(req)
      const { branch, actions = [] } = body
      if (!branch) return json(400, { message: 'branch is required' })
      if (!actions.length) return json(400, { message: "You can't commit an empty changelist" })

      let store = branches.get(branch)
      if (!store) {
        if (branches.size > 0) {
          return json(400, { message: `404 Branch Not Found (fake: "${branch}" does not exist and project is not empty — pass start_branch)` })
        }
        store = new Map()
        branches.set(branch, store)
      }

      for (const action of actions) {
        const key = action.file_path.startsWith('/') ? action.file_path : `/${action.file_path}`
        if (action.action === 'delete') {
          store.delete(key)
          continue
        }
        const content = Buffer.from(action.content, action.encoding === 'base64' ? 'base64' : 'utf8')
        store.set(key, content)
      }

      commitCounter += 1
      const date = new Date().toISOString()
      const commit = { commitId: `fake-commit-${commitCounter}`, committedDate: date, authoredDate: date }
      branchTips.set(branch, commit)
      return json(201, { id: commit.commitId, short_id: commit.commitId, committed_date: commit.committedDate, authored_date: commit.authoredDate })
    }

    // GET /projects/:id/labels — lists every label defined on the project (test-facing convenience,
    // mirroring fakeGitHubServer.js's own read endpoint).
    if (req.method === 'GET' && rest === '/labels') {
      return json(200, [...labelDefs.values()])
    }

    // POST /projects/:id/labels — creates a label definition. Real GitLab responds 400 with a
    // `{ message: { title: ["has already been taken"] } }`-shaped body for a name already taken —
    // the case lib/gitlabWorkItemsClient.js's `ensureLabelsExist` tolerates rather than fails over.
    if (req.method === 'POST' && rest === '/labels') {
      const body = await readJsonBody(req)
      if (labelDefs.has(body.name)) {
        return json(400, { message: { title: ['has already been taken'] } })
      }
      const label = { name: body.name, color: body.color ?? '#ededed', description: body.description ?? null }
      labelDefs.set(body.name, label)
      return json(201, label)
    }

    // POST /projects/:id/issues — creates a new issue. Mirrors real GitLab's own create-issue response
    // shape (`iid`/`id`/`title`/`description`/`state`/`web_url`/`labels`/`assignee_ids`),
    // lib/gitlabWorkItemsClient.js's createIssue(). `labels` (a comma-separated string, or an array —
    // this fake accepts either) auto-creates any name not already defined via `POST .../labels`, and
    // the issue's own `labels` field always reports plain name strings, matching real GitLab's shape
    // (unlike GitHub's array of label objects).
    if (req.method === 'POST' && rest === '/issues') {
      const body = await readJsonBody(req)
      const iid = ++issueIidCounter
      const id = ++issueIdCounter
      const issue = {
        id,
        iid,
        project_id: 1,
        title: body.title,
        description: body.description ?? null,
        state: 'opened',
        web_url: `https://fake-gitlab.invalid/${namespace}/${repository}/-/issues/${iid}`,
        assignee_ids: body.assignee_ids ?? [],
        labels: resolveLabelNames(body.labels),
      }
      issues.set(iid, issue)
      return json(201, issue)
    }

    // GET /projects/:id/issues/:issue_iid and PUT /projects/:id/issues/:issue_iid — read/partially
    // update an issue by its project-scoped `iid`. PUT supports `title`/`description`/`assignee_ids`
    // plus `labels` (re-resolved the same auto-creating way as create) and GitLab's own `state_event`
    // ('close'/'reopen', translated here into the `state` field a GET reports —
    // lib/gitlabWorkItemsClient.js never sends a bare `state` directly, matching real GitLab's own
    // contract, which only accepts state changes via `state_event`).
    const issueMatch = rest.match(/^\/issues\/(\d+)$/)
    if (issueMatch) {
      const iid = Number(issueMatch[1])
      const issue = issues.get(iid)
      if (!issue) return json(404, { message: `404 Issue Not Found (fake: iid ${iid})` })

      if (req.method === 'GET') return json(200, issue)

      if (req.method === 'PUT') {
        const { state_event, labels, ...rest } = await readJsonBody(req)
        Object.assign(issue, rest)
        if (labels !== undefined) issue.labels = resolveLabelNames(labels)
        if (state_event === 'close') issue.state = 'closed'
        else if (state_event === 'reopen') issue.state = 'opened'
        return json(200, issue)
      }
    }

    // ---- Merge Requests (#33) ----
    //
    // A minimal fake of GitLab's Merge Requests API: enough for `lib/gitlabPullRequestsClient.js` to
    // open a stage's sign-off Merge Request, read it back (status + approvals + discussions), attach a
    // requested reviewer, and merge it. Real approval/discussion-resolution is a reviewer's own action,
    // performed with their own token; this fake has only one accepted PAT, so a test simulates "the
    // reviewer approved"/"a reviewer left an unresolved comment" the same way `fakeGitHubServer.js`'s
    // own review-submission simulation does — dedicated test-facing endpoints below, not gated behind a
    // second PAT.
    //
    // Merge (`PUT .../merge_requests/:iid/merge`, #33's `completePullRequest`) always produces a merge
    // commit, fast-forwarding the target branch's own file map/ref to the source branch's current tip
    // — enough to prove a caller can read the merged content back afterwards, without modelling a
    // genuine two-parent merge commit. `mergeRefusal`, if set (`{ status, message }`), makes every
    // merge attempt fail with that response instead — reproducing a protected-branch or push-rule
    // refusal (ADR-0041: "surfaced verbatim as a blocked sign-off") so that behaviour is genuinely
    // testable.
    if (req.method === 'POST' && rest === '/merge_requests') {
      const body = await readJsonBody(req)
      if (!body.source_branch || !body.target_branch || !body.title) {
        return json(400, { message: 'source_branch, target_branch and title are required' })
      }
      const iid = ++mrIidCounter
      const id = ++mrIdCounter
      const mr = {
        id,
        iid,
        source_branch: body.source_branch,
        target_branch: body.target_branch,
        title: body.title,
        description: body.description ?? null,
        state: 'opened',
        reviewer_ids: body.reviewer_ids ?? [],
        approved: false,
        approved_by: [],
        discussions: [],
      }
      mergeRequests.set(iid, mr)
      return json(201, mr)
    }

    const mrMatch = rest.match(/^\/merge_requests\/(\d+)$/)
    if (req.method === 'GET' && mrMatch) {
      const mr = mergeRequests.get(Number(mrMatch[1]))
      if (!mr) return json(404, { message: `No fake merge request !${mrMatch[1]}` })
      return json(200, mr)
    }
    if (req.method === 'PUT' && mrMatch) {
      const mr = mergeRequests.get(Number(mrMatch[1]))
      if (!mr) return json(404, { message: `No fake merge request !${mrMatch[1]}` })
      const body = await readJsonBody(req)
      Object.assign(mr, body)
      return json(200, mr)
    }

    // GET .../merge_requests/:iid/approvals — lib/gitlabPullRequestsClient.js's getApprovals.
    const approvalsMatch = rest.match(/^\/merge_requests\/(\d+)\/approvals$/)
    if (req.method === 'GET' && approvalsMatch) {
      const mr = mergeRequests.get(Number(approvalsMatch[1]))
      if (!mr) return json(404, { message: `No fake merge request !${approvalsMatch[1]}` })
      return json(200, {
        approved: mr.approved,
        approved_by: mr.approved_by.map((user) => ({ user })),
        approvals_left: mr.approved ? 0 : 1,
      })
    }

    // POST/POST .../merge_requests/:iid/approve and /unapprove — test-facing simulation of "a reviewer
    // approved" (real GitLab performs this with the approving reviewer's own token; this fake's single
    // accepted PAT stands in for whichever reviewer a test wants to simulate).
    const approveMatch = rest.match(/^\/merge_requests\/(\d+)\/approve$/)
    if (req.method === 'POST' && approveMatch) {
      const mr = mergeRequests.get(Number(approveMatch[1]))
      if (!mr) return json(404, { message: `No fake merge request !${approveMatch[1]}` })
      mr.approved = true
      if (!mr.approved_by.some((u) => u.id === FAKE_APPROVER.id)) mr.approved_by.push(FAKE_APPROVER)
      return json(201, { approved: true })
    }
    const unapproveMatch = rest.match(/^\/merge_requests\/(\d+)\/unapprove$/)
    if (req.method === 'POST' && unapproveMatch) {
      const mr = mergeRequests.get(Number(unapproveMatch[1]))
      if (!mr) return json(404, { message: `No fake merge request !${unapproveMatch[1]}` })
      mr.approved = false
      mr.approved_by = []
      return json(201, { approved: false })
    }

    // GET .../merge_requests/:iid/discussions — lib/gitlabPullRequestsClient.js's getDiscussions.
    const discussionsMatch = rest.match(/^\/merge_requests\/(\d+)\/discussions$/)
    if (req.method === 'GET' && discussionsMatch) {
      const mr = mergeRequests.get(Number(discussionsMatch[1]))
      if (!mr) return json(404, { message: `No fake merge request !${discussionsMatch[1]}` })
      return json(200, mr.discussions)
    }
    // POST .../merge_requests/:iid/discussions — test-facing: opens a new (unresolved) discussion
    // thread, simulating a reviewer leaving feedback without approving.
    if (req.method === 'POST' && discussionsMatch) {
      const mr = mergeRequests.get(Number(discussionsMatch[1]))
      if (!mr) return json(404, { message: `No fake merge request !${discussionsMatch[1]}` })
      const body = await readJsonBody(req)
      const discussion = {
        id: `fake-discussion-${++discussionIdCounter}`,
        individual_note: false,
        notes: [{ id: discussionIdCounter, body: body.body ?? '', resolvable: true, resolved: false }],
      }
      mr.discussions.push(discussion)
      return json(201, discussion)
    }
    // PUT .../merge_requests/:iid/discussions/:discussion_id — test-facing: resolves (or unresolves)
    // every resolvable note in that discussion, real GitLab's own documented contract for this endpoint.
    const discussionResolveMatch = rest.match(/^\/merge_requests\/(\d+)\/discussions\/([^/]+)$/)
    if (req.method === 'PUT' && discussionResolveMatch) {
      const mr = mergeRequests.get(Number(discussionResolveMatch[1]))
      if (!mr) return json(404, { message: `No fake merge request !${discussionResolveMatch[1]}` })
      const discussion = mr.discussions.find((d) => d.id === discussionResolveMatch[2])
      if (!discussion) return json(404, { message: `No fake discussion "${discussionResolveMatch[2]}"` })
      const body = await readJsonBody(req)
      const resolved = body.resolved !== false
      discussion.notes = discussion.notes.map((note) => (note.resolvable ? { ...note, resolved } : note))
      return json(200, discussion)
    }

    // GET .../merge_requests/:iid/commits — #33's getPullRequestCommits. This fake's git model has no
    // real commit history to walk (mirrors fakeGitHubServer.js's own Pull Requests commits route), so
    // it reports the source branch's own current tip commit as the MR's sole commit — enough for
    // lib/stageStatus.js's commit-panel summary.
    const mrCommitsMatch = rest.match(/^\/merge_requests\/(\d+)\/commits$/)
    if (req.method === 'GET' && mrCommitsMatch) {
      const mr = mergeRequests.get(Number(mrCommitsMatch[1]))
      if (!mr) return json(404, { message: `No fake merge request !${mrCommitsMatch[1]}` })
      const tip = branchTips.get(mr.source_branch)
      if (!tip) return json(200, [])
      return json(200, [
        { id: tip.commitId, short_id: tip.commitId, title: `fake commit ${tip.commitId}`, message: `fake commit ${tip.commitId}`, committed_date: tip.committedDate, authored_date: tip.authoredDate },
      ])
    }

    // PUT .../merge_requests/:iid/merge — #33's completePullRequest. `mergeRefusal`
    // (`{ status, message }`) simulates a protected-branch or push-rule block; otherwise the merge
    // always succeeds with a merge commit, fast-forwarding `target_branch` to `source_branch`'s
    // current content.
    const mrMergeMatch = rest.match(/^\/merge_requests\/(\d+)\/merge$/)
    if (req.method === 'PUT' && mrMergeMatch) {
      const mr = mergeRequests.get(Number(mrMergeMatch[1]))
      if (!mr) return json(404, { message: `No fake merge request !${mrMergeMatch[1]}` })
      if (mr.state === 'merged') return json(405, { message: '405 Method Not Allowed (fake: already merged)' })
      if (mergeRefusal) {
        return json(mergeRefusal.status ?? 405, { message: mergeRefusal.message ?? '405 Method Not Allowed' })
      }
      const sourceStore = branches.get(mr.source_branch)
      if (sourceStore) branches.set(mr.target_branch, new Map(sourceStore))
      commitCounter += 1
      const date = new Date().toISOString()
      const mergeCommit = { commitId: `fake-commit-${commitCounter}`, committedDate: date, authoredDate: date }
      branchTips.set(mr.target_branch, mergeCommit)
      mr.state = 'merged'
      return json(200, { id: mr.id, iid: mr.iid, state: 'merged', merge_commit_sha: mergeCommit.commitId })
    }

    return json(404, { message: `No fake route for ${req.method} ${rawPathname}` })
  })
}

/** Starts a `createFakeGitLabServer` on an ephemeral port for the duration of `fn(baseUrl)`, then closes it — mirrors `tests/helpers/fakeGitHubServer.js`'s own `withFakeGitHubServer` shape. */
export function withFakeGitLabServer({ namespace, repository, validPat, files, branchFiles, repoExists, members, mergeRefusal, viewerAccessLevel }, fn) {
  return new Promise((resolve, reject) => {
    const server = createFakeGitLabServer({ namespace, repository, validPat, files, branchFiles, repoExists, members, mergeRefusal, viewerAccessLevel })
    server.listen(0, async () => {
      const { port } = server.address()
      try {
        await fn(`http://localhost:${port}/api/v4`)
        resolve()
      } catch (err) {
        reject(err)
      } finally {
        server.close()
      }
    })
  })
}

export const GITLAB_NAMESPACE = 'fake-group/fake-subgroup'
export const GITLAB_REPOSITORY = 'fake-repo'
export const GITLAB_VALID_PAT = 'valid-gitlab-test-pat'
