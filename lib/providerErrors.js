// Provider-neutral error classes (docs/adr/0039-provider-capability-interfaces-and-normalized-errors.md).
//
// Every provider's own error classes (e.g. AzureDevOpsAuthenticationError in
// lib/azureDevOpsClient.js) extend the matching class here instead of Error
// directly, so a call site can catch either the specific, vendor-named error
// or the neutral one — `err instanceof AzureDevOpsAuthenticationError` and
// `err instanceof AuthenticationError` are both true for the same thrown
// error. This is the expand half of an expand-contract (#2): existing catch
// sites across the codebase keep working unchanged; nothing is migrated to
// catching the neutral type here.
//
// `provider` is a required tag (e.g. 'azure-devops', 'github') set by the
// vendor subclass's own constructor — never by a call site — so a caller that
// *does* catch the neutral type can still report which provider failed. An
// untagged "authentication required" is ambiguous the moment a second
// provider exists; the tag is what keeps it diagnosable.

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
