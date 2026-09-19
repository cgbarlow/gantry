import { createServer } from 'node:http'

/**
 * A minimal in-process fake of the Bitbucket Cloud REST API (2.0), standing in for a real
 * `api.bitbucket.org` repository in tests (#41) — a real HTTP server on an ephemeral port that
 * `lib/bitbucketClient.js` talks to over real `fetch` calls, never a mock of `fetch` itself. Mirrors
 * `tests/helpers/fakeGitLabServer.js`'s own shape and conventions so the fakes read the same way to a
 * caller working across providers, adapted to Bitbucket's own actual API shape rather than assuming
 * GitLab's — see `lib/bitbucketClient.js`'s own module doc comment for the specific differences this
 * fake exists to exercise (Bearer-only auth, hash-addressed content reads, the multipart `/src`
 * write/delete endpoint).
 *
 * Covers the subset `lib/bitbucketClient.js` implements so far (#41's content-store scope): the
 * repository metadata endpoint (`GET /repositories/{workspace}/{repo_slug}`), the filtered branches
 * list (`GET .../refs/branches?q=name="..."`, the slash-safe way this client always resolves a branch
 * name to its tip commit hash — see `lib/bitbucketClient.js`'s own "Branch names containing '/'" doc
 * comment), branch creation (`POST .../refs/branches`), the hash-addressed Source API
 * (`GET .../src/{hash}/{path}`, with and without `?format=meta`) and the multipart commit endpoint
 * (`POST .../src`) that adds/updates/deletes files in one commit. #49 adds
 * `lib/bitbucketPullRequestsClient.js`'s own scope on top — create/read/update-reviewers
 * (`POST`/`GET`/`PUT .../pullrequests[/{id}]`) plus two test-only convenience routes
 * (`POST .../pullrequests/{id}/approve` and `.../request-changes`) simulating a reviewer acting
 * directly on Bitbucket, the same role `fakeGitLabServer.js`'s own `/approve`/`/discussions` routes
 * play for GitLab. #46 (merge, wired into sign-off) extends this the same incremental way.
 *
 * Unlike GitLab's own `namespace%2Frepository`-style opaque `:id`, a Bitbucket workspace/repo slug is
 * always a single path segment with no internal encoding concerns — this fake's own routing is
 * correspondingly simpler.
 *
 * This fake stores content by commit **hash**, not by branch name — `stores: Map<hash, Map<path,
 * Buffer>>` — with `branchTips: Map<branchName, { hash, date }>` pointing at the hash each branch
 * currently resolves to. This mirrors what `lib/bitbucketClient.js` itself actually asks of the real
 * API (every content read resolves a branch to a hash first, then addresses content by that hash), so
 * this fake never needs to reason about "which branch is this path on" the way a name-keyed store
 * would.
 *
 * `files` seeds `main`'s initial content, keyed by repo-relative path (leading "/" optional).
 * `branchFiles`, if given, seeds one or more other branches the same way, each becoming its own
 * initial commit. `validPat` is the token (or, if an array, any one of several) accepted in the
 * `Authorization: Bearer <token>` header this client always sends (`lib/bitbucketClient.js`'s own
 * "Bearer, not Basic" doc comment) — anything else, or a missing/malformed header, gets a 401.
 * `repoExists` (default `true`) controls whether the repository is reported as existing at all —
 * `false` 404s every route under this repository, simulating a workspace/repo slug that doesn't
 * resolve to anything.
 *
 * `permissions` (#44, default `[]`) seeds `GET /workspaces/{workspace}/permissions/repositories/{repo_slug}`
 * — Bitbucket's own repository-permissions API, `lib/bitbucketIdentityClient.js`'s whole candidate set.
 * Each entry is `{ uuid, accountId, displayName, nickname, permission }` — `permission` is Bitbucket's
 * own "read"/"write"/"admin" scale, exercising that client's own write-or-above assignability gate. This
 * route lives under `/workspaces/{workspace}/...`, not `/repositories/{workspace}/{repo_slug}/...` like
 * every other route below — a genuine Bitbucket API inconsistency `lib/bitbucketIdentityClient.js`'s own
 * doc comment already notes — so it is matched against the raw pathname directly, before this fake's
 * `repoBasePath`-relative routing (and its own `repoExists` gate) even applies.
 *
 * `mergeRefusal` (`{ status, message }`, #46) makes every pull request merge attempt fail with that
 * response instead of succeeding — reproducing a branch-restriction or failed-merge-check refusal
 * (ADR-0042: "surfaced verbatim as a blocked sign-off") so that behaviour is genuinely testable, the
 * same knob `tests/helpers/fakeGitLabServer.js`'s own `mergeRefusal` provides.
 *
 * Pull requests (#46) are modelled as a flat `Map<id, pr>`, `pr` carrying `{ id, title, description,
 * state, source_branch, destination_branch, participants }` — `participants` is Bitbucket's own tri-
 * state reviewer list (`lib/bitbucketPullRequestsClient.js`'s whole `interpretBitbucketPullRequest`
 * input), each entry `{ user, role: 'REVIEWER' | 'PARTICIPANT', approved, state: 'approved' |
 * 'changes_requested' | null }`. Real approval/changes-requested is a reviewer's own action, performed
 * with their own token; this fake has only one accepted PAT, so a test simulates either outcome via
 * this fake's own test-facing `POST .../pullrequests/{id}/approve` / `.../request-changes` endpoints
 * (both genuine, documented Bitbucket Cloud routes, unlike `fakeGitLabServer.js`'s own approve/
 * unapprove pair, which stand in for GitLab's real per-user approval action the same way). Merge
 * (`POST .../pullrequests/{id}/merge`) fast-forwards the destination branch's own tip to the source
 * branch's current tip — enough to prove a caller can read the merged content back afterwards, without
 * modelling a genuine two-parent merge commit, the same simplification `fakeGitLabServer.js`'s own
 * merge route makes.
 */
