// The credential-provider seam (#82's spec, built out here per #86): "how do
// we get a credential for the current request" kept separate from "how do
// we call the Azure DevOps REST API" (lib/azureDevOpsClient.js) and "how do
// we read/write instance data" (lib/instance.js). Today this seam has
// exactly one implementation — extracting a forwarded Azure DevOps Personal
// Access Token — so a second implementation (silent Microsoft Entra ID SSO
// via MSAL.js) can be added later without touching the server routes, the
// Azure DevOps client, or lib/instance.js's storage seam.
//
// The browser attaches the architect's PAT as an HTTP Basic Authorization
// header on every request to gantry's own backend — empty username, PAT as
// password, Azure DevOps's own supported PAT convention (per #82's spec) —
// and this reads that same header back off, rather than gantry inventing
// its own header/scheme.

/**
 * Extracts the caller's Azure DevOps Personal Access Token from `req`'s
 * Authorization header. Returns the PAT string, or `null` if the request
 * carries no usable credential (header absent, not the "Basic" scheme, not
 * valid base64, or an empty password half). Never throws — a missing/
 * malformed credential is reported by returning `null`, for callers to turn
 * into a structured "authentication required" response, not an exception.
 */
export function getCredential(req) {
  const header = req.headers['authorization']
  if (!header) return null

  const spaceIndex = header.indexOf(' ')
  if (spaceIndex === -1) return null
  const scheme = header.slice(0, spaceIndex)
  const encoded = header.slice(spaceIndex + 1).trim()
  if (scheme.toLowerCase() !== 'basic' || !encoded) return null

  let decoded
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8')
  } catch {
    return null
  }

  const colonIndex = decoded.indexOf(':')
  if (colonIndex === -1) return null
  const pat = decoded.slice(colonIndex + 1)
  return pat === '' ? null : pat
}
