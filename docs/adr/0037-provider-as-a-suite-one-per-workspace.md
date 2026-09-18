# Provider is a suite, and a workspace picks exactly one

Until now gantry integrated with exactly one external system, and the domain model said so in two incompatible ways: a workspace's *repo* location was a bare `{organization, project, repository}` triple with Azure DevOps assumed everywhere, while its *work items* went through a separate `ticketingSystem` field modelled as `['azure-devops', 'jira']`. Adding first-class GitHub support forces the question those two shapes disagree about: is "which external system" one choice per workspace or two?

## Decision

A **Provider** is an external *suite* that supplies both halves of a remote workspace — the repo that holds instance content and the tracker that holds its work items. A workspace names exactly one:

- **Azure DevOps** — Repos for content, Boards for work items
- **GitHub** — repos for content, Issues for work items
- **Atlassian** (not built) — Bitbucket for content, Jira for work items

`ticketingSystem` is absorbed into a single `provider` field rather than joined by a sibling. The modelled-but-unsupported `'jira'` value is renamed to the suite it belongs to, because under this model a value that names only a tracker can never be selected — Jira cannot host the instance repo.

A workspace's location becomes `{provider, location: {…}}`, discriminated by provider: Azure DevOps keeps `{organization, project, repository, baseUrl?}`, GitHub gets `{owner, repository, baseUrl?}`. Each provider owns its own field validation and its own tuple-matching for `findWorkspaceByLocation`. Library repos (`lib/librarySettings.js`) take the identical treatment — a `provider` plus a nested location — since they are remote repos too, just in a different registry.

Existing flat records are read as `provider: 'azure-devops'` with their fields lifted into the nested shape, rewritten on next write. This is the auto-backfill-on-read convention every registry in this codebase already follows (`lib/instanceRegistry.js`'s `migrateLegacyFlatShape`), not a one-shot boot migration.

## Alternatives considered and rejected

- **Two independent fields — content-store provider and work-item provider chosen separately.** Rejected: it doubles the credential and error surface of every workspace (two locations, two PATs, and every `authentication_required` response having to say *which* provider is unauthenticated) to serve a mixed-provider configuration nobody has asked for. The suite model reaches the same place for the case that actually motivated the split — Jira — because Jira arrives with Bitbucket attached.
- **Keeping the flat `{organization, project, repository}` shape with `project` optional.** Rejected: `organization` would quietly mean three different things across providers and every consumer would need to know when `project` is meaningful. It reads fine at the point of change and rots from there.
- **A canonical repo-URL string parsed per provider.** Rejected: `findWorkspaceByLocation`'s exact-tuple matching would become string normalisation — trailing slashes, `.git` suffixes, host casing — and validation would weaken to a regex.
- **Retaining `'jira'` as a tracker-only enum value.** Rejected: it is unselectable under a suite model, and a schema value that can never be set is worse than no value at all.

## Consequences

- Mixed-provider workspaces ("GitHub repo, Azure DevOps boards") become impossible by construction, not merely unsupported. Making one possible later is a schema change, not a configuration change.
- Bitbucket calls its org-level container a *workspace*, which collides head-on with gantry's own core term. If Atlassian support is ever built, that collision must be resolved in the glossary before the term reaches code or UI copy.
- The location kind `CONTEXT.md` called an **Azure DevOps workspace** is renamed to a **Remote workspace**, so that all three kinds on the Workspace location axis name *where the folder is* rather than one of them naming a vendor.

Status: accepted. Decided during the first-class-GitHub-support grilling session, 2026-09-18, ahead of implementation.
