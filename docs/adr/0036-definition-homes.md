# Definition homes: server library, server workspaces, and library repos

WI #383/#386 (Feature #380, Definition Editor phases 3 and 6). Before this
work, "the definitions" meant exactly one thing: the server's own packaged
`definitions/` directory. Phase 3 (WI #383) added a second kind of place a
definition can live — a workspace's own `definitions/` folder, so an author
can build or vendor a definition without it ever landing in the shared
server library. Phase 6 (WI #386) added a third — a **library repo**, an
Azure DevOps repo an author registers in Global Settings purely as a
read source, unioned into the server library alongside the packaged
directory. This ADR records the shared decision underneath all three: what
a **definition home** is, how an id resolves to one, and what "no
shadowing" means once there is more than one.

## Decision

### Home kinds

A definition home is one of:

- **`library`** — the server's packaged/configured `definitions/` directory
  (`definitionsDir`, unchanged from before this work).
- **`server-workspace`** — a server workspace's own `definitions/` folder
  (ADR-0031's on-disk layout), read and written directly on the local
  filesystem exactly like the library, via the same `lib/definition.js`
  functions (`serverWorkspaceDefinitionsDir` in `lib/definitionHome.js`).
- **`azure-devops-workspace`** — an Azure DevOps workspace's own
  `definitions/` folder, living in that workspace's own repo instead of on
  the local filesystem. Reached over the network with the caller's own PAT,
  the same credential seam `lib/instance.js`'s Azure-DevOps-backed
  instance-data functions already use, via `lib/definitionAzureDevOps.js`.
  Every write is one `client.writeFiles` call — one push, one commit,
  straight to the workspace repo's `main` — **not via stage branches or
  PRs**, unlike instance data's own per-stage-branch lifecycle (ADR-0014):
  a workspace definition has no review gate of its own to preserve, and the
  workspace repo is already the author's own space.
- **`library-repo`** (WI #386) — an Azure DevOps repo registered in Global
  Settings purely as an additional **read** source for the server library,
  alongside the packaged directory. Read with the server's own PAT
  (`GANTRY_LIBRARY_PAT`, resolved once at server startup — never a
  per-browser credential, since a library repo is read by the server
  itself, before any browser request exists), and mirrored to a real local
  `definitions/`-shaped cache directory
  (`<instancesDir>/library-cache/<repoId>/definitions/...`,
  `lib/libraryCache.js`) rather than a bespoke blob — so every existing
  `:id`-keyed route (versions, rendering, instance creation, ...) works
  against it completely unchanged, exactly like a library or workspace row.
  Only a definition's current latest **published** version is cached (never
  full draft/version history): read-only browsing only ever needs one
  snapshot.

### Ids are unique across the server library and every workspace: no shadowing

A definition id can only ever live in **one** home at a time. Creating or
cloning a definition into a home whose id already exists **anywhere else**
— the library, any server workspace, any Azure DevOps workspace already
known to the caller, or any library repo — is rejected as a 409 conflict,
distinct from the pre-existing "already exists in this exact home" 400.
This is "a workspace is a boundary" reasoning applied to *readability*, not
to how a save inside one is committed: the no-shadowing guarantee is what
lets an id, once known, be resolved to a physical location with nothing
left to disambiguate.

### Resolution order

Given just an id, `findDefinitionHomeDefinitionsDir` (`lib/definitionHome.js`)
resolves it in one fixed tier order: the packaged library first, then every
locally-visible server workspace (in `id` order), then every configured
library repo (in configured/insertion order). This is deliberately the same
order `libraryRepoRowsWithProblems` lists in and the same order a clash is
resolved in (see below) — a route resolving `definitionId` to a directory
always agrees with what the Definitions page reports as visible. Azure
DevOps workspaces are not part of this local-only search (no credentials
available to it); a caller that also needs those calls
`lib/definitionAzureDevOps.js` directly with real credentials.

### Library repos are unioned, clashes are dropped and reported, never thrown

`GET /api/definitions` (and every caller of `listDefinitionsAcrossHomes`)
returns the library-repo rows **unioned** into the plain library rows,
always — not gated behind `includeWorkspaces`, since a library repo is a
library source, not a workspace one. An id already claimed by the packaged
directory, a server workspace, or an *earlier* library repo in this same
pass is never overwritten: the clashing row is dropped and reported once as
a `problem` (surfaced on the Definitions page's problems banner), while
every other repo and every other definition in the same clashing repo still
lists normally. A repo with no mirror yet (never successfully refreshed)
contributes no rows and no problems — it simply isn't part of the library
yet, exactly as if it hadn't been added.

### Caching: re-read at startup, on add, and on explicit Refresh — no polling, no TTL

A library repo's mirror is read at exactly three moments: server startup
(fire-and-forget, never awaited — a slow or unreachable repo must not delay
the server listening), when the repo is added in Global Settings, and via
an explicit Refresh button on the Definitions page. Nothing polls on a
timer and nothing carries a TTL. A refresh wholesale-rebuilds that one
repo's mirror directory (delete, then recreate from what was just read),
replacing it only **after** a fully successful read — a network failure
partway through leaves the previous mirror completely untouched, so "a repo
that's currently unreachable simply keeps whatever it last successfully
cached" holds for both browsing the library and for any already-running
instance pinned to one of its definitions.

### Library-repo definitions are read-only in the editor

A library-repo-sourced id is viewable, copyable-from (WI #382's
copy-with-provenance), and clonable into a workspace as a fresh writable
draft (`cloneFromLibraryRepoMirror`) — but never directly editable. Every
mutating `:id`-keyed route rejects a library-repo-sourced id with a 403
before reaching a write (`rejectIfLibraryRepoSourced`, gated on the
*resolved* `definitionsDir` being under the library-cache root,
`isLibraryRepoDefinitionsDir`), regardless of which route reached it — an
author who wants to change one clones it first, exactly as they would clone
any read-only starting point.

## Rationale

- **One `definitionsDir`-shaped reader for every home.** `lib/definition.js`'s
  functions already take a plain directory string and don't care what it's
  a path into. Making a server workspace's folder, and a library repo's
  cache, look exactly like the packaged library on disk means every
  existing route — versions, rendering, instance creation, gate/status
  evaluation — works against all four home kinds with no changes of its
  own, and the YAML shape/validation rules can never drift between homes.
- **No shadowing keeps id resolution a total function.** Once ids are
  guaranteed unique across every home, "which physical directory holds
  this id" has exactly one answer, so no route needs to know or care which
  home an id came from beyond calling one resolver first.
- **A library repo is a read source, not a workspace.** It carries no
  review gate and no author-owned boundary of its own — it is someone
  else's definitions, brought in for reference and reuse. Read-only-in-the-
  editor plus clone-to-edit keeps that boundary explicit instead of letting
  an accidental edit land silently in another team's repo.
- **Cache, don't poll.** A definitions library changes rarely relative to
  how often it's viewed; re-reading only at the three moments that can
  plausibly matter (startup, add, explicit ask) avoids both needless
  network traffic and a stale-looking "why hasn't this updated" surprise —
  the Refresh button makes the one remaining case an explicit, visible
  action rather than a silent background poll.

## Alternatives considered

- **A single global id-uniqueness registry file**, written to on every
  create/clone instead of checked live across homes. Rejected: a separate
  source of truth that could drift from what the filesystem actually holds
  (e.g. after a manual copy into a workspace folder), for no benefit over
  a live existence check that's already cheap at this scale.
- **Polling library repos on a timer.** Rejected: adds background network
  traffic and an unreachable-repo failure mode with no user action behind
  it, for freshness nobody asked for beyond "when I add it" and "when I
  explicitly ask."
- **Letting a library-repo definition be edited directly and pushed back to
  its source repo.** Rejected, out of scope for this phase: the source repo
  belongs to whoever registered it, and pushing an edit into someone else's
  repo needs a review/ownership story this ADR does not attempt to design.

## Status

Accepted. Phase 3 (WI #383) established the `library`/`server-workspace`/
`azure-devops-workspace` home kinds and the no-shadowing guarantee; phase 6
(WI #386) added `library-repo` as a fourth, read-only home under the same
guarantee. Azure DevOps workspace template/reference-docx support and a
library-repo write-back story remain out of scope, left for a later phase.
