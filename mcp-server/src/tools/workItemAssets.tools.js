// Work-item linking/tagging/sync, assignee, commit history, and asset upload/listing — one instance's
// auxiliary metadata and content. Ticket #60.

import { z } from 'zod'
import { resolveInstanceWorkspace } from '../gantryClient.js'
import { credentialErrorResult, errorResult, okResult, upstreamErrorResult } from '../toolResult.js'

// Shared by every tool below — see instanceContent.tools.js (#58) for the pattern this copies.
// Resolves the instance's workspace id (for credential attachment) from whichever of slug/scope/ref
// the caller supplied. Returns `{ workspaceId, scope }` on success, or a tool result (already shaped
// for return) on failure — check `.errorResult` to tell the two apart.
async function resolveWorkspaceOrError({ slug, scope, ref }, { gantryClient }) {
  if (!slug && !ref) {
    return { errorResult: errorResult('Provide "slug" or "ref" to identify the instance.') }
  }
  const res = await resolveInstanceWorkspace({ gantryClient, slug, scope, ref })
  if (!res.ok) return { errorResult: upstreamErrorResult(res) }
  return { workspaceId: res.body?.workspaceId, scope: res.body?.scope }
}

const slugRefShape = {
  slug: z.string().optional().describe('The instance slug. Provide this or "ref".'),
  scope: z.string().optional().describe('The opaque workspace-scope token GET /api/instance/workspace or a prior instance lookup returned. Pins the lookup to one workspace when a bare slug is ambiguous.'),
  ref: z.string().optional().describe('The instance\'s numeric reference (e.g. "w1i2"), as an alternative to "slug".'),
}

// ---------------------------------------------------------------------------
// link_work_item
// ---------------------------------------------------------------------------

async function linkWorkItem(args, { gantryClient }) {
  const { slug, scope, ref, provider, organization, project, parentId, workItemType, owner, repository, parentNumber, namespace, parentIid, baseUrl } = args

  const resolved = await resolveWorkspaceOrError({ slug, scope, ref }, { gantryClient })
  if (resolved.errorResult) return resolved.errorResult

  let body
  if (provider === 'github') {
    const missing = ['owner', 'repository', 'parentNumber'].filter((key) => args[key] === undefined)
    if (missing.length) return errorResult(`Missing required field(s) for provider "github": ${missing.join(', ')}`)
    body = { provider: 'github', owner, repository, parentNumber, ...(baseUrl !== undefined ? { baseUrl } : {}) }
  } else if (provider === 'gitlab') {
    const missing = ['namespace', 'repository', 'parentIid'].filter((key) => args[key] === undefined)
    if (missing.length) return errorResult(`Missing required field(s) for provider "gitlab": ${missing.join(', ')}`)
    body = { provider: 'gitlab', namespace, repository, parentIid, ...(baseUrl !== undefined ? { baseUrl } : {}) }
  } else {
    // Default (omitted or explicit "azure-devops"): Azure DevOps, matching gantry serve's own default.
    const missing = ['organization', 'project', 'parentId'].filter((key) => args[key] === undefined)
    if (missing.length) return errorResult(`Missing required field(s) for provider "azure-devops": ${missing.join(', ')}`)
    body = { organization, project, parentId, ...(workItemType !== undefined ? { workItemType } : {}), ...(baseUrl !== undefined ? { baseUrl } : {}) }
  }

  const res = await gantryClient.request({
    workspaceId: resolved.workspaceId,
    path: '/api/instance/work-items/link',
    method: 'POST',
    query: { slug, scope: scope ?? resolved.scope, ref },
    body,
  })
  if (res.credentialError) return credentialErrorResult(res.credentialError)
  if (!res.ok) return upstreamErrorResult(res)
  return okResult(res.body)
}

// ---------------------------------------------------------------------------
// tag_work_item
// ---------------------------------------------------------------------------

async function tagWorkItem(args, { gantryClient }) {
  const { slug, scope, ref } = args
  const resolved = await resolveWorkspaceOrError({ slug, scope, ref }, { gantryClient })
  if (resolved.errorResult) return resolved.errorResult

  const res = await gantryClient.request({
    workspaceId: resolved.workspaceId,
    path: '/api/instance/work-items/tag',
    method: 'POST',
    query: { slug, scope: scope ?? resolved.scope, ref },
  })
  if (res.credentialError) return credentialErrorResult(res.credentialError)
  if (!res.ok) return upstreamErrorResult(res)
  return okResult(res.body)
}

