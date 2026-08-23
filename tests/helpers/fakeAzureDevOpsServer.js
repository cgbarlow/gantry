import { createServer } from 'node:http'

// n's hex digits, zero-padded to a *fixed* width (7) and placed at the
// *front* of the 40-character id, followed by a fixed run of zeroes — not
// simply end-padded ("n.toString(16).padEnd(40, '0')"), which is not
// actually collision-free: end-padding drops any distinction between how
// many significant hex digits n has, so e.g. objectIdFor(1) ("1" + 39
// zeroes) and objectIdFor(16) ("10" + 38 zeroes) produce the exact same
// 40-character string. Fixing the width of the leading hex digits before
// the zero-fill avoids that collision for any n below 16^7 — far more
// pushes than any test here performs — while still keeping distinct commit
// numbers distinguishable in their first few characters (e.g.
// objectIdFor(1) -> "0000001...", objectIdFor(16) -> "0000010..."), which
// tests asserting on a render footer's short (first-N-character) commit
// hash (#98) need.
function objectIdFor(n) {
  return n.toString(16).padStart(7, '0') + '0'.repeat(33)
}

/**
 * A minimal in-process fake of the Azure DevOps Git Items/Refs/Pushes REST
 * API, standing in for a real `dev.azure.com` org/project/repo in tests
 * (#84) — a real HTTP server on an ephemeral port that lib/azureDevOpsClient.js
 * talks to over real `fetch` calls, never a mock of `fetch` itself.
 *
 * `files` seeds the fake repo's initial content on `main`, keyed by
 * repo-relative path (leading "/" optional). `validPat` is the PAT (or, if
 * an array, any one of several PATs — e.g. to exercise replacing one valid
 * PAT with another) accepted as the password half of HTTP Basic auth (empty
 * username) — anything else, or no Authorization header at all, gets a 401,
 * mirroring how a rejected PAT surfaces from the real API.
 *
 * `failAfterPushes`, if given, makes every push (POST .../pushes) once
 * `failAfterPushes` pushes have already committed successfully *during this
 * server's lifetime* fail with a 500 — simulating a mid-flow outage (a
 * network blip, an expired PAT) for tests that need to exercise a caller's
 * partial-failure handling (e.g. a multi-file create like createInstance's
 * Azure DevOps path) without that test depending on how many GETs the
 * client happens to make per push. Counted separately from `commitCount`
 * (which seeds at 1 when `files` is non-empty) so `failAfterPushes` always
 * means "N real pushes made against this server", regardless of whether
 * `files` seeded an initial commit. Reads (`items`/`refs`) are never
 * affected by this — only the write path.
 */
export function createFakeAzureDevOpsServer({ organization, project, repository, validPat, files = {}, failAfterPushes } = {}) {
  const store = new Map(Object.entries(files).map(([path, content]) => [path.startsWith('/') ? path : `/${path}`, content]))
  let commitCount = store.size > 0 ? 1 : 0
  let currentObjectId = commitCount > 0 ? objectIdFor(commitCount) : objectIdFor(0)
  let pushesMade = 0

  const basePath = `/${organization}/${project}/_apis/git/repositories/${repository}`

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake-azure-devops.invalid')
    // Decode percent-encoded path segments before route-matching, the way
    // a real HTTP server/router does — lets this fake exercise the
    // client's URL-encoding of organisation/project/repository names
    // (which may contain spaces or other reserved characters) rather than
    // only matching when those names happen to need no encoding.
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

    if (req.method === 'GET' && pathname === `${basePath}/items`) {
      const path = url.searchParams.get('path')
      if (!store.has(path)) {
        return json(404, { message: `TF401174: Item ${path} not found (fake server).` })
      }
      return json(200, { path, content: store.get(path), objectId: currentObjectId })
    }

    if (req.method === 'GET' && pathname === `${basePath}/refs`) {
      const value = commitCount > 0 ? [{ name: 'refs/heads/main', objectId: currentObjectId }] : []
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

      const expectedOldObjectId = commitCount > 0 ? currentObjectId : objectIdFor(0)
      if (refUpdate.oldObjectId !== expectedOldObjectId) {
        return json(409, { message: `TF401028: The push (oldObjectId ${refUpdate.oldObjectId}) is out of date (fake server).` })
      }

      for (const commit of push.commits) {
        for (const change of commit.changes) {
          store.set(change.item.path, change.newContent.content)
        }
      }
      commitCount += 1
      pushesMade += 1
      currentObjectId = objectIdFor(commitCount)
      // A real push response's `commits[]` entries carry full commit
      // metadata (author/committer name+date, not just the commitId) —
      // this is what lib/render.js's Azure-DevOps-backed render path (#98)
      // reads its footer's commit hash/date from, rather than a separate
      // call, so the fake mirrors that shape rather than the bare
      // `{ commitId }` a caller uninterested in it might expect.
      const now = new Date().toISOString()
      return json(201, {
        pushId: commitCount,
        date: now,
        refUpdates: [{ name: refUpdate.name, newObjectId: currentObjectId }],
        commits: push.commits.map((commit) => ({
          commitId: currentObjectId,
          comment: commit.comment,
          author: { name: 'Fake Pusher', date: now },
          committer: { name: 'Fake Pusher', date: now },
        })),
      })
    }

    return json(404, { message: `No fake route for ${req.method} ${pathname}` })
  })
}

/**
 * Starts a `createFakeAzureDevOpsServer` on an ephemeral port for the
 * duration of `fn(baseUrl)`, then closes it — mirrors
 * `tests/server.test.js`'s `withRunningServer` helper's shape (per #82's
 * testing decisions). Shared by `tests/azureDevOpsClient.test.js` and
 * `tests/instance.test.js` so this lifecycle isn't duplicated across both.
 */
export function withFakeAzureDevOpsServer({ organization, project, repository, validPat, files, failAfterPushes }, fn) {
  return new Promise((resolve, reject) => {
    const server = createFakeAzureDevOpsServer({ organization, project, repository, validPat, files, failAfterPushes })
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
