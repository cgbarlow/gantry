# Definition home: server library and workspaces, with library repos promoted by PR

Until Feature #380, a definition could only live in one place: the `definitions/` directory packaged into the gantry server. Phases 3–4 and 6–7 extend authoring to workspaces (server, Azure DevOps, and local), and add external **library repos** as additional read sources for the server library — without turning "where is this definition" into an ambiguous question.

## Decision

A **Definition home** is either:

- the **server library** — the packaged `definitions/` directory, plus the union of every **library repo** configured in Settings — or
- a **workspace**'s own `definitions/` folder (a server, Azure DevOps, or local workspace), laid out identically to the server library.

Ids are unique across the server library and every workspace combined. There is no shadowing: two definitions can never share an id regardless of which home they live in, and a workspace's definitions are not reachable from any other workspace — a workspace is a boundary, not a namespace layer. This mirrors the existing instance-data model (`docs/adr/0031-server-workspace-directories.md`'s family): per-workspace data stays scoped to that workspace, full stop, rather than merging into some larger visible set.

**Library repos** are any number of Azure DevOps repos an author adds in Settings. They are read sources only — unioned into what the editor calls "the server library" — fetched into a local cache with an explicit **Refresh** action, not re-fetched on every read. They are read-only in the editor: an author can copy an element out of one (per `docs/adr/0035`), never edit one in place.

**Promote** is how a change flows the other way, from a workspace back toward the wider library. It opens a **pull request to the code owner**, one PR per library repo selected (an author can target several at once), and never writes directly to a library repo's default branch. This keeps a promoted change subject to whatever review process that repo's own owners already run — gantry proposes, it doesn't merge on their behalf. Per repo, it branches `definition/<id>-v<n>` from that repo's default branch, pushes the full version folder as one commit, and opens the Pull Request with the repo's configured **code owner** (an optional field alongside each library repo's own organization/project/repository in Settings, resolved to a real Azure DevOps identity the same way a workspace's Owner already is for sign-off, `lib/azureDevOpsIdentityClient.js`) attached as a *required* reviewer. Promoting to several repos at once is independent per repo — one repo's failure (an unreachable repo, an already-open promotion branch) never blocks another's. The Pull Request's own link and status (open/completed/abandoned, and the reviewer's vote) are read back on an explicit **Check** action, never polled — the same posture ADR-0014 already established for sign-off.

**Credential** (phase 7, resolving this ADR's own "Consequences" question below, first-cut, rather than leaving it open): Promote reuses the server's existing `GANTRY_LIBRARY_PAT` — the same credential `lib/libraryCache.js` already reads every configured library repo with — rather than opening a second, per-user credential surface. A server that can already read a library repo's `definitions/` folder with this PAT needs no new credential to also branch/push/open-a-PR against that same repo; scoping Promote to "whatever `GANTRY_LIBRARY_PAT` can already reach" keeps exactly one credential surface for library repos, read and write alike, instead of two.

Server and Azure DevOps workspaces save straight to their own repo's main, the same pattern instance data already uses (`docs/adr/0031`) — a workspace's own repo is the author's own space, not a shared library, so there's no review gate to preserve there. Local workspace definitions are edited and rendered entirely client-side through gantry's existing stateless validate/render endpoints; nothing is written to any repo until the author explicitly promotes.

## Alternatives considered and rejected

- **A single global definitions store with overlay/shadow semantics** (a workspace definition can reuse an id from the library, shadowing it locally). Rejected: gantry's id-based addressing (`definitions/<id>/<n>/`) already assumes one id means one thing everywhere it's read; shadowing reopens the "which one did you mean" ambiguity that every other part of the domain model (module ids, field ids, stage ids) deliberately avoids.
- **Promote writes directly to the library repo** (gantry pushes a branch and merges, or commits straight to main). Rejected during the Feature #380 grilling session in favour of the PR-to-code-owner path — a direct write would bypass whatever policies and reviewers a library repo's own team has set up, which gantry has no visibility into and no business overriding.
- **Live/on-demand fetch of library repos on every read** instead of a cached Refresh. Rejected for latency and availability: every list-definitions call would depend on every configured library repo being reachable at that instant. An explicit Refresh makes staleness visible and user-controlled instead of an invisible failure mode.

## Consequences

- Promoting needs gantry to hold PR-creation credentials against each configured library repo. Resolved in phase 7 (WI #387, see this ADR's own "Credential" paragraph above): reuse `GANTRY_LIBRARY_PAT`, the existing read credential, rather than opening a new one — accepting that anyone who can reach this server's Promote action can open a PR (never merge one) against any configured library repo, the same trust boundary `GANTRY_LIBRARY_PAT` already carries for reads.
- Library repo content can be stale between Refreshes; this is accepted as the cost of not depending on every configured repo's availability for routine reads.
- The "+ New Workspace" wizard's definition picker must enumerate server-library definitions and the workspace's own definitions from one unioned, de-duplicated-by-id list — there is exactly one such list because ids are unique by construction, not because the picker merges anything itself.

Status: accepted. Written ahead of WI #383/#386/#387's implementation, per Feature #380's own instruction to record this decision when those phases start; amended in phase 7 (WI #387) to record the Promote credential decision above once that phase actually needed to make it.
