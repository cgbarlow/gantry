import { z } from 'zod'
import { errorResult, okResult, credentialErrorResult, upstreamErrorResult } from '../toolResult.js'

// The location fields each Provider requires (mirrors lib/provider.js's own LOCATION_SCHEMA — only
// the three providers `GET /api/<provider>/repo-check` and `POST /api/workspaces` actually support a
// repo-check/creation flow for today; gitlab has a repo-check route but POST /api/workspaces below
// gates its own baseUrl override the same way, atlassian needs a second token and is out of scope
// for this tool cluster).
const REQUIRED_LOCATION_FIELDS = {
  'azure-devops': ['organization', 'project', 'repository'],
  github: ['repoOwner', 'repository'],
  gitlab: ['namespace', 'repository'],
}

function missingFieldsFor(provider, args) {
  return (REQUIRED_LOCATION_FIELDS[provider] ?? []).filter((field) => !args[field])
}

// Builds the `location` shape each provider's route actually expects on the wire — `repoOwner` (our
// own input name, chosen so it never collides with the top-level workspace "Owner" person `owner`
// carries in create_workspace) becomes GitHub's `owner`.
function buildLocation(provider, args) {
  if (provider === 'azure-devops') {
    return { organization: args.organization, project: args.project, repository: args.repository, ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}) }
  }
  if (provider === 'github') {
    return { owner: args.repoOwner, repository: args.repository, ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}) }
  }
  if (provider === 'gitlab') {
    return { namespace: args.namespace, repository: args.repository, ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}) }
  }
  return {}
}

const PROVIDER_FIELDS_SCHEMA = {
  organization: z.string().optional().describe('Azure DevOps only: the organization name.'),
  project: z.string().optional().describe('Azure DevOps only: the project name.'),
  repository: z.string().optional().describe('The repository name (all three providers).'),
  repoOwner: z.string().optional().describe('GitHub only: the owner (user or org) of the repository — distinct from create_workspace\'s own "owner" (the workspace\'s Owner person).'),
  namespace: z.string().optional().describe('GitLab only: the full group/subgroup path, as one opaque string.'),
  baseUrl: z.string().optional().describe('Self-hosted base URL override. Most servers reject this (400) unless an administrator has explicitly allow-listed it.'),
}

// 1. check_repo — a live repo-check against the caller-supplied PAT, with nothing created or persisted.
async function checkRepo(args, { gantryClient }) {
  const { provider, pat } = args
  const missing = missingFieldsFor(provider, args)
  if (missing.length > 0) {
    return errorResult(`Missing required field(s) for provider "${provider}": ${missing.join(', ')}`)
  }

  const query =
    provider === 'azure-devops'
      ? { organization: args.organization, project: args.project, repository: args.repository, ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}) }
      : provider === 'github'
        ? { owner: args.repoOwner, repository: args.repository, ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}) }
        : { namespace: args.namespace, repository: args.repository, ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}) }

  const res = await gantryClient.request({ path: `/api/${provider}/repo-check`, query, patOverride: pat })
  if (!res.ok) return upstreamErrorResult(res)
  return okResult(res.body)
}

// 2. create_workspace — Provider-backed (proves the PAT via a real repo-check, then registers) or
// server-directory (describes gantry serve's one implicit local workspace — see this file's own note
// below on why that half doesn't register anything new).
async function createWorkspace(args, { gantryClient }) {
  const { provider } = args

  if (provider) {
    const missing = missingFieldsFor(provider, args)
    if (missing.length > 0) {
      return errorResult(`Missing required field(s) for provider "${provider}": ${missing.join(', ')}`)
    }
    if (!args.pat) {
      return errorResult('pat is required to create a Provider-backed workspace (it proves access to the location before anything is registered).')
    }

    const location = buildLocation(provider, args)
    const body = { provider, location, ...(args.owner ? { owner: args.owner } : {}) }
    const res = await gantryClient.request({ path: '/api/workspaces', method: 'POST', body, patOverride: args.pat })
    if (!res.ok) return upstreamErrorResult(res)
    return okResult(res.body)
  }

  // Server-directory: gantry serve does not (yet) expose a route to register a brand-new,
  // caller-named directory workspace — `lib/workspaceDirectory.js`'s own doc comment marks that
  // primitive "additive only ... no route ... consults it", and the only place a directory workspace
  // is ever provisioned over HTTP is create_instance's own local-instance path, which always lands in
  // the one fixed "default" workspace. So this branch never registers anything new — it looks up
  // (and reports) that implicit workspace instead of pretending to create an arbitrary one.
  const id = args.serverWorkspaceId || 'default'
  const listRes = await gantryClient.request({ path: '/api/server-workspaces' })
  if (!listRes.ok) return upstreamErrorResult(listRes)
  const found = Array.isArray(listRes.body) ? listRes.body.find((w) => w.id === id) : undefined
  if (found) return okResult({ ...found, kind: 'server-directory' })

  return errorResult(
    'no_server_directory_workspace',
    `gantry serve has no route to create a new server-directory workspace directly. The "${id}" workspace is created implicitly the first time create_instance makes a local instance (one with no Provider-backed workspaceId). Call create_instance first, then this workspace will exist.`
  )
}