// ---------------------------------------------------------------------------
// sync_work_item
// ---------------------------------------------------------------------------

async function syncWorkItem(args, { gantryClient }) {
  const { slug, scope, ref, gate } = args
  const resolved = await resolveWorkspaceOrError({ slug, scope, ref }, { gantryClient })
  if (resolved.errorResult) return resolved.errorResult

  const res = await gantryClient.request({
    workspaceId: resolved.workspaceId,
    path: '/api/instance/work-items/sync',
    method: 'POST',
    query: { slug, scope: scope ?? resolved.scope, ref },
    body: gate !== undefined ? { gate } : {},
  })
  if (res.credentialError) return credentialErrorResult(res.credentialError)
  if (!res.ok) return upstreamErrorResult(res)
  return okResult(res.body)
}

// ---------------------------------------------------------------------------
// set_assignee
// ---------------------------------------------------------------------------

async function setAssignee(args, { gantryClient }) {
  const { slug, scope, ref, assignee } = args
  if (typeof assignee !== 'string') {
    return errorResult('Provide "assignee" (a string; pass "" to clear it).')
  }
  const resolved = await resolveWorkspaceOrError({ slug, scope, ref }, { gantryClient })
  if (resolved.errorResult) return resolved.errorResult

  const res = await gantryClient.request({
    workspaceId: resolved.workspaceId,
    path: '/api/instance/assignee',
    method: 'PUT',
    query: { slug, scope: scope ?? resolved.scope, ref },
    body: { assignee },
  })
  if (res.credentialError) return credentialErrorResult(res.credentialError)
  if (!res.ok) return upstreamErrorResult(res)
  return okResult(res.body)
}

// ---------------------------------------------------------------------------
// list_commits
// ---------------------------------------------------------------------------

async function listCommits(args, { gantryClient }) {
  const { slug, scope, ref, stage } = args
  const resolved = await resolveWorkspaceOrError({ slug, scope, ref }, { gantryClient })
  if (resolved.errorResult) return resolved.errorResult

  const res = await gantryClient.request({
    workspaceId: resolved.workspaceId,
    path: '/api/instance/commits',
    query: { slug, scope: scope ?? resolved.scope, ref, stage },
  })
  if (res.credentialError) return credentialErrorResult(res.credentialError)
  if (!res.ok) return upstreamErrorResult(res)
  return okResult(res.body)
}

// ---------------------------------------------------------------------------
// list_assets
// ---------------------------------------------------------------------------

async function listAssets(args, { gantryClient }) {
  const { slug, scope, ref, stage } = args
  const resolved = await resolveWorkspaceOrError({ slug, scope, ref }, { gantryClient })
  if (resolved.errorResult) return resolved.errorResult

  const res = await gantryClient.request({
    workspaceId: resolved.workspaceId,
    path: '/api/instance/assets',
    query: { slug, scope: scope ?? resolved.scope, ref, stage },
  })
  if (res.credentialError) return credentialErrorResult(res.credentialError)
  if (!res.ok) return upstreamErrorResult(res)
  if (!Array.isArray(res.body)) {
    return errorResult('gantry serve returned an unexpected shape listing assets', res.body)
  }
  return okResult({ assets: res.body })
}

// ---------------------------------------------------------------------------
// upload_asset
// ---------------------------------------------------------------------------

