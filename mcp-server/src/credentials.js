// Parses `GANTRY_MCP_WORKSPACE_PATS` once at process startup (docs/adr/0043): a JSON object mapping
// workspace id to its Provider PAT. Held only in server memory by the caller of this function —
// never included in any tool call's arguments or response.
export function parseWorkspacePats(raw) {
  if (raw === undefined || raw === null || raw.trim() === '') return {}

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`GANTRY_MCP_WORKSPACE_PATS must be valid JSON: ${err.message}`)
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('GANTRY_MCP_WORKSPACE_PATS must be a JSON object mapping workspace id to PAT')
  }

  for (const [workspaceId, pat] of Object.entries(parsed)) {
    if (typeof pat !== 'string' || pat === '') {
      throw new Error(`GANTRY_MCP_WORKSPACE_PATS entry for workspace "${workspaceId}" must be a non-empty string`)
    }
  }

  return parsed
}
