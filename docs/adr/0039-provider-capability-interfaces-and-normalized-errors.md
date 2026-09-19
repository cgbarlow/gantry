# Providers implement four capability interfaces, and errors stop naming a vendor

Azure DevOps reaches gantry through four clients — `azureDevOpsClient.js` (repo, files, branches, commits), `azureDevOpsPullRequestsClient.js`, `azureDevOpsWorkItemsClient.js` and `azureDevOpsIdentityClient.js` — each throwing its own `AzureDevOps*Error` classes that around seven modules catch by name. The split is already right; what is wrong is that the seam is named after one vendor and `createAzureDevOpsClient` is called directly from `instance.js`, `render.js`, `registry.js`, `definitionAzureDevOps.js`, `definitionPromote.js`, `repoCheck.js` and `server.js`.

## Decision

A provider registers implementations of four **capability interfaces**, preserving the division that already exists rather than inventing a new one:

- **content store** — read and write instance and definition files, branches, commits
- **pull requests** — open, read reviewer state, merge
- **work items** — create, comment, link, set state
- **identity** — resolve a name to a person who can be assigned

Error classes become provider-neutral — `AuthenticationError`, `NotFoundError`, `RepoNotFoundError`, `RequestError` — each carrying a `provider` tag for messages and logging. Call sites catch the neutral type; only the provider implementation knows which HTTP status from which API maps to it.

Splitting by capability rather than exposing one flat provider object is what makes the Atlassian case expressible at all: one provider would supply Bitbucket for content store and pull requests, and Jira for work items and identity. A single all-methods interface would force every provider to implement everything as one unit, which is exactly wrong for a suite assembled from two products.

**Library-repo credentials** become provider-aware alongside this. `GANTRY_LIBRARY_PAT` is a single provider-blind environment variable and cannot reach both an Azure DevOps and a GitHub library repo. It is replaced by one variable per provider — `GANTRY_LIBRARY_PAT_AZURE_DEVOPS`, `GANTRY_LIBRARY_PAT_GITHUB` — with the existing name kept as a deprecated alias for the Azure DevOps one. Each library repo resolves its credential by its own provider. This preserves `docs/adr/0036`'s decision and trust boundary unchanged; it only stops that decision assuming a single provider.

The `allowAzureDevOpsBaseUrlOverride` SSRF guard on caller-supplied `baseUrl` becomes a per-provider flag with identical semantics.

## Alternatives considered and rejected

- **One flat provider object with every method.** Rejected: simpler to register and to mock, but it cannot express a suite built from two products, which is the case `docs/adr/0037` explicitly admits.
- **Per-provider clients adapted at each call site,** branching on provider where they are used. Rejected: it spreads provider conditionals through `instance.js`, `render.js` and `server.js`, and leaves no seam for a third provider to plug into.
- **Keeping the `AzureDevOps*Error` names and adding `GitHub*Error` siblings.** Rejected: every catch site would have to catch both and grow a third arm per provider added.
- **Moving library repos to per-user PATs** so they resolve credentials like workspaces do. Rejected: it supersedes `docs/adr/0036`'s deliberate single-credential-surface decision, changes a Promote PR's author from a service identity to whoever clicked, and leaves a server-side cache refresh with no credential when nobody is signed in.

## Consequences

- An operator running both Azure DevOps and GitHub library repos configures two environment variables. A single-provider deployment keeps working on the old variable name alone.
- Provider-neutral errors mean a caller can no longer tell *which* provider failed from the exception type. The `provider` tag carries that instead, and every user-facing message must include it — an untagged "authentication required" is now ambiguous in a way it never was before.
- The four interfaces are defined against two real implementations, not three. Atlassian will likely require adjusting them; that is preferred to designing the seam against a product nobody has integrated.

Status: accepted. Decided during the first-class-GitHub-support grilling session, 2026-09-18, ahead of implementation.
