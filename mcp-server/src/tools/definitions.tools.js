import { z } from 'zod'
import { credentialErrorResult, errorResult, okResult, upstreamErrorResult } from '../toolResult.js'

// Design decision (documented in the PR body, ticket #62's scope note): `get_definition`,
// `update_definition`, `create_draft_version` and `publish_definition_version` all take an optional
// `workspaceId`. Omitted, they hit the credential-free library/server-workspace route family
// (`/api/definitions/:id/...`) — the same family `list_definitions` reads. Supplied, they hit the
// parallel Provider-backed route family (`/api/workspaces/:workspaceId/definitions/:id/...`),
// resolving that workspace's PAT via gantryClient's normal `workspaceId` credential resolution.
// `validate_definition` is a stateless structural check with no disk/workspace involved at all
// (`findDefinitionProblemsInStructure` on the posted body — id/version are only path segments the
// route happens to require, never looked up), so it never touches `workspaceId`. `promote_definition`
// only exists for a *server-workspace* definition (a library or Provider-backed-workspace row has
// nothing to promote from — see lib/server.js's own doc comment on `promoteMatch`); the server
// resolves that itself from the id, so this tool never takes `workspaceId` either. Listing definitions
// inside a Provider-backed workspace (`GET /api/workspaces/:workspaceId/definitions`) is out of scope
// here — call that out as a follow-up if it's ever needed; `list_definitions` only merges the library
// with server-directory workspaces, per the ticket's own scope note.

function definitionPath(id, version, { workspaceId, suffix = '' } = {}) {
  const encodedId = encodeURIComponent(id)
  const base = workspaceId
    ? `/api/workspaces/${encodeURIComponent(workspaceId)}/definitions/${encodedId}`
    : `/api/definitions/${encodedId}`
  return version === undefined ? `${base}${suffix}` : `${base}/versions/${encodeURIComponent(String(version))}${suffix}`
}

async function listDefinitions({ includeArchived, includeWorkspaces }, { gantryClient }) {
  const res = await gantryClient.request({
    path: '/api/definitions',
    query: {
      archived: includeArchived ? '1' : undefined,
      includeWorkspaces: includeWorkspaces ? '1' : undefined,
    },
  })
  if (!res.ok) return upstreamErrorResult(res)
  if (!Array.isArray(res.body)) {
    return errorResult('gantry serve returned an unexpected shape listing definitions', res.body)
  }
  return okResult({ definitions: res.body })
}

async function getDefinition({ id, version, workspaceId }, { gantryClient }) {
  const res = await gantryClient.request({ workspaceId, path: definitionPath(id, version, { workspaceId }) })
  if (res.credentialError) return credentialErrorResult(res.credentialError)
  if (!res.ok) return upstreamErrorResult(res)
  return okResult(res.body)
}

async function updateDefinition({ id, version, workspaceId, stages, artefacts, modules }, { gantryClient }) {
  const res = await gantryClient.request({
    workspaceId,
    path: definitionPath(id, version, { workspaceId }),
    method: 'PUT',
    body: { stages, artefacts, modules },
  })
  if (res.credentialError) return credentialErrorResult(res.credentialError)
  if (!res.ok) return upstreamErrorResult(res)
  return okResult(res.body)
}

async function createDraftVersion({ id, workspaceId }, { gantryClient }) {
  const res = await gantryClient.request({
    workspaceId,
    path: `${definitionPath(id, undefined, { workspaceId })}/versions`,
    method: 'POST',
  })
  if (res.credentialError) return credentialErrorResult(res.credentialError)
  if (!res.ok) return upstreamErrorResult(res)
  return okResult(res.body)
}

async function validateDefinition({ id, version, stages, artefacts, modules }, { gantryClient }) {
  const res = await gantryClient.request({
    path: definitionPath(id, version, { suffix: '/validate' }),
    method: 'POST',
    body: { stages: stages ?? [], artefacts: artefacts ?? [], modules: modules ?? [] },
  })
  if (!res.ok) return upstreamErrorResult(res)
  return okResult(res.body)
}

async function publishDefinitionVersion({ id, version, workspaceId }, { gantryClient }) {
  const res = await gantryClient.request({
    workspaceId,
    path: definitionPath(id, version, { workspaceId, suffix: '/publish' }),
    method: 'POST',
  })
  if (res.credentialError) return credentialErrorResult(res.credentialError)
  if (!res.ok) return upstreamErrorResult(res)
  return okResult(res.body)
}

async function promoteDefinition({ id, version, repoIds }, { gantryClient }) {
  const res = await gantryClient.request({
    path: definitionPath(id, version, { suffix: '/promote' }),
    method: 'POST',
    body: { repoIds },
  })
  if (!res.ok) return upstreamErrorResult(res)
  return okResult(res.body)
}

const workspaceIdField = z
  .string()
  .optional()
  .describe(
    'Optional. Omit to target the server library / a server-directory workspace\'s own definitions. Supply a Provider-backed workspace id (from list_workspaces) to target that workspace\'s own definitions instead — its PAT is resolved from GANTRY_WORKSPACE_PATS automatically.'
  )

const versionField = z.number().int().positive().describe('The definition version number (from list_definitions / get_definition, e.g. 1, 2, 3).')

const documentShape = {
  stages: z.array(z.record(z.string(), z.unknown())).describe('Every stage in the document, whole-document — not a partial patch.'),
  artefacts: z.array(z.record(z.string(), z.unknown())).describe('Every artefact in the document, whole-document — not a partial patch.'),
  modules: z.array(z.record(z.string(), z.unknown())).describe('Every module in the document, whole-document — not a partial patch.'),
}

