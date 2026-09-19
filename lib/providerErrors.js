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
