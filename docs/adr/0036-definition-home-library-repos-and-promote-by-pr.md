# Definition home: server library and workspaces, with library repos promoted by PR

Until Feature #380, a definition could only live in one place: the `definitions/` directory packaged into the gantry server. Phases 3–4 and 6–7 extend authoring to workspaces (server, Azure DevOps, and local), and add external **library repos** as additional read sources for the server library — without turning "where is this definition" into an ambiguous question.

## Decision

A **Definition home** is either:

- the **server library** — the packaged `definitions/` directory, plus the union of every **library repo** configured in Settings — or
- a **workspace**'s own `definitions/` folder (a server, Azure DevOps, or local workspace), laid out identically to the server library.

Ids are unique across the server library and every workspace combined. There is no shadowing: two definitions can never share an id regardless of which home they live in, and a workspace's definitions are not reachable from any other workspace — a workspace is a boundary, not a namespace layer. This mirrors the existing instance-data model (`docs/adr/0031-server-workspace-directories.md`'s family): per-workspace data stays scoped to that workspace, full stop, rather than merging into some larger visible set.

**Library repos** are any number of Azure DevOps repos an author adds in Settings. They are read sources only — unioned into what the editor calls "the server library" — fetched into a local cache with an explicit **Refresh** action, not re-fetched on every read. They are read-only in the editor: an author can copy an element out of one (per `docs/adr/0035`), never edit one in place.

**Promote** is how a change flows the other way, from a workspace back toward the wider library. It opens a **pull request to the code owner**, one PR per library repo selected (an author can target several at once), and never writes directly to a library repo's default branch. This keeps a promoted change subject to whatever review process that repo's own owners already run — gantry proposes, it doesn't merge on their behalf.

Server and Azure DevOps workspaces save straight to their own repo's main, the same pattern instance data already uses (`docs/adr/0031`) — a workspace's own repo is the author's own space, not a shared library, so there's no review gate to preserve there. Local workspace definitions are edited and rendered entirely client-side through gantry's existing stateless validate/render endpoints; nothing is written to any repo until the author explicitly promotes.

## Alternatives considered and rejected

- **A single global definitions store with overlay/shadow semantics** (a workspace definition can reuse an id from the library, shadowing it locally). Rejected: gantry's id-based addressing (`definitions/<id>/<n>/`) already assumes one id means one thing everywhere it's read; shadowing reopens the "which one did you mean" ambiguity that every other part of the domain model (module ids, field ids, stage ids) deliberately avoids.
- **Promote writes directly to the library repo** (gantry pushes a branch and merges, or commits straight to main). Rejected during the Feature #380 grilling session in favour of the PR-to-code-owner path — a direct write would bypass whatever policies and reviewers a library repo's own team has set up, which gantry has no visibility into and no business overriding.
- **Live/on-demand fetch of library repos on every read** instead of a cached Refresh. Rejected for latency and availability: every list-definitions call would depend on every configured library repo being reachable at that instant. An explicit Refresh makes staleness visible and user-controlled instead of an invisible failure mode.

## Consequences

- Promoting needs gantry to hold (or obtain per-user) PR-creation credentials against each configured library repo — a new credential surface, scoped no wider than "open a pull request."
- Library repo content can be stale between Refreshes; this is accepted as the cost of not depending on every configured repo's availability for routine reads.
- The "+ New Workspace" wizard's definition picker must enumerate server-library definitions and the workspace's own definitions from one unioned, de-duplicated-by-id list — there is exactly one such list because ids are unique by construction, not because the picker merges anything itself.

Status: accepted, first-cut. Written ahead of WI #383/#386/#387's implementation, per Feature #380's own instruction to record this decision when those phases start.