// 3. create_instance — the first instance in a workspace. Looks the workspace up (provider-backed vs
// server-directory, and — for provider-backed — its location) itself, since POST /api/instances needs
// that location inlined in the body; the credential itself is still resolved the normal way, via
// `workspaceId` on the actual create call, so a missing/rejected PAT is reported the same structured
// way every other tool in this server reports it.
async function createInstance(args, { gantryClient }) {
  const { workspaceId, definition, slug, owner, assignee, definitionVersion } = args

  const [providerRes, serverRes] = await Promise.all([
    gantryClient.request({ path: '/api/workspaces', query: { archived: '1' } }),
    gantryClient.request({ path: '/api/server-workspaces' }),
  ])
  if (!providerRes.ok) return upstreamErrorResult(providerRes)
  if (!serverRes.ok) return upstreamErrorResult(serverRes)

  const providerWorkspace = (Array.isArray(providerRes.body) ? providerRes.body : []).find((w) => w.id === workspaceId)
  const serverWorkspace = (Array.isArray(serverRes.body) ? serverRes.body : []).find((w) => w.id === workspaceId)

  if (!providerWorkspace && !serverWorkspace) {
    return credentialErrorResult({
      error: 'workspace_not_found',
      workspace: workspaceId,
      message: `No workspace "${workspaceId}" was found (checked both Provider-backed and server-directory workspaces).`,
    })
  }

  const body = { definition, slug, ...(owner !== undefined ? { owner } : {}), ...(assignee !== undefined ? { assignee } : {}), ...(definitionVersion !== undefined ? { definitionVersion } : {}) }

  if (providerWorkspace) {
    const { provider, location } = providerWorkspace
    if (provider === 'azure-devops') {
      body.azureDevOps = { organization: location.organization, project: location.project, repository: location.repository, ...(location.baseUrl ? { baseUrl: location.baseUrl } : {}) }
    } else if (provider === 'github') {
      body.github = { owner: location.owner, repository: location.repository, ...(location.baseUrl ? { baseUrl: location.baseUrl } : {}) }
    } else {
      return errorResult(`Creating an instance in a "${provider}" workspace is not supported by gantry serve yet.`)
    }
  }
  // else: server-directory workspace — no azureDevOps/github field, the local-instance branch.

  const res = await gantryClient.request({ workspaceId, path: '/api/instances', method: 'POST', body })
  if (res.credentialError) return credentialErrorResult(res.credentialError)
  if (!res.ok) return upstreamErrorResult(res)
  return okResult(res.body)
}

// 4/5. archive_workspace / restore_workspace — both routes are credential-free server-side (archived-
// ness is registry metadata, never used to prove Provider access — lib/server.js's own comment on
// `POST /api/workspace/archive`), so `workspaceId` is only ever passed in the body, never as the
// gantryClient `workspaceId` option — that option triggers PAT resolution, which would wrongly block
// archiving a Provider-backed workspace whose operator simply hasn't configured a PAT for it yet, even
// though archiving never actually needs one.
async function archiveWorkspace({ workspaceId }, { gantryClient }) {
  const res = await gantryClient.request({ path: '/api/workspace/archive', method: 'POST', body: { workspaceId } })
  if (!res.ok) return upstreamErrorResult(res)
  return okResult(res.body)
}

async function restoreWorkspace({ workspaceId }, { gantryClient }) {
  const res = await gantryClient.request({ path: '/api/workspace/restore', method: 'POST', body: { workspaceId } })
  if (!res.ok) return upstreamErrorResult(res)
  return okResult(res.body)
}

