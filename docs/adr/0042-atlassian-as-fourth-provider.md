# Atlassian as fourth provider, and the first split-suite one

**Status**: accepted

ADR-0037 modelled Atlassian (Bitbucket + Jira) as the anticipated third Provider; ADR-0041 superseded that with GitLab as third, leaving Atlassian an unbuilt, hypothetical fourth. It is now being built. Atlassian is the first Provider where the ADR-0037 "suite" isn't one product: Bitbucket and Jira are two separately-hosted Atlassian products, unlike Azure DevOps (Repos + Boards), GitHub (repos + Issues) and GitLab (Projects + Issues), each one product bundling both halves. Every decision below either follows directly from that split or was forced open by it.

## Scope decided alongside this

- **Cloud only.** Bitbucket Cloud + Jira Cloud, not Bitbucket/Jira Server or Data Center. Self-hosted GitLab (ADR-0041) was a "free" extension because CE/EE addresses a repo exactly like gitlab.com, just at a different host. Self-hosted Atlassian is not free the same way: Bitbucket Cloud addresses a repo as `workspace/repo_slug`, while Bitbucket Server/Data Center has no "workspace" concept at all — it's `projectKey/repoSlug`, a different addressing shape, not a different host for the same shape. Supporting both would mean the location schema itself varies by deployment kind. Deferred rather than designed around.
- **Full capability parity** with GitHub/GitLab (content store, identity, work items, pull/merge requests with sign-off gating, branches, assets, definitions, repo adoption, library repos/Promote) is the v1 target, same as every provider built so far.
- **Auth stays PAT-style**, per ADR-0038 — but see Credentials below for what "per workspace" means once the suite is split.
- **No new N-way-dispatch prerequisite ticket.** ADR-0041's dispatch-generalization ticket (#24) already converted the binary `provider === 'github'` branches across `server.js`, `render.js`, `instanceRegistry.js`, `registry.js` and `workItemLink.js` into genuine per-provider dispatch (provider-keyed tables, or one parallel function per provider). Adding a fourth arm to each is mechanical. The one real prerequisite this provider needs is the credential-schema change below, scoped as its own ticket for the same reason #24 was: capability tickets need it to already exist.

## Location schema

Atlassian's location is `{ owner, repository, jiraSite, jiraProjectKey }`:

- **`owner`/`repository`** reuse GitHub's own keys for the Bitbucket half, because Bitbucket Cloud addresses a repo identically to GitHub — `workspace-slug/repo-slug` is structurally `owner/repository` under a different provider's vocabulary, the same reasoning ADR-0041 used to reuse `repository` for GitLab rather than inventing a new key per provider's native term.
- **`jiraSite`** holds the Jira Cloud site hostname (`yoursite.atlassian.net`). Unlike every other provider's `baseUrl`, this is not an optional self-hosted override defaulting to a shared public host — every Atlassian Cloud tenant has its own site, Cloud or not, so the field is required.
- **`jiraProjectKey`** holds Jira's own project key. Named with a `jira` prefix rather than a bare `project`, continuing ADR-0041's own reasoning: three providers now use "project" for three different things (Azure DevOps's multi-repo container, GitLab's repo-equivalent, and Jira's issue container), so no provider gets to keep the bare word once a second one already claimed it.
- Bitbucket Cloud's own optional "Project" grouping (a label within a Bitbucket account, unrelated to Jira's) is not modelled or surfaced anywhere — it plays no part in addressing a repo, so there is no `bitbucketProjectKey` to confuse with `jiraProjectKey`.
- No `baseUrl` field: Cloud-only means both products' API hosts are fixed (`api.bitbucket.org`, and each tenant's own `jiraSite`), so there is no self-hosted override to gate behind ADR-0039's SSRF-allow-flag mechanism the way the other three providers' `baseUrl` is.

### Considered and rejected
- Two independent provider values (`bitbucket`, `jira`), chosen separately per workspace — rejected by ADR-0037 already, for the same reason: it reopens mixed-provider workspaces as a real configuration rather than something impossible by construction.
- A single `baseUrl` field reused for both products — rejected: Bitbucket Cloud's host never varies, Jira's always does (per-tenant), so one optional-override field can't correctly describe either.

## Credentials: two tokens, one workspace

`web/lib/credential.js` stores exactly one PAT per workspace today (ADR-0038: "every workspace holds its own PAT"). Bitbucket Cloud and Jira Cloud are different products with their own token systems — a Bitbucket API token and a Jira API token are not interchangeable, even though both may be issued from the same Atlassian account. An Atlassian workspace therefore holds two tokens in its one workspace slot, `{bitbucket, jira}`, each sent only to its own product's calls. This is a real, if contained, schema change to a file every other provider shares unchanged — `patForWorkspace`, `setPatForWorkspace`, `clearPatForWorkspace`, `authHeaderForWorkspace` and `credentialStatusForWorkspace` all currently assume one token per workspace. ADR-0038's blast-radius guarantee is unaffected: both tokens still belong to exactly one workspace and are never offered to another.

### Considered and rejected
- One shared Atlassian API token sent to both products — rejected: relies on a user's token happening to be scoped for both Bitbucket and Jira, which Atlassian's own token scoping does not guarantee, and fails silently (a token valid for one product, rejected by the other) rather than by construction.

## Jira issue type

Jira requires an issue type at creation (Story, Bug, Task, Epic, …) — there is no type-less create-issue call the way GitHub/GitLab Issues have. This mirrors Azure DevOps, not GitHub/GitLab: Azure Boards work items are typed too, and the wizard already fetches the project's live configured types (`web/pages/new-workspace-wizard.js`'s `loadWorkItemTypes()`) rather than hardcoding one, defaulting to `DEFAULT_WORK_ITEM_TYPE` ("Task") when present. Jira gets the identical treatment: the wizard fetches the Jira project's own configured issue types and offers the same kind of picker, rather than inventing a new pattern or silently picking one fixed type.

## Pull request review-state mapping

Bitbucket Cloud's PR review model needs no GitLab-style workaround. Each reviewer's participant state is a genuine tri-state — `approved`, `changes_requested`, or no action yet — mapping directly onto gantry's approved / `CHANGES_REQUESTED` / still-pending, the same shape GitHub's own `APPROVED`/`CHANGES_REQUESTED`/`COMMENTED` mapping already uses (`docs/adr/0040-github-work-item-and-review-model.md`). Unlike GitLab Free/CE, there is no toggle-plus-discussion-threads reading to construct.

## Identity stays per-product

A PR reviewer is picked from Bitbucket's own member list; a work-item assignee is picked from Jira's own user directory. The two are never unified into one combined picker, even though both may sit under one Atlassian account — this falls directly out of the split-suite model already chosen: each capability (pull requests, work items) is backed by whichever product actually implements it, and that product's own directory is the only one that capability ever needs.

## Terminology

Bitbucket's own org-level container is literally named "workspace" in Bitbucket's own product and API — a sharper collision than GitLab's (GitLab's clash was with an unrelated cloud-dev-environment feature, not the same word for a structurally similar thing). Gantry's docs and UI call it a **Bitbucket account** instead, never "Bitbucket workspace." The glossary entry ADR-0037 left open ("must be renamed before the term reaches code or UI copy") is resolved by this choice.