// NOTE on the wire shape: unlike the ticket's working assumption, `POST /api/instance/assets`
// (lib/server.js, ~line 5466) does NOT take a raw binary body — every branch (local, GitHub-backed,
// GitLab-backed) parses a JSON body `{ filename, dataBase64, name?, source?, uploadedBy? }`, decoding
// `dataBase64` itself server-side (`Buffer.from(body.dataBase64 ?? '', 'base64')`). So no change to
// gantryClient.request was needed — this still goes through the ordinary JSON `body` path every other
// tool uses. We still decode the caller's base64 input with `Buffer.from(..., 'base64')` first and
// re-encode it before sending, both to validate it's well-formed base64 (a malformed string fails
// loudly here rather than as a confusing upstream error) and to normalize it (e.g. strip whitespace/
// data-URL prefixes a caller might have pasted in). Azure-DevOps-backed instances reject this route
// entirely (400, "not supported for Workspace-backed instances") — that 400 surfaces unchanged via
// upstreamErrorResult, exactly like any other 4xx.
async function uploadAsset(args, { gantryClient }) {
  const { slug, scope, ref, filename, contentBase64, name, source, uploadedBy } = args
  if (!filename) {
    return errorResult('Provide "filename" for the asset being uploaded.')
  }
  if (!contentBase64) {
    return errorResult('Provide "contentBase64" — the asset\'s bytes, base64-encoded.')
  }

  let dataBase64
  try {
    const cleaned = contentBase64.replace(/^data:[^;]+;base64,/, '')
    dataBase64 = Buffer.from(cleaned, 'base64').toString('base64')
  } catch {
    return errorResult('"contentBase64" is not valid base64.')
  }

  const resolved = await resolveWorkspaceOrError({ slug, scope, ref }, { gantryClient })
  if (resolved.errorResult) return resolved.errorResult

  const res = await gantryClient.request({
    workspaceId: resolved.workspaceId,
    path: '/api/instance/assets',
    method: 'POST',
    query: { slug, scope: scope ?? resolved.scope, ref },
    body: { filename, dataBase64, ...(name !== undefined ? { name } : {}), ...(source !== undefined ? { source } : {}), ...(uploadedBy !== undefined ? { uploadedBy } : {}) },
  })
  if (res.credentialError) return credentialErrorResult(res.credentialError)
  if (!res.ok) return upstreamErrorResult(res)
  return okResult(res.body)
}