export const tools = [
  {
    name: 'list_definitions',
    description:
      '1. Lists every definition in the server library, merged with each server-directory workspace\'s own definitions (each row tagged "home"). ' +
      '2. Pass includeWorkspaces: true to include server-directory workspace rows; omitted, only the library is listed. ' +
      '3. Pass includeArchived: true to also include archived definitions. ' +
      '4. A Provider-backed workspace\'s own definitions are not included here — list_workspaces + a future dedicated tool covers that. ' +
      '5. Use a result\'s "id" and a "versions" entry\'s "version" with get_definition / update_definition / etc.',
    inputSchema: {
      includeArchived: z.boolean().optional().describe('Include archived definitions (default false).'),
      includeWorkspaces: z.boolean().optional().describe('Include server-directory workspaces\' own definitions, each tagged with its "home" (default false: library only).'),
    },
    handler: listDefinitions,
  },
  {
    name: 'get_definition',
    description:
      '1. Returns one definition version\'s full document — the same structure the visual editor reads: id, title, description, version, status, stages, artefacts, modules. ' +
      '2. id and version come from list_definitions. ' +
      '3. Pass workspaceId to read from a Provider-backed workspace\'s own definitions instead of the server library/server-directory workspaces.',
    inputSchema: {
      id: z.string().describe('The definition id.'),
      version: versionField,
      workspaceId: workspaceIdField,
    },
    handler: getDefinition,
  },
  {
    name: 'update_definition',
    description:
      '1. Overwrites a draft version\'s entire document (stages, artefacts, modules) in one whole-document write — never a partial patch. ' +
      '2. The document is validated against the same structural rules the editor\'s toolbar uses before anything is written: a duplicate id, a stage/artefact referencing a module that does not exist, an unknown field type, or both "required" and "required-at" set on one field. ' +
      '3. A structurally invalid document is rejected with the same problem list the editor would show (isError, with a "problems" array) — nothing is written. ' +
      '4. Only a draft version can be updated; a published version is immutable and this returns an error. ' +
      '5. Pass workspaceId to write into a Provider-backed workspace\'s own definitions instead of the server library/server-directory workspaces.',
    inputSchema: {
      id: z.string().describe('The definition id.'),
      version: versionField,
      workspaceId: workspaceIdField,
      ...documentShape,
    },
    handler: updateDefinition,
  },
  {
    name: 'create_draft_version',
    description:
      '1. Creates a new editable draft version of a definition, copied from its current state — the currently published version, if there is one, is never touched. ' +
      '2. Returns the new version\'s number; use it with get_definition / update_definition / validate_definition / publish_definition_version. ' +
      '3. Fails if the definition is archived, or is sourced from a configured library repo (those are read-only mirrors, never edited directly). ' +
      '4. Pass workspaceId to create the draft inside a Provider-backed workspace\'s own definitions instead of the server library/server-directory workspaces.',
    inputSchema: {
      id: z.string().describe('The definition id.'),
      workspaceId: workspaceIdField,
    },
    handler: createDraftVersion,
  },
  {
    name: 'validate_definition',
    description:
      '1. Runs the same structural checks update_definition/publish_definition_version enforce against a document you pass in directly — no disk read, no write, nothing persisted. ' +
      '2. Returns "problems": [] when the document is structurally sound, otherwise a list of { type, message } problems (duplicate ids, missing module/field references, unknown field types, mutually-exclusive required/required-at). ' +
      '3. Use this to check a document before calling update_definition, or to explain exactly what is wrong with one. ' +
      '4. id and version are only path placeholders here (no credential, no workspaceId, no lookup against a real definition) — any definition\'s id/version already known to you is fine.',
    inputSchema: {
      id: z.string().describe('A definition id (only used to shape the request path; not looked up).'),
      version: versionField,
      ...documentShape,
    },
    handler: validateDefinition,
  },
  {
    name: 'publish_definition_version',
    description:
      '1. Makes a draft version the live, published version of its definition. ' +
      '2. Rejects (isError, with a "problems" array) a structurally invalid draft — nothing is published. ' +
      '3. Fails with a 409-style error if the version is not currently a draft (already published). ' +
      '4. A published version is thereafter immutable — update_definition will refuse it; use create_draft_version to make further changes. ' +
      '5. Pass workspaceId to publish inside a Provider-backed workspace\'s own definitions instead of the server library/server-directory workspaces.',
    inputSchema: {
      id: z.string().describe('The definition id.'),
      version: versionField,
      workspaceId: workspaceIdField,
    },
    handler: publishDefinitionVersion,
  },
  {
    name: 'promote_definition',
    description:
      '1. Opens one Pull Request per selected library repo, promoting a published server-directory-workspace definition version into that repo — never a direct write. ' +
      '2. repoIds come from the library repos list (id of each configured repo); pass every repo you want a PR opened against, in one call. ' +
      '3. Only available for a published version of a definition that lives in a server-directory workspace (not the library itself, and not a Provider-backed workspace or Azure DevOps/GitHub/GitLab workspace definition, which this route does not reach). ' +
      '4. One repo\'s failure never stops another\'s — the response reports every repo\'s own outcome ("results"), and every successful PR is persisted immediately ("promotions"). ' +
      '5. Calling this again for a repo that already has an open promotion opens another PR; check "promotions" first if you only want one per repo.',
    inputSchema: {
      id: z.string().describe('The definition id (must live in a server-directory workspace).'),
      version: versionField,
      repoIds: z.array(z.string()).min(1).describe('The configured library repo ids to open a Pull Request against, from GET /api/library-repos.'),
    },
    handler: promoteDefinition,
  },
]
