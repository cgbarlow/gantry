// Shared MCP tool-content shapes, so every tool cluster reports success/failure the same way.

export function okResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

export function errorResult(message, detail) {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: message, ...(detail !== undefined ? { detail } : {}) }, null, 2) }],
  }
}

// `credentialError` is already the structured payload `gantryClient.resolveCredential` produces
// (`missing_workspace_pat` / `workspace_not_found`) — surfaced verbatim as the tool's error content.
export function credentialErrorResult(credentialError) {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(credentialError, null, 2) }] }
}

// A `gantry serve` response that came back but wasn't `ok` (4xx/5xx) — including its own
// `authentication_required` shape (docs/adr/0038) when a caller-supplied credential was rejected.
export function upstreamErrorResult(res) {
  return errorResult(`gantry serve responded ${res.status}`, res.body)
}
