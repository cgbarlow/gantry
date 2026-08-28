import {
  AzureDevOpsAuthenticationError,
  AzureDevOpsNotFoundError,
  AzureDevOpsRequestError,
  DEFAULT_BASE_URL,
  DEFAULT_API_VERSION,
  basicAuthHeader,
} from './azureDevOpsClient.js'

export {
  AzureDevOpsAuthenticationError,
  AzureDevOpsNotFoundError,
  AzureDevOpsRequestError,
  DEFAULT_BASE_URL,
  DEFAULT_API_VERSION,
}

/**
 * Returns true when an AzureDevOpsRequestError is a TF51535 field-not-found
 * failure for a specific field (e.g. Custom.GantryReviewStatus never
 * provisioned on the real process, WI219). Callers use this to distinguish
 * "field doesn't exist" (safe to retry without the field / fall back to
 * System.State inference) from unrelated 400s which must still propagate.
 */
export function isAzureDevOpsFieldNotFoundError(error, fieldName) {
  if (!(error instanceof AzureDevOpsRequestError)) return false
  const bodyText = typeof error.body === 'string' ? error.body : JSON.stringify(error.body ?? '')
  const isFieldNotFound = bodyText.includes('TF51535') || bodyText.includes('FieldNotFoundException')
  if (!isFieldNotFound) return false
  if (fieldName) return bodyText.includes(fieldName)
  return true
}

export const GANTRY_WORK_ITEM_TAG = 'gantry'

/**
 * A general-purpose Azure DevOps Work Items REST client — parallel to lib/azureDevOpsClient.js's Git-focused client (#84), covering the Work Items endpoints instead (#99, under #95's Workspace/work-item-lifecycle spec): creating a work item, creating a child work item linked to a parent, updating a work item's fields/state, and looking up which states a work item type natively supports. Kept as its own client/module rather than added to the Git client, per #99's own wording ("a new work-items client, parallel to the existing git-focused Azure DevOps client") — while still reusing that client's authentication helper and error-class taxonomy, so callers can catch one consistent set of error types regardless of which client raised them.
 *
 * Exists purely to enable #99's successor (the work-item linking/sync ticket, #103/#105) — this client ships no user-facing behaviour itself.
 *
 * Authenticated the same way as the Git client: a caller-supplied PAT via HTTP Basic auth (empty username, PAT as password).
 *
 * `baseUrl` defaults to the real Azure DevOps API but is overridable, so tests can point it at the same fake in-process server used by the Git client's tests (see tests/helpers/fakeAzureDevOpsServer.js, extended by #99 to also fake these Work Items endpoints) instead of `dev.azure.com`.
 *
 * Unlike the Git client, Work Items endpoints are scoped to an organisation/project — not a repository — so this client takes no `repository` option.
 */
