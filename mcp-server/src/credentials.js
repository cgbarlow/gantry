// Parses `GANTRY_MCP_WORKSPACE_PATS` once at process startup (docs/adr/0043): a JSON object mapping
// workspace id to its Provider PAT. Held only in server memory by the caller of this function —
// never included in any tool call's arguments or response.
export function parseWorkspacePats(raw) {
  if (raw === undefined || raw === null || raw.trim() === '') return {}

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    // #130's rule 1 ("names only, never values") applies to this message too. `JSON.parse`'s own
    // error text embeds the first ~10 characters of its input (`Unexpected token 'g',
    // "ghp_ABCDEF"... is not valid JSON`), so interpolating it here printed a prefix of the
    // operator's PAT straight into the deploy log — and the likeliest way to reach this branch at
    // all is pasting a bare PAT where the map was expected. Mirrors `lib/workspaceBootstrap.js`'s
    // `parseSharedWorkspacePats`, by hand, for the reason given in that function's own doc comment.
    throw new Error(
      'GANTRY_MCP_WORKSPACE_PATS must be valid JSON: a JSON object mapping workspace id to PAT, {"<workspaceId>":"<pat>"}. ' +
        'The value it is set to is deliberately not shown here — it holds credentials.'
    )
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
