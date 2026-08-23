import { createServer } from 'node:http'

function objectIdFor(n) {
  return String(n).padStart(40, '0')
}

// Generic fallback states for any work item type not given an explicit
// entry in `workItemTypeStates` — plausible-looking but not meant to match
// any one real process template exactly (tests that care about a specific
// type's states pass `workItemTypeStates` explicitly).
const DEFAULT_WORK_ITEM_TYPE_STATES = [
  { name: 'New', category: 'Proposed', color: 'b2b2b2' },
  { name: 'Active', category: 'InProgress', color: '007acc' },
  { name: 'Resolved', category: 'Resolved', color: 'ff9d00' },
  { name: 'Closed', category: 'Completed', color: '339933' },
]

/**
 * A minimal in-process fake of the Azure DevOps Git Items/Refs/Pushes REST
 * API, standing in for a real `dev.azure.com` org/project/repo in tests
 * (#84) — a real HTTP server on an ephemeral port that lib/azureDevOpsClient.js
 * talks to over real `fetch` calls, never a mock of `fetch` itself. Extended
 * by #99 to also fake the Work Items create/update/get-type-states
 * endpoints lib/azureDevOpsWorkItemsClient.js talks to, the same way.
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
 *
 * `workItemTypeStates`, if given, maps a work item type name (e.g. "Task")
 * to the array of valid states GET .../workitemtypes/{type}/states should
 * report for it — either full `{ name, category, color }` entries (Azure
 * DevOps's own shape) or plain state-name strings (auto-filled with
 * placeholder category/color). Falls back to a generic 4-state list for any
 * type not given an explicit entry.
 */
export function createFakeAzureDevOpsServer({
  organization,
  project,
  repository,
  validPat,
  files = {},
  failAfterPushes,
  workItemTypeStates = {},
} = {}) {
  const store = new Map(Object.entries(files).map(([path, content]) => [path.startsWith('/') ? path : `/${path}`, content]))
  let commitCount = store.size > 0 ? 1 : 0
  let currentObjectId = commitCount > 0 ? objectIdFor(commitCount) : objectIdFor(0)
  let pushesMade = 0

  const basePath = `/${organization}/${project}/_apis/git/repositories/${repository}`
  const witBasePath = `/${organization}/${project}/_apis/wit`
  const orgWorkItemsPath = `/${organization}/_apis/wit/workItems`

  // In-memory Work Items store, separate from the Git `store` above —
  // keyed by numeric id, seeded empty (no `files`-style seeding option;
  // tests create whatever work items they need via the client itself).
  const workItems = new Map()
  let nextWorkItemId = 1

  // Applies an Azure DevOps JSON Patch document (as sent by
  // lib/azureDevOpsWorkItemsClient.js's fieldsToPatch) to a fake work
  // item's fields/relations — only the "add a field" and "append a
  // relation" shapes that client actually produces, not general JSON
  // Patch (this fake only needs to satisfy its one real caller).
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
      return json(201, {
        pushId: commitCount,
        refUpdates: [{ name: refUpdate.name, newObjectId: currentObjectId }],
      })
    }

    if (req.method === 'POST' && pathname.startsWith(`${witBasePath}/workitems/$`)) {
      const type = pathname.slice(`${witBasePath}/workitems/$`.length)
      let raw = ''
      for await (const chunk of req) raw += chunk
      const patch = JSON.parse(raw)

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
export function withFakeAzureDevOpsServer(
  { organization, project, repository, validPat, files, failAfterPushes, workItemTypeStates },
  fn
) {
  return new Promise((resolve, reject) => {
    const server = createFakeAzureDevOpsServer({
      organization,
      project,
      repository,
      validPat,
      files,
      failAfterPushes,
      workItemTypeStates,
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
