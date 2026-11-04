// Provider-neutral error classes (docs/adr/0039-provider-capability-interfaces-and-normalized-errors.md).
//
// Every provider implementation (currently just Azure DevOps — lib/azureDevOpsClient.js and its
// three siblings) throws these directly, tagging `provider` itself at the point of construction —
// there is no vendor-named subclass any more. #2 introduced four Azure-DevOps-named subclasses
// (AzureDevOpsAuthenticationError etc.) as the expand half of an expand-contract, so existing catch
// sites kept working unchanged while nothing had yet been migrated; #7 is the contract half — every
// catch site across the codebase now catches these neutral classes directly, and the vendor-named
// subclasses are gone (a class per provider per error kind doesn't scale past one provider, per
// ADR-0039's own "every catch site would have to catch both and grow a third arm per provider
// added").
//
// `provider` (e.g. 'azure-devops', 'github') is set by whichever provider implementation constructs
// the error — never by a catch site — so a caller that catches the neutral type can still report
// which provider failed via `providerDisplayName(err.provider)` below. An untagged "authentication
// required" is ambiguous the moment a second provider exists; the tag is what keeps it diagnosable.

/** Thrown when a provider rejects the supplied credential (401/403 or that provider's equivalent). */
export class AuthenticationError extends Error {
  constructor(message, { status, provider, cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'AuthenticationError'
    this.status = status
    this.provider = provider
  }
}

/** Thrown when the requested item (file, work item, pull request, …) doesn't exist within an otherwise-reachable repo/project. */
export class NotFoundError extends Error {
  constructor(message, { status, provider, cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'NotFoundError'
    this.status = status
    this.provider = provider
  }
}

/** Thrown when the repository itself doesn't exist — distinct from a missing item within an existing repo (NotFoundError) and from a rejected credential (AuthenticationError). */
export class RepoNotFoundError extends Error {
  constructor(message, { status, provider, cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'RepoNotFoundError'
    this.status = status
    this.provider = provider
  }
}

/** Catch-all for any other failed request to a provider's API: a non-2xx response not otherwise distinguished, or a network-level failure reaching the provider at all. */
export class RequestError extends Error {
  constructor(message, { status, body, provider, cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'RequestError'
    this.status = status
    this.body = body
    this.provider = provider
  }
}

/**
 * #325: thrown when a provider refuses a request because its rate limit is used up (a 429, or GitHub's 403 with `x-ratelimit-remaining: 0`
 * or `retry-after`), never because of the credential. A RequestError, so a caller that doesn't care still treats it as a failed request.
 * `resetAt` is when the limit frees up, when the provider says; otherwise null.
 */
export class RateLimitError extends RequestError {
  constructor(message, { status, provider, resetAt = null, cause } = {}) {
    super(message, { status, provider, cause })
    this.name = 'RateLimitError'
    this.resetAt = resetAt
  }
}

/** #325: the RateLimitError a provider's response stands for, or null when it isn't a rate-limit refusal. Checked before a 401/403 is read as a rejected credential. */
export function rateLimitFrom(res, provider) {
  const header = (name) => res.headers?.get?.(name) ?? null
  const remaining = header('x-ratelimit-remaining') ?? header('ratelimit-remaining')
  const retryAfter = header('retry-after')
  if (res.status !== 429 && !(res.status === 403 && (remaining === '0' || retryAfter !== null))) return null
  const reset = header('x-ratelimit-reset') ?? header('ratelimit-reset')
  let resetAt = null
  if (retryAfter !== null && /^\d+$/.test(retryAfter.trim())) resetAt = new Date(Date.now() + Number(retryAfter) * 1000)
  else if (reset !== null && /^\d+$/.test(reset.trim())) resetAt = new Date(Number(reset) * 1000)
  return new RateLimitError(`${providerDisplayName(provider)}'s rate limit is used up (HTTP ${res.status})`, { status: res.status, provider, resetAt })
}

const PROVIDER_DISPLAY_NAMES = {
  'azure-devops': 'Azure DevOps',
  github: 'GitHub',
  gitlab: 'GitLab',
  atlassian: 'Atlassian',
}

/** Maps a `provider` tag (as carried by the four error classes above) to the human-readable name a user-facing message should use — e.g. `sendAuthenticationRequired` (lib/server.js) naming which provider rejected a PAT. Falls back to the raw id for a provider this map doesn't yet know about, rather than throwing, so a caller is never blocked from reporting *something*. */
export function providerDisplayName(provider) {
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider
}
