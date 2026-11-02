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
  // #189: the listing above carries no credential, so it only has Provider-backed instances gantry
  // serve already knew about — merge in what a credentialed listing per configured PAT turns up.
  const discovered = await gantryClient.discoverProviderInstances({ includeArchived: Boolean(includeArchived), force: true })
  const key = (row) => row.ref ?? `${row.workspace?.id ?? ''}/${row.slug}`
  const instances = [...res.body]
  const seen = new Set(instances.map(key))
  for (const row of discovered) {
    if (seen.has(key(row))) continue
    seen.add(key(row))
    instances.push(row)
  }
  return okResult({ instances })
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
  // #305 (ADR-0067): the Fields that drew on a Source document that has since changed. The instance itself is the answer, so a failure
  // working this out is reported beside it ("outOfDateError") and never fails the read.
  let outOfDate
  try {
    outOfDate = await gantryClient.request({
      workspaceId: resolved.workspaceId,
      path: '/api/instance/out-of-date',
      query: { slug, scope: scope ?? resolved.scope, ref },
    })
  } catch (err) {
    return okResult({ ...res.body, outOfDateError: err.message })
  }
  if (outOfDate.ok && outOfDate.body && typeof outOfDate.body === 'object') {
    return okResult({ ...res.body, outOfDate: outOfDate.body })
  }
  const reason = outOfDate.credentialError?.message ?? outOfDate.body?.error ?? `gantry serve responded ${outOfDate.status}`
  return okResult({ ...res.body, outOfDateError: reason })
}

async function updateInstanceModules(args, { gantryClient }) {
  const { slug, scope, ref, stage, modules, stageVersion } = args
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
    body: stageVersion ? { modules, baseVersion: stageVersion } : { modules },
  })
  if (res.credentialError) return credentialErrorResult(res.credentialError)
  // ADR-0068 (#272): the stage moved on since get_instance returned this version. Nothing was written.
  // gantry serve's refusal also carries the whole saved stage ("current"), which an agent re-reads
  // through get_instance rather than from here, so it is left out and the Fields that differ are named.
  if (res.status === 409 && res.body?.code === 'stage_changed') {
    const differingFields = Array.isArray(res.body.differingFields) ? res.body.differingFields : []
    return errorResult(
      'The stage was changed after you read it, so nothing was saved. ' +
        (differingFields.length
          ? `These Fields in your call are saved differently now: ${differingFields.join(', ')}. `
          : 'None of the Fields in your call differ from what is saved, but others on the stage changed. ') +
        'Call get_instance again, read what changed with the architect, settle any difference with them, then save again with the new "stageVersion".',
      { code: 'stage_changed', stageVersion: res.body.stageVersion, differingFields }
    )
  }
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
      '5. Use the response\'s "artefacts" list to find valid artefactId values for render_artefact. ' +
      '6. When the instance\'s definition sets word budgets, the response carries the instance\'s Target size as "size" (small, medium or large; the definition\'s default size, else medium, when none was chosen) and each budgeted field carries "targetWords" — about how many words to write in that field for this instance. Write to that length: it is a target, not a limit, and the size is the instance owner\'s choice of how much detail reviewers want. ' +
      '7. When the instance\'s definition declares Instance settings, the response carries "instanceSettings": one entry per setting (id "size" or "classification") with its "choices", "default" and this instance\'s "value". The "classification" value is the marking printed on every document\'s cover and page header ("" for none); treat the content you write as handled at that marking. ' +
      '8. When the instance\'s definition has a logo in its documents\' page header, the response carries "instanceLogo": { own, source } — "own" is true when the instance has uploaded its own logo, which its rendered documents show ("source": "instance"); otherwise they show the definition\'s logo ("source": "definition"). A logo is uploaded in the web app\'s wizard or Instance Settings, not over MCP. ' +
      '9. The response carries "stageVersion", a fingerprint of the stage\'s Field content as read now. Pass it back to update_instance_modules as "stageVersion" so a save is refused, naming the Fields that differ, if a colleague changed the stage after you read it. ' +
      '10. The response carries "outOfDate": the Fields (across every stage) that drew on a Source document that has since been removed, replaced or read again with different text, that cite one with source:<id>, or that were drafted from another Field that has changed. "outOfDate.fields" has one entry per Field ({ field: "moduleId.fieldId", title, note, flags }), "summary" the one-line reasons, and "newSinceLastInterview" the documents added since the last interview that replace nothing. A Field listed there is not wrong, only unchecked: read the changed document (read_source_document), tell the architect what differs, and keep the Field or redraft it on their word. Nothing is stored for the flag; it clears once the Field is redrafted after the change. If it could not be worked out the response carries "outOfDateError" instead; a GitLab or Atlassian workspace keeps no Source documents and reports "supported": false.',
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
      '4a. A module the stage mounts read-only (its "read-only-modules" in the definition; get_instance marks it "readOnly" with its "homeStage") is carried forward from an earlier stage: gantry serve rejects the whole call with a 400 naming that home stage — write it there instead. ' +
      '5. This never renders an artefact — call render_artefact separately once content is saved. ' +
      '6. The written content is reflected on the very next get_instance call for the same instance/stage. ' +
      '7. When a field you wrote is over its word target (get_instance\'s "targetWords"), the save still succeeds and the response carries "targetWordNotes", one per such field (e.g. "nfrs.performance: 420 words, Medium target ~150") — tighten that field and save again. ' +
      '8. Pass "stageVersion", the value get_instance returned for this stage, to make sure you do not overwrite a colleague\'s changes. If the stage has changed since (the architect saved in the editor, or another session did), nothing is saved and the call fails with code "stage_changed", the stage\'s new "stageVersion" and "differingFields": the Fields in your call that are saved differently now, as "moduleId.fieldId". Call get_instance again, read what changed, settle any difference with the architect, then save again with the new version. A saved call returns the stage\'s new "stageVersion" to use next. ' +
      '9. Without "stageVersion" the call still saves, as it always did, but the response carries "overwrittenFields": every Field it overwrote, as "moduleId.fieldId" — those that held content and now hold something else. Tell the architect about any you were not meant to change. Passing the version is strongly preferred. ' +
      '10. Every write is checked Field by Field, the way Gantry checks its own AI\'s drafts, whether or not an interview session is running. The response carries "fieldNotes": one note per problem, each with "module", "field", "kind" and a "message" saying how to fix it — "options" (a select value that is not exactly one of the Field\'s options), "budget" (over the word target) and "figures" (a figure with no source: cite it as [title, p. 4](source:<id>) from a Source document, or mark it "(target assumption)" if you are proposing it; a figure the architect told you in the interview needs no mark, but it is noted here, so say so to the architect). An empty list means a clean write. Notes never block the save: fix the Field and save again.',
    inputSchema: {
      ...slugRefShape,
      stage: z.string().optional().describe('The stage id these modules belong to; omitted defaults to the instance\'s current stage.'),
      stageVersion: z.string().optional().describe('The "stageVersion" get_instance returned for this stage. When the stage has changed since, the save is refused and the Fields that differ are named. Omit it only if you accept overwriting whatever is saved.'),
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