export function createFakeBitbucketServer({
  owner,
  repository,
  validPat,
  files = {},
  branchFiles = {},
  repoExists = true,
  permissions = [],
  mergeRefusal = null,
} = {}) {
  const stores = new Map() // hash -> Map<normalized path, Buffer>
  const commitDates = new Map() // hash -> ISO date string, so re-pointing a branch at an existing hash (createBranch) doesn't mint a fresh date
  const branchTips = new Map() // branch name -> { hash, date }
  let commitCounter = 0

  // ---- Pull requests (#46, #49) ----
  const pullRequests = new Map() // id -> { id, title, description, state, source_branch, destination_branch, participants }
  let pullRequestIdCounter = 0
  const FAKE_REVIEWER = { uuid: '{fake-reviewer-uuid}', display_name: 'Fake Reviewer', nickname: 'fake-reviewer' }

  function toPullRequestResource(pr) {
    return {
      id: pr.id,
      title: pr.title,
      description: pr.description,
      state: pr.state,
      source: { branch: { name: pr.source_branch } },
      destination: { branch: { name: pr.destination_branch } },
      participants: pr.participants,
    }
  }

  function findParticipant(pr, uuid) {
    return pr.participants.find((p) => p.user.uuid === uuid)
  }

  function normalize(path) {
    return path.replace(/^\/+/, '').replace(/\/+$/, '')
  }

  function mintCommit(contentMap) {
    commitCounter += 1
    const hash = `fake-bb-commit-${commitCounter}`
    const date = new Date().toISOString()
    stores.set(hash, contentMap)
    commitDates.set(hash, date)
    return { hash, date }
  }

  function seedBranch(name, seedFiles) {
    const contentMap = new Map(
      Object.entries(seedFiles).map(([path, content]) => [normalize(path), Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')])
    )
    branchTips.set(name, mintCommit(contentMap))
  }
  seedBranch('main', files)
  for (const [branchName, seedFiles] of Object.entries(branchFiles)) {
    seedBranch(branchName, seedFiles)
  }

  function branchObject(name, tip) {
    return { type: 'branch', name, target: { type: 'commit', hash: tip.hash, date: tip.date } }
  }

  // Immediate children of `scopePath` (repo-root when `''`) within `store` — the same "no real folder
  // concept, infer from flat stored paths" approach `fakeGitLabServer.js`'s own tree computation uses.
  function listChildren(store, scopePath) {
    const prefix = scopePath === '' ? '' : `${scopePath}/`
    const children = new Map() // name -> isDirectory
    for (const key of store.keys()) {
      if (prefix && !key.startsWith(prefix)) continue
      const restOfKey = prefix ? key.slice(prefix.length) : key
      if (restOfKey === '') continue
      const [name, ...more] = restOfKey.split('/')
      const isDirectory = more.length > 0
      children.set(name, (children.get(name) ?? false) || isDirectory)
    }
    return [...children.entries()]
      .map(([name, isDirectory]) => ({
        path: scopePath === '' ? name : `${scopePath}/${name}`,
        type: isDirectory ? 'commit_directory' : 'commit_file',
      }))
      .sort((a, b) => a.path.localeCompare(b.path))
  }

  const repoBasePath = `/2.0/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`

  async function readJsonBody(req) {
    let raw = ''
    for await (const chunk of req) raw += chunk
    return raw ? JSON.parse(raw) : {}
  }

  async function readRawBody(req) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    return Buffer.concat(chunks)
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake-bitbucket.invalid')
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    // Bearer-only, per lib/bitbucketClient.js's own doc comment ("Bearer, not Basic") — a real
    // Bitbucket API token needs no accompanying email this way.
    const validPats = Array.isArray(validPat) ? validPat : [validPat]
    const authHeader = req.headers['authorization'] ?? ''
    const providedToken = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null
    if (!providedToken || !validPats.includes(providedToken)) {
      return json(401, { type: 'error', error: { message: '401 Unauthorized (fake server: invalid or missing Bearer token)' } })
    }

    // GET /workspaces/{workspace}/permissions/repositories/{repo_slug} — #44's
    // lib/bitbucketIdentityClient.js. Lives under a different path prefix than every other route below
    // (see this factory's own doc comment on `permissions`), so it's matched here, ahead of (and
    // independent of) the `/repositories/...`-relative routing and `repoExists` gate below.
    const permissionsPath = `/2.0/workspaces/${encodeURIComponent(owner)}/permissions/repositories/${encodeURIComponent(repository)}`
    if (req.method === 'GET' && url.pathname === permissionsPath) {
      const values = permissions.map((p) => ({
        type: 'repository_permission',
        permission: p.permission,
        user: {
          type: 'user',
          display_name: p.displayName,
          uuid: p.uuid,
          account_id: p.accountId,
          nickname: p.nickname,
        },
      }))
      return json(200, { pagelen: 100, size: values.length, page: 1, values })
    }

    if (!url.pathname.startsWith(repoBasePath)) {
      return json(404, { type: 'error', error: { message: `No fake route for ${req.method} ${url.pathname}` } })
    }
    const rest = url.pathname.slice(repoBasePath.length)

    // GET /repositories/{workspace}/{repo_slug} — lib/bitbucketClient.js's getRepo()/repoExists().
    if (req.method === 'GET' && rest === '') {
      if (!repoExists) {
        return json(404, { type: 'error', error: { message: '404 (fake: no repository at this workspace/repo_slug)' } })
      }
      return json(200, { type: 'repository', name: repository, full_name: `${owner}/${repository}`, slug: repository })
    }

    // Every other route 404s the same way real Bitbucket would if the repository itself doesn't exist.
    if (!repoExists) {
      return json(404, { type: 'error', error: { message: '404 (fake: no repository at this workspace/repo_slug)' } })
    }

    // GET /repositories/{workspace}/{repo_slug}/refs/branches?q=name="<branch>" — the filtered list
    // lib/bitbucketClient.js's getBranchTip/getBranchObjectId always use (never the by-name route),
    // because it takes the branch name as a query *value*, not a URL path segment, so a name
    // containing "/" (every gantry stage branch) is never ambiguous with the path segment boundary the
    // way `/refs/branches/{name}` would be. With no `q` at all, lists every branch.
    if (req.method === 'GET' && rest === '/refs/branches') {
      const q = url.searchParams.get('q')
      const match = q ? /^name="(.*)"$/.exec(q) : null
      const wanted = match ? match[1] : null
      const values = [...branchTips.entries()]
        .filter(([name]) => wanted === null || name === wanted)
        .map(([name, tip]) => branchObject(name, tip))
      return json(200, { pagelen: 100, size: values.length, page: 1, values })
    }

    // POST /repositories/{workspace}/{repo_slug}/refs/branches — lib/bitbucketClient.js's
    // createBranch(), which always supplies target.hash pre-resolved (never a bare branch name),
    // exactly the payload shape real Bitbucket documents for this endpoint.
    if (req.method === 'POST' && rest === '/refs/branches') {
      const body = await readJsonBody(req)
      const name = body.name
      const hash = body.target?.hash
      if (!name || !hash) {
        return json(400, { type: 'error', error: { message: 'name and target.hash are required' } })
      }
      if (branchTips.has(name)) {
        return json(400, { type: 'error', error: { message: `Branch "${name}" already exists.` } })
      }
      if (!stores.has(hash)) {
        return json(404, { type: 'error', error: { message: `404 (fake: no commit "${hash}")` } })
      }
      const tip = { hash, date: commitDates.get(hash) }
      branchTips.set(name, tip)
      return json(201, branchObject(name, tip))
    }

    // GET /repositories/{workspace}/{repo_slug}/src/{hash}/{path...}[?format=meta] — Bitbucket's own
    // Source API, always addressed here by a resolved commit hash (see the filtered-branches route's
    // own comment above for why lib/bitbucketClient.js never puts a raw branch name in this URL).
    // Real Bitbucket returns a file's *raw* content for a file path with no format param, a JSON
    // `{type: 'commit_file' | 'commit_directory', ...}` doc when `?format=meta` is given, and a JSON
    // `{values: [...]}` paginated listing for a directory path with no format param — this fake
    // reproduces exactly those three shapes.
    const srcMatch = rest.match(/^\/src\/([^/]+)\/(.*)$/)
    if (req.method === 'GET' && srcMatch) {
      const hash = decodeURIComponent(srcMatch[1])
      const rawPath = srcMatch[2].replace(/\/+$/, '')
      const decodedPath = rawPath ? rawPath.split('/').map(decodeURIComponent).join('/') : ''
      const store = stores.get(hash)
      if (!store) {
        return json(404, { type: 'error', error: { message: `404 (fake: no commit "${hash}")` } })
      }

      const fileContent = store.get(decodedPath)
      const isFile = fileContent !== undefined
      const isFormatMeta = url.searchParams.get('format') === 'meta'
      const isDirectory = !isFile && (decodedPath === '' || [...store.keys()].some((k) => k.startsWith(`${decodedPath}/`)))

      if (!isFile && !isDirectory) {
        return json(404, { type: 'error', error: { message: `404 (fake: nothing at "${decodedPath}" on commit "${hash}")` } })
      }
      if (isFile) {
        if (isFormatMeta) {
          return json(200, { type: 'commit_file', path: decodedPath, size: fileContent.length, attributes: [] })
        }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
        return res.end(fileContent)
      }
      // isDirectory
      if (isFormatMeta) {
        return json(200, { type: 'commit_directory', path: decodedPath })
      }
      return json(200, { pagelen: 100, size: 0, page: 1, values: listChildren(store, decodedPath) })
    }

    // POST /repositories/{workspace}/{repo_slug}/src — Bitbucket's own "create a commit by uploading
    // files" endpoint, multipart/form-data: file fields keyed by repo path (real content as the
    // value), plus meta fields `message`/`branch`/(`author`/`parents`, accepted but not modelled by
    // this fake) and one or more repeated `files` fields naming paths to delete. Parsed here by
    // reconstructing a `Request` from the raw body and calling its own `.formData()` — Node's
    // undici-backed `fetch` implementation already has a complete multipart parser, so this fake
    // doesn't need to hand-roll one.
    if (req.method === 'POST' && rest === '/src') {
      const rawBody = await readRawBody(req)
      const contentType = req.headers['content-type']
      const parsedRequest = new Request('http://fake-bitbucket.invalid/src', {
        method: 'POST',
        headers: contentType ? { 'content-type': contentType } : undefined,
        body: rawBody,
      })
      const form = await parsedRequest.formData()

      let branch = 'main'
      const deletions = []
      const writes = []
      for (const [key, value] of form.entries()) {
        if (key === 'branch') {
          branch = String(value)
          continue
        }
        if (key === 'message' || key === 'author' || key === 'parents') continue
        if (key === 'files') {
          deletions.push(normalize(String(value)))
          continue
        }
        const bytes = Buffer.from(await value.arrayBuffer())
        writes.push({ path: normalize(key), bytes })
      }

      // Real Bitbucket: an explicit, already-existing branch commits on top of that branch's own tip;
      // a new branch name (with no `parents` override, which this client never sends) inherits from
      // main's current tip without advancing main; an entirely empty repository's first commit defines
      // main itself — the same three cases lib/bitbucketClient.js's own "Writing files" doc comment
      // describes.
      const currentTip = branchTips.get(branch)
      let baseStore
      if (currentTip) {
        baseStore = new Map(stores.get(currentTip.hash))
      } else if (branchTips.size === 0) {
        baseStore = new Map()
      } else {
        const mainTip = branchTips.get('main')
        baseStore = mainTip ? new Map(stores.get(mainTip.hash)) : new Map()
      }

      for (const write of writes) baseStore.set(write.path, write.bytes)
      for (const path of deletions) baseStore.delete(path)

      const tip = mintCommit(baseStore)
      branchTips.set(branch, tip)

      // Real Bitbucket documents no response schema for this 201 — lib/bitbucketClient.js's own
      // writeFiles re-reads the branch's new tip afterwards rather than depending on one.
      res.writeHead(201, { 'Content-Type': 'application/json' })
      return res.end('')
    }

    // POST /repositories/{workspace}/{repo_slug}/pullrequests — lib/bitbucketPullRequestsClient.js's
    // createPullRequest.
    if (req.method === 'POST' && rest === '/pullrequests') {
      const body = await readJsonBody(req)
      const sourceBranch = body.source?.branch?.name
      const destinationBranch = body.destination?.branch?.name
      if (!sourceBranch || !destinationBranch || !body.title) {
        return json(400, { type: 'error', error: { message: 'source.branch.name, destination.branch.name and title are required' } })
      }
      const id = ++pullRequestIdCounter
      const pr = {
        id,
        title: body.title,
        description: body.description ?? '',
        state: 'OPEN',
        source_branch: sourceBranch,
        destination_branch: destinationBranch,
        participants: (body.reviewers ?? []).map((r) => ({
          user: { uuid: r.uuid, display_name: r.uuid, nickname: r.uuid },
          role: 'REVIEWER',
          approved: false,
          state: null,
        })),
      }
      pullRequests.set(id, pr)
      return json(201, toPullRequestResource(pr))
    }

    // GET/PUT /repositories/{workspace}/{repo_slug}/pullrequests/{id} — getPullRequest, and
    // addReviewers's own full-replace `PUT ... { reviewers: [{uuid}] }` (Bitbucket has no dedicated
    // "add a reviewer to an existing pull request" endpoint — see
    // lib/bitbucketPullRequestsClient.js's own addReviewers doc comment).
    const prMatch = rest.match(/^\/pullrequests\/(\d+)$/)
    if (req.method === 'GET' && prMatch) {
      const pr = pullRequests.get(Number(prMatch[1]))
      if (!pr) return json(404, { type: 'error', error: { message: `No fake pull request #${prMatch[1]}` } })
      return json(200, toPullRequestResource(pr))
    }
    if (req.method === 'PUT' && prMatch) {
      const pr = pullRequests.get(Number(prMatch[1]))
      if (!pr) return json(404, { type: 'error', error: { message: `No fake pull request #${prMatch[1]}` } })
      const body = await readJsonBody(req)
      if (body.reviewers) {
        pr.participants = body.reviewers.map(
          (r) => findParticipant(pr, r.uuid) ?? { user: { uuid: r.uuid, display_name: r.uuid, nickname: r.uuid }, role: 'REVIEWER', approved: false, state: null }
        )
      }
      if (body.title !== undefined) pr.title = body.title
      if (body.description !== undefined) pr.description = body.description
      return json(200, toPullRequestResource(pr))
    }

    // POST/DELETE .../pullrequests/{id}/approve — genuine Bitbucket Cloud routes (unlike
    // fakeGitLabServer.js's own approve/unapprove pair, which stand in for GitLab's real per-reviewer
    // action the same way): test-facing simulation of "the fake reviewer approved" / "withdrew their
    // approval". Real Bitbucket performs this with the approving reviewer's own token; this fake's
    // single accepted PAT stands in for whichever reviewer a test wants to simulate.
    const approveMatch = rest.match(/^\/pullrequests\/(\d+)\/approve$/)
    if (approveMatch) {
      const pr = pullRequests.get(Number(approveMatch[1]))
      if (!pr) return json(404, { type: 'error', error: { message: `No fake pull request #${approveMatch[1]}` } })
      if (req.method === 'POST') {
        const existing = findParticipant(pr, FAKE_REVIEWER.uuid)
        if (existing) {
          existing.approved = true
          existing.state = 'approved'
          existing.role = 'REVIEWER'
        } else {
          pr.participants.push({ user: { ...FAKE_REVIEWER }, role: 'REVIEWER', approved: true, state: 'approved' })
        }
        return json(200, { approved: true })
      }
      if (req.method === 'DELETE') {
        const existing = findParticipant(pr, FAKE_REVIEWER.uuid)
        if (existing) {
          existing.approved = false
          existing.state = null
        }
        return json(200, { approved: false })
      }
    }

    // POST/DELETE .../pullrequests/{id}/request-changes — the tri-state's other genuine Bitbucket
    // Cloud route: test-facing simulation of "the fake reviewer requested changes" / withdrew that.
    const requestChangesMatch = rest.match(/^\/pullrequests\/(\d+)\/request-changes$/)
    if (requestChangesMatch) {
      const pr = pullRequests.get(Number(requestChangesMatch[1]))
      if (!pr) return json(404, { type: 'error', error: { message: `No fake pull request #${requestChangesMatch[1]}` } })
      if (req.method === 'POST') {
        const existing = findParticipant(pr, FAKE_REVIEWER.uuid)
        if (existing) {
          existing.approved = false
          existing.state = 'changes_requested'
          existing.role = 'REVIEWER'
        } else {
          pr.participants.push({ user: { ...FAKE_REVIEWER }, role: 'REVIEWER', approved: false, state: 'changes_requested' })
        }
        return json(200, { approved: false })
      }
      if (req.method === 'DELETE') {
        const existing = findParticipant(pr, FAKE_REVIEWER.uuid)
        if (existing) existing.state = null
        return json(200, { approved: false })
      }
    }

    // GET .../pullrequests/{id}/commits — lib/bitbucketPullRequestsClient.js's getPullRequestCommits.
    // This fake's git model has no real commit history to walk (mirrors fakeGitLabServer.js's own
    // equivalent route), so it reports the source branch's own current tip as the pull request's sole
    // commit — enough for lib/stageStatus.js's commit-panel summary.
    const prCommitsMatch = rest.match(/^\/pullrequests\/(\d+)\/commits$/)
    if (req.method === 'GET' && prCommitsMatch) {
      const pr = pullRequests.get(Number(prCommitsMatch[1]))
      if (!pr) return json(404, { type: 'error', error: { message: `No fake pull request #${prCommitsMatch[1]}` } })
      const tip = branchTips.get(pr.source_branch)
      if (!tip) return json(200, { pagelen: 100, size: 0, page: 1, values: [] })
      return json(200, { pagelen: 100, size: 1, page: 1, values: [{ hash: tip.hash, date: tip.date, message: `fake commit ${tip.hash}` }] })
    }

    // POST .../pullrequests/{id}/merge — lib/bitbucketPullRequestsClient.js's completePullRequest.
    // `mergeRefusal` (`{ status, message }`) simulates a branch-restriction or failed-merge-check
    // block; otherwise the merge always succeeds, fast-forwarding the destination branch to the source
    // branch's current tip (see this factory's own doc comment for why that's enough here).
    const mergeMatch = rest.match(/^\/pullrequests\/(\d+)\/merge$/)
    if (req.method === 'POST' && mergeMatch) {
      const pr = pullRequests.get(Number(mergeMatch[1]))
      if (!pr) return json(404, { type: 'error', error: { message: `No fake pull request #${mergeMatch[1]}` } })
      if (pr.state === 'MERGED') {
        return json(400, { type: 'error', error: { message: '400 Bad Request (fake: already merged)' } })
      }
      if (mergeRefusal) {
        return json(mergeRefusal.status ?? 409, { type: 'error', error: { message: mergeRefusal.message ?? '409 Conflict' } })
      }
      const sourceTip = branchTips.get(pr.source_branch)
      if (sourceTip) branchTips.set(pr.destination_branch, sourceTip)
      pr.state = 'MERGED'
      return json(200, toPullRequestResource(pr))
    }

    return json(404, { type: 'error', error: { message: `No fake route for ${req.method} ${url.pathname}` } })
  })
}

/** Starts a `createFakeBitbucketServer` on an ephemeral port for the duration of `fn(baseUrl)`, then closes it — mirrors `tests/helpers/fakeGitLabServer.js`'s own `withFakeGitLabServer` shape. */
export function withFakeBitbucketServer({ owner, repository, validPat, files, branchFiles, repoExists, permissions, mergeRefusal }, fn) {
  return new Promise((resolve, reject) => {
    const server = createFakeBitbucketServer({ owner, repository, validPat, files, branchFiles, repoExists, permissions, mergeRefusal })
    server.listen(0, async () => {
      const { port } = server.address()
      try {
        await fn(`http://localhost:${port}/2.0`)
        resolve()
      } catch (err) {
        reject(err)
      } finally {
        server.close()
      }
    })
  })
}

export const BITBUCKET_OWNER = 'fake-account'
export const BITBUCKET_REPOSITORY = 'fake-repo'
export const BITBUCKET_VALID_PAT = 'valid-bitbucket-test-token'
