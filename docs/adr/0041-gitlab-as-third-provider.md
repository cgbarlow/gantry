# GitLab as third provider, superseding the Atlassian assumption

**Status**: accepted

ADR-0037 modelled Atlassian (Bitbucket + Jira) as the anticipated third Provider, with `PROVIDERS` in `lib/provider.js` reserving an `'atlassian'` slot for it. GitLab ships as the actual third provider instead — it fits the existing capability-interface contract (ADR-0039) more directly than Atlassian would have, since a GitLab Project bundles repo + issues + merge requests in one product the way GitHub does, rather than as a split suite. Atlassian remains an unbuilt, hypothetical fourth provider if ever revisited; nothing about this decision forecloses it.

## Scope decided alongside this

- **Full capability parity** with the GitHub provider (content store, identity, work items, pull/merge requests with sign-off gating, branches, assets, definitions, repo adoption, library repos/Promote) is the v1 target, not a phased subset.
- **Self-hosted GitLab** (CE/EE, configurable base URL) is supported from day one, not just gitlab.com — self-hosting is far more common for GitLab than for GitHub or Azure DevOps, and the per-provider `baseUrl` override + SSRF-allow-flag mechanism from ADR-0039 already generalizes to it with no new design.
- **Auth stays PAT-only** per workspace, matching Azure DevOps and GitHub (ADR-0038). GitLab Project/Group Access Tokens behave like PATs, so no OAuth app flow is needed.
- **A prerequisite ticket** generalizes `lib/provider.js`'s two-provider enum and converts the ~50 binary `provider === 'github'` branches found across `server.js`, `render.js`, `instanceRegistry.js`, `registry.js` and `workItemLink.js` into genuine N-way dispatch, before any GitLab-capability ticket starts. Those binary branches are exactly the anti-pattern ADR-0039 already rejected ("per-provider clients adapted at each call site... leaves no seam for a third provider to plug into") but which crept back in during the GitHub build; a third provider is what finally forces it to be paid down.

## Location schema

GitLab's location is `{ namespace, repository, baseUrl? }`:

- **`namespace`** holds GitLab's full group/subgroup path as one opaque string (`engineering/platform/backend-services`), however many segments deep — not split into per-level fields. This matches how GitLab's own API addresses a project (a URL-encoded `namespace/project` path) and keeps every provider's schema a flat list of string fields rather than adding a variable-depth one just for GitLab.
- **`repository`** reuses GitHub's schema key rather than GitLab's own term "Project" — a GitLab Project is structurally what GitHub calls a repository (one repo + issues + MRs), whereas Azure DevOps's `project` field in this same codebase already means a different thing (a multi-repo container within an org). Reusing GitLab's own word here would silently overload `location.project` with two conflicting meanings depending on provider. The wizard still *labels* the field "Project" to the user — only the internal key is neutral, consistent with how capability names (`pullRequests`, `workItems`) stay neutral in code while UI copy uses each provider's native term.

### Considered and rejected
- `{ group, subgroup, repository }` with a fixed subgroup depth — rejected: caps nesting GitLab itself doesn't cap, and breaks the flat-string-fields pattern every other provider schema follows.
- `location.project` for GitLab's repo-equivalent — rejected: collides with Azure DevOps's existing, differently-scoped `project` field in the same codebase.

## Merge request review-state mapping

GitLab has no formal "request changes" review verb on Free/CE — only a binary Approve/unapprove toggle, structurally separate from discussion-thread resolution. Gantry's Check status reads:

- **not-approved + an unresolved discussion thread** → the `CHANGES_REQUESTED` equivalent (blocked)
- **not-approved + no unresolved thread** → still-pending (the `COMMENTED` equivalent)
- **approved** → approved

On GitLab Premium/Ultimate instances where enforced Approval Rules exist, gantry honours those; where they don't (Free/CE, or a Premium instance that hasn't configured them), it falls back to the toggle-plus-threads reading above rather than refusing to support sign-off gating on GitLab's lower tiers at all.

## Person-picker assignability gate

GitLab's Members API (`GET /projects/:id/members/all`) already folds inherited group/subgroup
membership into a project's own member list server-side, unlike GitHub's own separate
collaborators-plus-org-members union (docs/adr/0040) — so the picker's candidate set is that one
response, no second per-user permission lookup needed.

Every candidate still needs a *can this actually be assigned* answer, the same gate docs/adr/0040
gives GitHub. GitLab expresses access as a 10/20/30/40/50 (Guest/Reporter/Developer/Maintainer/Owner)
scale rather than GitHub's has-access-or-not; gantry reads Reporter (20) or above as sufficient —
GitLab itself requires at least Reporter to be assigned an issue or merge request, so a Guest resolves
but is shown blocked, with guidance to grant Reporter access (directly or through the group) and retry
(#28, mirroring #10's identical shows-but-blocks contract for GitHub).

## Terminology

`docs/adr/0037-...`'s existing caution about "workspace" colliding with a provider's own vocabulary extends to GitLab: GitLab ships an unrelated "GitLab Workspaces" cloud-dev-environment feature, so Gantry's docs/UI say "a workspace on GitLab," never "GitLab workspace" as a compound noun.
