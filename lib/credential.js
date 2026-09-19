// The credential-provider seam (#82's spec, built out here per #86): "how do we get a credential for the current request" kept separate from "how do we call the Azure DevOps REST API" (lib/azureDevOpsClient.js) and "how do we read/write instance data" (lib/instance.js). Today this seam has exactly one implementation — extracting a forwarded Azure DevOps Personal Access Token — so a second implementation (silent Microsoft Entra ID SSO via MSAL.js) can be added later without touching the server routes, the Azure DevOps client, or lib/instance.js's storage seam.
//
// The browser attaches the architect's PAT as an HTTP Basic Authorization header on every request to gantry's own backend — empty username, PAT as password, Azure DevOps's own supported PAT convention (per #82's spec) — and this reads that same header back off, rather than gantry inventing its own header/scheme.
//
// #48 (ADR-0042): an Atlassian workspace registration is the one request that has to prove access to
// *two* different products at once (Bitbucket and Jira, each its own token, #40's `{bitbucket, jira}`
// shape) — one HTTP `Authorization` header can only ever carry one credential. Rather than inventing a
// second wire scheme, the primary `Authorization` header keeps meaning exactly what it always has (the
// content-store credential — Bitbucket's, for an Atlassian registration), and a second, equally
// Basic-encoded header (`X-Gantry-Secondary-Authorization`) carries the *other* product's token only
// when a caller genuinely has two to send. `getSecondaryCredential` below is `getCredential` again,
// against that second header — every existing single-token provider (and every other Atlassian route,
// which is always scoped to one product's own client and so only ever needs one token) never sends or
// reads it at all.

function decodeBasicAuthHeader(header) {
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

/**
 * Extracts the caller's Personal Access Token from `req`'s `Authorization` header (HTTP Basic, empty
 * username, PAT as password). Returns the PAT string, or `null` if the request carries no usable
 * credential (header absent, not the "Basic" scheme, not valid base64, or an empty password half).
 * Never throws — a missing/malformed credential is reported by returning `null`, for callers to turn
 * into a structured "authentication required" response, not an exception.
 */
export function getCredential(req) {
  return decodeBasicAuthHeader(req.headers['authorization'])
}

/**
 * The `getCredential` twin for the one caller that needs a *second* credential on the same request —
 * `POST /api/workspaces` registering a brand-new Atlassian workspace, whose Jira token travels
 * alongside the primary Bitbucket one in `X-Gantry-Secondary-Authorization` (see this module's own
 * doc comment above). Same Basic-auth decoding, same `null`-not-throw contract as `getCredential`.
 */
export function getSecondaryCredential(req) {
  return decodeBasicAuthHeader(req.headers['x-gantry-secondary-authorization'])
}