export function createAzureDevOpsWorkItemsClient({
  organization,
  project,
  pat,
  baseUrl = DEFAULT_BASE_URL,
  apiVersion = DEFAULT_API_VERSION,
} = {}) {
  for (const [name, value] of Object.entries({ organization, project, pat })) {
    if (!value) throw new Error(`createAzureDevOpsWorkItemsClient: "${name}" is required`)
  }

  const trimmedBaseUrl = baseUrl.replace(/\/+$/, '')
  // Work item endpoints live under the project, not a repository — every path segment is still encoded for the same reason as the Git client: organisation/project names are free text and may contain characters ("#", "?", " ") that would otherwise be misparsed.
  const projectWitUrl = `${trimmedBaseUrl}/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/_apis/wit`
  // Parent/child relation links reference a work item by org-scoped URL (no project segment) — mirrors how Azure DevOps itself renders `relations[].url` in its own API responses.
  const orgWitUrl = `${trimmedBaseUrl}/${encodeURIComponent(organization)}/_apis/wit`
  const connectionDataUrl = `${trimmedBaseUrl}/${encodeURIComponent(organization)}/_apis/connectionData`

  async function request(url, { method = 'GET', headers = {}, body } = {}) {
    let res
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: basicAuthHeader(pat), ...headers },
        body,
      })
    } catch (err) {
      throw new AzureDevOpsRequestError(`Network error calling Azure DevOps API (${method} ${url}): ${err.message}`, {
        cause: err,
      })
    }

    if (res.status === 401 || res.status === 403) {
      throw new AzureDevOpsAuthenticationError(`Azure DevOps rejected the supplied PAT (HTTP ${res.status})`, {
        status: res.status,
      })
    }
    if (res.status === 404) {
      throw new AzureDevOpsNotFoundError(`Azure DevOps found no item for ${method} ${url} (HTTP 404)`, {
        status: res.status,
      })
    }
    if (!res.ok) {
      const responseBody = await res.text().catch(() => '')
      throw new AzureDevOpsRequestError(`Azure DevOps API request failed: ${method} ${url} -> HTTP ${res.status}`, {
        status: res.status,
        body: responseBody,
      })
    }
    return res
  }

  // Converts a plain { "System.Title": "...", ... } fields map into an Azure DevOps JSON Patch document — the wire format both create and update actually require. Callers of this client work with plain field maps rather than hand-building patch operations themselves.
  function fieldsToPatch(fields = {}) {
    return Object.entries(fields).map(([field, value]) => ({
      op: 'add',
      path: field.startsWith('/fields/') ? field : `/fields/${field}`,
      value,
    }))
  }

  /**
   * Creates a new work item of `type` (e.g. "Task", "Bug") with the given `fields`, keyed by Azure DevOps field reference name (e.g. "System.Title", "System.State") — the "/fields/" path prefix is added automatically. Returns the created work item (id, rev, fields, etc.), mirroring the shape Azure DevOps itself returns.
   */
  async function createWorkItem(type, fields) {
    const url = new URL(`${projectWitUrl}/workitems/$${encodeURIComponent(type)}`)
    url.searchParams.set('api-version', apiVersion)

    const res = await request(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json-patch+json', Accept: 'application/json' },
      body: JSON.stringify(fieldsToPatch(fields)),
    })
    return res.json()
  }

  /**
   * Creates a new work item of `type` as a child of `parentId` — a single create call that both sets `fields` and adds the parent/child hierarchy relation (Azure DevOps's "Hierarchy-Reverse" link type, from the child's own perspective), rather than a separate create-then-link round trip. Used to auto-create one child work item per stage under a linked instance's parent work item (#95).
   */
  async function createChildWorkItem(parentId, type, fields) {
    const url = new URL(`${projectWitUrl}/workitems/$${encodeURIComponent(type)}`)
    url.searchParams.set('api-version', apiVersion)

    const patch = [
      ...fieldsToPatch(fields),
      {
        op: 'add',
        path: '/relations/-',
        value: {
          rel: 'System.LinkTypes.Hierarchy-Reverse',
          url: `${orgWitUrl}/workItems/${parentId}`,
        },
      },
    ]

    const res = await request(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json-patch+json', Accept: 'application/json' },
      body: JSON.stringify(patch),
    })
    return res.json()
  }

  /**
   * Creates a new work item with a formal Related link to an existing work
   * item. Unlike the hierarchy helper above, this deliberately leaves both
   * work items at the same level in Azure DevOps.
   */
  async function createRelatedWorkItem(relatedId, type, fields) {
    const url = new URL(`${projectWitUrl}/workitems/$${encodeURIComponent(type)}`)
    url.searchParams.set('api-version', apiVersion)

    const patch = [
      ...fieldsToPatch(fields),
      {
        op: 'add',
        path: '/relations/-',
        value: {
          rel: 'System.LinkTypes.Related',
          url: `${orgWitUrl}/workItems/${relatedId}`,
        },
      },
    ]

    const res = await request(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json-patch+json', Accept: 'application/json' },
      body: JSON.stringify(patch),
    })
    return res.json()
  }

  /**
   * Updates an existing work item's `fields` (e.g. pushing a new System.State when a gate is passed, per #95's read-write sync decision) — a partial update; fields not mentioned are left as-is.
   */
  async function updateWorkItem(id, fields) {
    const url = new URL(`${projectWitUrl}/workitems/${id}`)
    url.searchParams.set('api-version', apiVersion)

    const res = await request(url.toString(), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json-patch+json', Accept: 'application/json' },
      body: JSON.stringify(fieldsToPatch(fields)),
    })
    return res.json()
  }

  /**
   * Adds a tag to an existing work item without rewriting it when the tag is
   * already present. Azure DevOps stores tags as one semicolon-delimited
   * string, so the current value is read before appending and every existing
   * tag is retained verbatim.
   */
  async function ensureWorkItemTag(id, tag = GANTRY_WORK_ITEM_TAG) {
    const current = await getWorkItem(id, { fields: ['System.Tags'] })
    const tags = current.fields?.['System.Tags'] ?? ''
    const hasTag = tags.split(';').some((value) => value.trim().toLowerCase() === tag.toLowerCase())
    if (hasTag) return { workItem: current, updated: false }

    const nextTags = tags.trim() ? `${tags}; ${tag}` : tag
    return {
      workItem: await updateWorkItem(id, { 'System.Tags': nextTags }),
      updated: true,
    }
  }

  /**
   * Fetches the valid states (e.g. "New", "Active", "Closed") a work item `type` natively supports in this project — needed to map a stage's Gantry progress onto whatever states the configured work item type actually has (#95), rather than assuming a hardcoded set. Returns the raw { name, category, color } entries Azure DevOps itself returns.
   */
  async function getWorkItemTypeStates(type) {
    const url = new URL(`${projectWitUrl}/workitemtypes/${encodeURIComponent(type)}/states`)
    url.searchParams.set('api-version', apiVersion)

    const res = await request(url.toString(), { headers: { Accept: 'application/json' } })
    const { value = [] } = await res.json()
    return value
  }

  /**
   * Fetches a single work item's own current field values by id (#106's
   * "New capability: fetch a specific Azure DevOps work item's current
   * field values by id" — carried over from ADR-0012, where it was meant
   * to drive stage-advancement gating; ADR-0014 superseded that mechanism
   * with a Pull Request instead, so this read is now purely for a
   * board-visible tracking display — e.g. #111's instance-screen synced-
   * fields panel — never for gating anything). Returns the same `{ id,
   * rev, fields, url }` shape `createWorkItem`/`updateWorkItem` already
   * return, so callers don't need a second response shape to handle.
   *
   * `fields`, if given, limits the response to that list of field
   * reference names (e.g. `['System.Title', 'System.State',
   * 'System.AssignedTo']`) — Azure DevOps's own supported narrowing,
   * mirrored here rather than always fetching every field the work item
   * carries. Omit it to get every field back, exactly like the real API.
   *
   * Unlike `createWorkItem`/`createChildWorkItem`/`updateWorkItem`, the
   * real "Get Work Item" endpoint's `relations` array is *not* present by
   * default — Azure DevOps only includes it when `$expand` asks for it
   * (its own documented default is `$expand=None`). This client mirrors
   * that rather than papering over it: pass `expand: 'relations'` (or
   * `'all'`) to get `relations` back on the response; omit it (the
   * default) and `relations` will be absent, exactly as the real API
   * behaves for a plain call.
   *
   * Throws AzureDevOpsNotFoundError if no work item exists for `id` (e.g.
   * a stale/deleted link) — the same not-found taxonomy every other read
   * in this codebase uses, rather than a bespoke "no such work item"
   * shape.
   */
  async function getWorkItem(id, { fields, expand } = {}) {
    const url = new URL(`${projectWitUrl}/workitems/${id}`)
    url.searchParams.set('api-version', apiVersion)
    if (fields && fields.length > 0) url.searchParams.set('fields', fields.join(','))
    if (expand) url.searchParams.set('$expand', expand)

    const res = await request(url.toString(), { headers: { Accept: 'application/json' } })
    return res.json()
  }

  /**
   * Returns the identity authenticated by the supplied PAT. Azure DevOps's
   * connection-data endpoint is used instead of treating the instance
   * assignee as the person making the request.
   */
  async function getCurrentUser() {
    const url = new URL(connectionDataUrl)
    url.searchParams.set('connectOptions', 'none')
    url.searchParams.set('lastChangeId', '-1')
    url.searchParams.set('lastChangeId64', '-1')
    url.searchParams.set('api-version', `${apiVersion}-preview.1`)

    const res = await request(url.toString(), { headers: { Accept: 'application/json' } })
    const user = (await res.json()).authenticatedUser
    if (!user) return null
    const uniqueName = user.uniqueName ?? user.properties?.Account?.$value ?? user.properties?.Mail?.$value ?? ''
    return {
      displayName: user.customDisplayName ?? user.providerDisplayName ?? user.displayName ?? uniqueName,
      uniqueName,
    }
  }

  /**
   * Lists the work item types (e.g. "Task", "Bug", "User Story") available
   * in this client's own project (#106's "New capability: list the work
   * item types available in a given Azure DevOps project, for the Work
   * Item Type lookup during instance creation" — used by #126's parent-
   * work-item-link wizard step so a caller can pick a real type rather
   * than typing one freetext). Returns the raw `{ name, referenceName,
   * description, color, icon, isDisabled }` entries Azure DevOps itself
   * returns, unfiltered — which types are actually usable/enabled for a
   * given process template is for the caller (or a future ticket) to
   * decide, not this client.
   */
  async function listWorkItemTypes() {
    const url = new URL(`${projectWitUrl}/workitemtypes`)
    url.searchParams.set('api-version', apiVersion)

    const res = await request(url.toString(), { headers: { Accept: 'application/json' } })
    const { value = [] } = await res.json()
    return value
  }

  return {
    organization,
    project,
    baseUrl,
    createWorkItem,
    createChildWorkItem,
    createRelatedWorkItem,
    updateWorkItem,
    ensureWorkItemTag,
    getWorkItemTypeStates,
    getWorkItem,
    getCurrentUser,
    listWorkItemTypes,
  }
}
