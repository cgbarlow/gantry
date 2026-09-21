import { timingSafeEqual } from 'node:crypto'

// The MCP-access auth layer (docs/adr/0043): a single shared bearer token checked on every incoming
// request before any tool runs. Distinct from a Workspace PAT, which authenticates a specific
// workspace to its Provider rather than a caller to this server.
export function isAuthorizedAccessToken(req, expectedToken) {
  const header = req.headers['authorization']
  if (typeof header !== 'string') return false

  const match = /^Bearer\s+(.+)$/i.exec(header)
  if (!match) return false

  const provided = Buffer.from(match[1])
  const expected = Buffer.from(expectedToken)
  if (provided.length !== expected.length) return false

  return timingSafeEqual(provided, expected)
}
