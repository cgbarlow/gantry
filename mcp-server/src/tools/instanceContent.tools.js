import { z } from 'zod'
import { resolveInstanceWorkspace } from '../gantryClient.js'
import { credentialErrorResult, errorResult, okResult, upstreamErrorResult } from '../toolResult.js'

// Shared by every tool below: resolves the instance's workspace id (for credential attachment) from
// whichever of slug/scope/ref the caller supplied. Returns `{ workspaceId, scope }` on success, or a
// tool result (already shaped for return) on failure — check `.errorResult` to tell the two apart.
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

async function listInstances({ includeArchived }, { gantryClient }) {
  const res = await gantryClient.request({
    path: '/api/instances',
    query: includeArchived ? { archived: '1' } : undefined,
  })
  if (!res.ok) return upstreamErrorResult(res)
  if (!Array.isArray(res.body)) {
    return errorResult('gantry serve returned an unexpected shape listing instances', res.body)
  }
  return okResult({ instances: res.body })
}

async function getInstance(args, { gantryClient }) {
  const { slug, scope, ref, stage, stageNumber } = args
  const resolved = await resolveWorkspaceOrError({ slug, scope, ref }, { gantryClient })
  if (resolved.errorResult) return resolved.errorResult

  const res = await gantryClient.request({
    workspaceId: resolved.workspaceId,
    path: '/api/instance',
    query: { slug, scope: scope ?? resolved.scope, ref, stage, stageNumber },
  })
  if (res.credentialError) return credentialErrorResult(res.credentialError)
  if (!res.ok) return upstreamErrorResult(res)
  return okResult(res.body)
}

async function updateInstanceModules(args, { gantryClient }) {
  const { slug, scope, ref, stage, modules } = args
  if (!modules || Object.keys(modules).length === 0) {
    return errorResult('Provide at least one entry in "modules" to save.')
  }
  const resolved = await resolveWorkspaceOrError({ slug, scope, ref }, { gantryClient })
  if (resolved.errorResult) return resolved.errorResult

  const res = await gantryClient.request({
    workspaceId: resolved.workspaceId,
    path: '/api/instance/modules',
    method: 'PUT',
    query: { slug, scope: scope ?? resolved.scope, ref, stage },
    body: { modules },
  })
  if (res.credentialError) return credentialErrorResult(res.credentialError)
  if (!res.ok) return upstreamErrorResult(res)
  return okResult(res.body)
}

async function renderArtefact(args, { gantryClient }) {
  const { slug, scope, ref, artefactId, format } = args
  if (!artefactId) {
    return errorResult('Provide "artefactId" — one of the ids get_instance\'s "artefacts" list returns for the current stage.')
  }
  const resolved = await resolveWorkspaceOrError({ slug, scope, ref }, { gantryClient })
  if (resolved.errorResult) return resolved.errorResult

  const res = await gantryClient.request({
    workspaceId: resolved.workspaceId,
    path: `/api/instance/render/${encodeURIComponent(artefactId)}`,
    method: 'POST',
    query: { slug, scope: scope ?? resolved.scope, ref, format },
  })
  if (res.credentialError) return credentialErrorResult(res.credentialError)
  if (!res.ok) return upstreamErrorResult(res)
  return okResult(res.body)
}

export const tools = [
  {
    name: 'list_instances',
    description:
      '1. Lists every instance this gantry serve instance knows about — both local/server-directory instances and Provider-backed ones, in one unified list. ' +
      '2. Each result carries a "workspace" field naming which workspace/kind it lives in. ' +
      '3. Pass includeArchived: true to also include archived instances (each then carries an "archived" boolean); omitted, archived instances are left out entirely. ' +
      '4. Use a result\'s "slug" (or "ref") to target that instance in every other instance-scoped tool.',
    inputSchema: {
      includeArchived: z.boolean().optional().describe('Include archived instances (default false).'),
    },
    handler: listInstances,
  },
  {
    name: 'get_instance',
    description:
      '1. Reads one instance\'s full module content for its current stage (the same shape the web editor reads) — definition, stage, every module\'s fields/values, available artefacts, and workflow state. ' +
      '2. Identify the instance with "slug" (optionally narrowed with "scope") or with "ref". ' +
      '3. Pass "stage" (a stage id) or "stageNumber" to browse a stage other than the instance\'s current one; omitted, this reads the instance\'s persisted current stage. ' +
      '4. A Provider-backed instance whose workspace has no PAT configured fails with "missing_workspace_pat" — report this to the operator, do not retry. ' +
      '5. Use the response\'s "artefacts" list to find valid artefactId values for render_artefact.',
    inputSchema: {
      ...slugRefShape,
      stage: z.string().optional().describe('A stage id to browse instead of the instance\'s current stage.'),
      stageNumber: z.number().int().positive().optional().describe('A 1-based stage number, as an alternative to "stage".'),
    },
    handler: getInstance,
  },
  {
    name: 'update_instance_modules',
    description:
      '1. Writes one or more modules\' content on an instance\'s current (or browsed) stage in a single save — the same "stage-level Save" the web editor uses; on a Provider-backed instance this is one commit. ' +
      '2. Identify the instance with "slug" (optionally narrowed with "scope") or with "ref". ' +
      '3. "modules" is required and must be non-empty: an object keyed by moduleId, each value a partial module record — { status?, owner?, fields?, layout? } — only the keys you supply are changed. ' +
      '4. Pass "stage" (a stage id) to target a stage other than the instance\'s current one; the definition must actually declare each moduleId on that stage, or gantry serve rejects the whole call with a 400. ' +
      '5. This never renders an artefact — call render_artefact separately once content is saved. ' +
      '6. The written content is reflected on the very next get_instance call for the same instance/stage.',
    inputSchema: {
      ...slugRefShape,
      stage: z.string().optional().describe('The stage id these modules belong to; omitted defaults to the instance\'s current stage.'),
      modules: z
        .record(z.string(), z.any())
        .describe('Object keyed by moduleId, each value a partial module record: { status?, owner?, fields?, layout? }.'),
    },
    handler: updateInstanceModules,
  },
  {
    name: 'render_artefact',
    description:
      "1. Renders one of an instance's stage-gate-matching artefacts (e.g. an HLD/SAD/SSAD/as-built document) from its currently-saved module content. " +
      '2. Identify the instance with "slug" (optionally narrowed with "scope") or with "ref"; "artefactId" is required — get it from get_instance\'s "artefacts" list for the stage you want. ' +
      '3. This renders the instance\'s *current* stage — there is no stage override, unlike get_instance/update_instance_modules. ' +
      '4. Pass format: "md" for the compiled markdown source, or omit/"docx" for the compiled Word document — a server-directory instance\'s docx comes back as base64 ("docxBase64"); a Provider-backed instance\'s render is pushed to that instance\'s own repo instead and this returns its path/URL there. ' +
      '5. This is a genuine, real write for a Provider-backed instance (it pushes a commit) — treat it as final once called.',
    inputSchema: {
      ...slugRefShape,
      artefactId: z.string().describe('The artefact id to render, from get_instance\'s "artefacts" list.'),
      format: z.enum(['md', 'docx']).optional().describe('Output format; defaults to "docx".'),
    },
    handler: renderArtefact,
  },
]
