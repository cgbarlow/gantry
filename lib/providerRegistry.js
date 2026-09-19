// The provider registry (#2, docs/adr/0037, docs/adr/0039): resolves a
// workspace's `provider` identifier to four capability interfaces —
// **content store** (files, branches, commits), **pull requests** (open,
// read reviewer state, merge), **work items** (create, comment, link, set
// state) and **identity** (resolve a name to a person who can be assigned).
// Splitting by capability rather than exposing one flat provider object is
// what makes a suite assembled from two different products (Atlassian:
// Bitbucket + Jira) expressible at all — a single all-methods interface
// would force every provider to implement everything as one unit.
//
// This is the expand half of an expand-contract: Azure DevOps is registered
// here by adapting the four clients that already exist
// (lib/azureDevOpsClient.js, lib/azureDevOpsPullRequestsClient.js,
// lib/azureDevOpsWorkItemsClient.js, lib/azureDevOpsIdentityClient.js) —
// same method names, same behaviour, same error classes (now provider-tagged
// per docs/adr/0039). No existing call site is migrated to resolve its
// client through this registry yet; they keep constructing Azure DevOps
// clients directly until a later ticket moves them over. GitHub's four
// implementations land in later tickets and register here the same way.
//
// Each capability factory is a plain function — `(config) => capability` —
// not a pre-built instance, mirroring how `createAzureDevOpsClient` and its
// siblings already work: a caller supplies the connection details it has
// (organization/project/repository/pat/baseUrl for Azure DevOps;
// owner/repository/pat/baseUrl for GitHub) and gets back a live capability.
// Resolving the *factories* rather than instantiating all four eagerly means
// a caller that only needs identity (say) never has to supply a
// `repository` just because content-store's factory would otherwise demand
// one.

import { createAzureDevOpsClient } from './azureDevOpsClient.js'
import { createAzureDevOpsPullRequestsClient } from './azureDevOpsPullRequestsClient.js'
import { createAzureDevOpsWorkItemsClient } from './azureDevOpsWorkItemsClient.js'
import { createAzureDevOpsIdentityClient } from './azureDevOpsIdentityClient.js'
import { createGitHubClient } from './githubClient.js'
import { createGitHubIdentityClient } from './githubIdentityClient.js'
import { createGitHubWorkItemsClient } from './githubWorkItemsClient.js'
import { createGitHubPullRequestsClient } from './githubPullRequestsClient.js'
import { createGitLabClient } from './gitlabClient.js'
import { createGitLabIdentityClient } from './gitlabIdentityClient.js'
import { createGitLabWorkItemsClient } from './gitlabWorkItemsClient.js'
import { createGitLabPullRequestsClient } from './gitlabPullRequestsClient.js'

const providers = {
  'azure-devops': {
    contentStore: createAzureDevOpsClient,
    pullRequests: createAzureDevOpsPullRequestsClient,
    workItems: createAzureDevOpsWorkItemsClient,
    identity: createAzureDevOpsIdentityClient,
  },
  // GitHub registers one capability per ticket as each lands (#11 — content store, #10 — identity,
  // #14 — work items, #20 — pull requests, scoped to what Promote needs: open/read/request-reviewer,
  // no merge) — the same incremental registration this file's own doc comment describes.
  github: {
    contentStore: createGitHubClient,
    identity: createGitHubIdentityClient,
    workItems: createGitHubWorkItemsClient,
    pullRequests: createGitHubPullRequestsClient,
  },
  // GitLab joins the registry the same incremental, one-capability-per-ticket way GitHub did (#26 —
  // content store; #28 — identity; #30 — work items; #33 — pull requests, ADR-0041's own scope list
  // fully landed). `getProviderCapabilities('gitlab')` now exposes all four capabilities, at parity
  // with Azure DevOps and GitHub.
  gitlab: {
    contentStore: createGitLabClient,
    identity: createGitLabIdentityClient,
    workItems: createGitLabWorkItemsClient,
    pullRequests: createGitLabPullRequestsClient,
  },
}

/** Provider identifiers with a registered implementation — Azure DevOps (full) and GitHub (content store + identity so far, more capabilities landing per-ticket). Distinct from the full `provider` enum (docs/adr/0037), which also lists `'atlassian'` as known-but-unavailable. */
export function registeredProviders() {
  return Object.keys(providers)
}

/**
 * Resolves `providerId` to its four capability factories — `{ contentStore, pullRequests, workItems, identity }`, each `(config) => capability`. Throws if `providerId` has no registered implementation, naming which ones do, rather than returning `undefined` capabilities a caller would only discover were missing on first use.
 */
export function getProviderCapabilities(providerId) {
  const capabilities = providers[providerId]
  if (!capabilities) {
    throw new Error(`getProviderCapabilities: no provider registered for "${providerId}" (registered: ${registeredProviders().join(', ')})`)
  }
  return capabilities
}

/** Resolves `providerId`'s content-store capability and instantiates it with `config`. Shorthand for `getProviderCapabilities(providerId).contentStore(config)`. */
export function resolveContentStore(providerId, config) {
  return getProviderCapabilities(providerId).contentStore(config)
}

/** Resolves `providerId`'s pull-requests capability and instantiates it with `config`. Shorthand for `getProviderCapabilities(providerId).pullRequests(config)`. */
export function resolvePullRequests(providerId, config) {
  return getProviderCapabilities(providerId).pullRequests(config)
}

/** Resolves `providerId`'s work-items capability and instantiates it with `config`. Shorthand for `getProviderCapabilities(providerId).workItems(config)`. */
export function resolveWorkItems(providerId, config) {
  return getProviderCapabilities(providerId).workItems(config)
}

/** Resolves `providerId`'s identity capability and instantiates it with `config`. Shorthand for `getProviderCapabilities(providerId).identity(config)`. */
export function resolveIdentity(providerId, config) {
  return getProviderCapabilities(providerId).identity(config)
}