export const tools = [
  {
    name: 'check_repo',
    description:
      '1. Checks a specific Azure DevOps, GitHub, or GitLab repo location against a caller-supplied PAT, before any workspace exists. ' +
      '2. Creates and persists nothing — a read-only proof of access and a report of whether instance data ("found"/"multiple"/"empty") already lives there. ' +
      '3. Pass provider plus that provider\'s own location fields: azure-devops needs organization/project/repository, github needs repoOwner/repository, gitlab needs namespace/repository. ' +
      '4. Use this before create_workspace to confirm a PAT and location actually work together.',
    inputSchema: {
      provider: z.enum(['azure-devops', 'github', 'gitlab']).describe('Which provider this location lives on.'),
      pat: z.string().min(1).describe('The Personal Access Token to check with. Never stored — used for this one call only.'),
      ...PROVIDER_FIELDS_SCHEMA,
    },
    handler: checkRepo,
  },
  {
    name: 'create_workspace',
    description:
      '1. Registers a new Provider-backed workspace (Azure DevOps, GitHub, or GitLab), or looks up gantry serve\'s one implicit server-directory workspace. ' +
      '2. Provider-backed: pass provider, that provider\'s location fields (see check_repo), and pat — the PAT is proven against the exact location via a live repo-check before anything is registered; registering the same location twice reuses the existing workspace rather than duplicating it. ' +
      '3. Server-directory (no provider, no pat): gantry serve has no route to create a new named directory workspace directly, so this instead reports its one fixed "default" workspace if it already exists, or a clear message that it does not yet (create_instance\'s own local-instance path provisions it implicitly). ' +
      '4. owner (optional, Provider-backed only) records the workspace\'s Owner (a person) — distinct from repoOwner, the GitHub repo\'s own owner/org.',
    inputSchema: {
      provider: z.enum(['azure-devops', 'github', 'gitlab']).optional().describe('Omit for a server-directory workspace.'),
      pat: z.string().optional().describe('Required when provider is given.'),
      owner: z.string().optional().describe('Provider-backed only: the workspace\'s Owner (a person).'),
      serverWorkspaceId: z.string().optional().describe('Server-directory only: which one to look up (default "default", gantry serve\'s only one today).'),
      ...PROVIDER_FIELDS_SCHEMA,
    },
    handler: createWorkspace,
  },
  {
    name: 'create_instance',
    description:
      '1. Creates the first (or another) instance inside an existing workspace — pass workspaceId from a prior list_workspaces/create_workspace call. ' +
      '2. definition must be a known definition id; slug is the instance\'s own directory name (single path segment, no slashes). ' +
      '3. owner (optional) seeds each first-stage module\'s frontmatter owner; assignee (optional) sets the instance\'s stored assignee. definitionVersion (optional) pins a specific version — omitted defaults to latest published. ' +
      '4. A Provider-backed workspace\'s credential is resolved automatically the normal way — a missing/rejected PAT is reported as a "missing_workspace_pat"/"authentication_required" error, never guessed. ' +
      '5. Only azure-devops and github workspaces are supported for instance creation today; gitlab/atlassian workspaces are reported as not-yet-supported rather than silently creating a local instance in the wrong place.',
    inputSchema: {
      workspaceId: z.string().describe('An id from list_workspaces or create_workspace.'),
      definition: z.string().describe('A known definition id.'),
      slug: z.string().min(1).describe('The instance\'s directory name — a single path segment, no slashes.'),
      owner: z.string().optional(),
      assignee: z.string().optional(),
      definitionVersion: z.union([z.number(), z.string()]).optional().describe('An explicit version, or "latest" (the default when omitted).'),
    },
    handler: createInstance,
  },
  {
    name: 'archive_workspace',
    description:
      '1. Archives a workspace — removes it from the default dashboard listing only; nothing on disk or in the Provider is deleted or touched. ' +
      '2. Idempotent: archiving an already-archived workspace succeeds and reports its current state. ' +
      '3. Blocked with an error (not thrown — check the result) while the workspace still has any active (non-archived) instance; archive or restore those first. ' +
      '4. No credential is required — archived-ness is registry metadata, never used to prove Provider access.',
    inputSchema: {
      workspaceId: z.string().describe('An id from list_workspaces.'),
    },
    handler: archiveWorkspace,
  },
  {
    name: 'restore_workspace',
    description:
      '1. Restores a previously archived workspace back onto the default dashboard listing, exactly as it was before archiving. ' +
      '2. Idempotent: restoring a workspace that is not archived succeeds as a no-op. ' +
      '3. No credential is required, for the same reason archive_workspace needs none.',
    inputSchema: {
      workspaceId: z.string().describe('An id from list_workspaces.'),
    },
    handler: restoreWorkspace,
  },
]