export const tools = [
  {
    name: 'link_work_item',
    description:
      '1. Links an instance to a parent work item/issue, auto-creating one child per stage in its definition underneath it. ' +
      '2. Identify the instance with "slug" (optionally narrowed with "scope") or with "ref". ' +
      '3. "provider" selects which system the *parent work item* lives on — independent of, and not required to match, wherever the instance\'s own module data is stored. Omitted/"azure-devops" needs organization/project/parentId (workItemType optional, defaults to "Task"); "github" needs owner/repository/parentNumber (an existing issue); "gitlab" needs namespace/repository/parentIid (an existing issue). ' +
      '4. baseUrl overrides the provider\'s base URL for self-hosted servers — most deployments reject this (400) unless an administrator has allow-listed it. ' +
      '5. Fails 409 if the instance is already linked.',
    inputSchema: {
      ...slugRefShape,
      provider: z.enum(['azure-devops', 'github', 'gitlab']).optional().describe('Which system the parent work item/issue lives on. Defaults to azure-devops.'),
      organization: z.string().optional().describe('Azure DevOps only: the organization name.'),
      project: z.string().optional().describe('Azure DevOps only: the project name.'),
      parentId: z.number().int().optional().describe('Azure DevOps only: the parent work item id.'),
      workItemType: z.string().optional().describe('Azure DevOps only: the child work item type to create per stage. Defaults to "Task".'),
      owner: z.string().optional().describe('GitHub only: the repository owner (user or org).'),
      repository: z.string().optional().describe('GitHub/GitLab: the repository name.'),
      parentNumber: z.number().int().optional().describe('GitHub only: the existing parent issue number.'),
      namespace: z.string().optional().describe('GitLab only: the full group/subgroup path.'),
      parentIid: z.number().int().optional().describe('GitLab only: the existing parent issue iid.'),
      baseUrl: z.string().optional().describe('Self-hosted base URL override. Most servers reject this (400) unless allow-listed.'),
    },
    handler: linkWorkItem,
  },
  {
    name: 'tag_work_item',
    description:
      '1. Repairs tags on the stage work items already linked to this instance, using the persisted child work item ids (not the parent\'s hierarchy) to define scope — an operator\'s other board items are untouched. ' +
      '2. Identify the instance with "slug" (optionally narrowed with "scope") or with "ref". ' +
      '3. Requires the instance to already be linked via link_work_item.',
    inputSchema: { ...slugRefShape },
    handler: tagWorkItem,
  },
  {
    name: 'sync_work_item',
    description:
      "1. Re-checks the current stage's gate server-side and, only if it genuinely passes, pushes the new state to that stage's linked work item — the confirmed half of Gantry's read-write work-item sync. " +
      '2. Identify the instance with "slug" (optionally narrowed with "scope") or with "ref". ' +
      '3. "gate" (optional) targets a specific gate; omitted uses the instance\'s current stage gate. ' +
      '4. Call this only after the operator has already confirmed the sync — it is a real write to the linked work item once the gate check passes.',
    inputSchema: {
      ...slugRefShape,
      gate: z.string().optional().describe('A specific gate id to sync; omitted uses the instance\'s current stage.'),
    },
    handler: syncWorkItem,
  },
  {
    name: 'set_assignee',
    description:
      '1. Updates an instance\'s stored assignee — the instance detail view\'s own "assignee" field, distinct from a module\'s "owner" (Design Authority sign-off). ' +
      '2. Identify the instance with "slug" (optionally narrowed with "scope") or with "ref"; "assignee" is required (pass "" to clear it). ' +
      '3. The written value is reflected on the very next get_instance call for the same instance.',
    inputSchema: {
      ...slugRefShape,
      assignee: z.string().describe('The assignee to set; pass "" to clear it.'),
    },
    handler: setAssignee,
  },
  {
    name: 'list_commits',
    description:
      '1. Reads a Workspace-backed instance\'s stage-branch commit history — commits on the stage branch relative to main, before a Pull Request exists. ' +
      '2. Identify the instance with "slug" (optionally narrowed with "scope") or with "ref". ' +
      '3. Pass "stage" (a stage id) to read a stage other than the instance\'s current one. ' +
      '4. Fails with a 400 ("not Workspace-backed") for a local instance — there is no stage branch to read commits from.',
    inputSchema: {
      ...slugRefShape,
      stage: z.string().optional().describe('A stage id to read commits for instead of the instance\'s current stage.'),
    },
    handler: listCommits,
  },
  {
    name: 'list_assets',
    description:
      '1. Lists an instance\'s uploaded/committed assets for the current (or browsed) stage. ' +
      '2. Identify the instance with "slug" (optionally narrowed with "scope") or with "ref"; "stage" (optional) browses a stage other than the current one — Workspace-backed only, a no-op for GitHub/GitLab-backed instances today. ' +
      '3. Each entry carries at least id/filename/name; upload_asset\'s response for the same instance is reflected here on the next call.',
    inputSchema: {
      ...slugRefShape,
      stage: z.string().optional().describe('A stage id to browse instead of the instance\'s current stage. Workspace-backed (Azure DevOps) only.'),
    },
    handler: listAssets,
  },
  {
    name: 'upload_asset',
    description:
      '1. Uploads a new asset (e.g. an image referenced by a module) to an instance. ' +
      '2. Identify the instance with "slug" (optionally narrowed with "scope") or with "ref"; "filename" and "contentBase64" (the file\'s bytes, base64-encoded) are required. ' +
      '3. Only .png/.jpg/.jpeg are accepted by gantry serve today; any other extension is rejected with a 400. ' +
      '4. "name"/"source"/"uploadedBy" are optional metadata; omitted, gantry serve defaults name to the filename. ' +
      '5. Rejected with a 400 for an Azure-DevOps-backed (Workspace-backed) instance — commit the file to gantry-workspace/<slug>/assets/ in that repo directly instead. ' +
      '6. The uploaded asset is reflected on the very next list_assets call for the same instance.',
    inputSchema: {
      ...slugRefShape,
      filename: z.string().min(1).describe('The asset\'s filename (single segment, no slashes) — must end .png, .jpg, or .jpeg.'),
      contentBase64: z.string().min(1).describe('The asset\'s raw bytes, base64-encoded. A "data:...;base64," prefix is stripped if present.'),
      name: z.string().optional().describe('Display name; defaults to the filename.'),
      source: z.string().optional().describe('Optional free-text source/attribution.'),
      uploadedBy: z.string().optional().describe('Optional uploader name.'),
    },
    handler: uploadAsset,
  },
]
