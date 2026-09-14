# Local workspaces: instance data on the browser user's own machine

WI #292 (Feature #290, child A1). Today an instance's data lives in one of
two places: on the server running `gantry serve` (a legacy **local
instance**, stored under `instancesDir`), or in an Azure DevOps repo (a
**server-hosted workspace**, `gantry-workspace/<slug>/` inside that repo,
reached with the server's PAT). Neither lets an end user keep instance data
on *their own machine* while gantry itself is hosted on a shared server —
the data is always either on the box or in a repo the box can reach. This
ADR adds a third **workspace location**: **Local**.

## Decision

### Vocabulary

The wizard gains one axis: **Workspace location: Server-hosted | Local**.
"Workspace-backed" is retired from new text — say **server-hosted
workspace** or **local workspace**.

A **local workspace** (this ADR) is a folder on the *browser user's*
machine, picked in the browser and never seen by the server. It is a
different concept from the legacy server-side **local instance**
(`instancesDir` on the box running `gantry serve`). The two senses of
"local" must not blur: one is client-side storage the server has no handle
on, the other is server-side storage. New text names the concept in full —
"local workspace" or "local instance" — and never bare "local" where the
sense is ambiguous.

> **Superseded (ADR-0031, WI #358):** the legacy server-side **local
> instance** described above no longer exists — every server-side instance
> now lives inside a real **server workspace** directory, which
> deliberately shares this ADR's own `workspace.json` format. Where this
> ADR contrasts "local workspace" against "local instance", read the latter
> as historical context for why the vocabulary is precise, not as a
> concept still in use — see ADR-0031 for the current shape.

### Transport — File System Access API

The browser reaches the picked folder through the **File System Access
API** (`showDirectoryPicker()` and the `FileSystemDirectoryHandle` it
returns). This API is **Chromium-only** — Chrome and Edge. In Firefox and
Safari the Local option is offered but disabled, with a clear message:
"Local workspaces need Chrome or Edge." Those browsers can still use
server-hosted workspaces with no loss of function.

### Client-only registry

The gantry server holds **no record** that a local workspace exists. There
is no entry in `lib/workspaceRegistry.js` or `lib/instanceRegistry.js`, no
row in any registry JSON, no numeric reference (see Addressing).

Two things stand in for a server-side registry:

- **`workspace.json` at the workspace root** is the portable source of
  truth: `{ name, owner, kind: "local", createdAt }`. No `ticketingSystem`
  key — local workspaces have no ticketing (see Ticketing). Any Chromium
  browser that picks the folder can read this file and know what it is.
- **IndexedDB in the browser** caches the `FileSystemDirectoryHandle`s and
  a "recent local workspaces" list so the picker can re-offer folders the
  user has opened before. This is a per-browser convenience cache only. It
  is never sent to the server, and a different browser or machine starts
  with an empty list and re-picks the folder.

### Disk layout

A local workspace mirrors the server-hosted (Azure DevOps) layout exactly:

```
<picked>/gantry-workspace/
  workspace.json
  <slug>/
    instance.yaml
    modules/
    out/
    assets/
```

Because the layout is identical, a picked folder can be a plain `git clone`
of a server-hosted workspace's repo — the same bytes work in both
locations.

### Compute stays server-side

The browser does no gantry compute. It shuttles file contents to a new set
of **stateless** `/api/local/*` endpoints, which run the existing `lib/`
logic — status, gate check, validate, render — inside a sandboxed temp
directory and return the result. For `.docx` render the bytes round-trip:
the browser sends the file tree, the server returns the rendered document,
and the browser writes it back into the folder through the directory
handle.

The existing `/api/instance*` routes are untouched; `/api/local/*` is
additive.

**Security.** A hosted gantry now accepts a caller-supplied file tree on
these routes. Each request is unpacked into its own temp directory, deleted
when the request completes; nothing is persisted between requests. Payload
size and file-count caps apply. Any path that resolves outside the temp
root is rejected. The server never writes the caller's tree anywhere
durable.

### Definitions

A local workspace can either pin an instance to the server's bundled
`definitions/` (resolved server-side exactly like every other instance) or
ship its own definition inside the picked folder, at
`definitions/<id>/<version>/definition.yaml` + `modules/*.yaml` +
`templates/*.md.tmpl` + `templates/reference-<artefactId>.docx` (WI #384).
A workspace-authored definition is created, edited, validated and published
entirely client-side — `/definitions/local?ws=<id>` (`web/pages/local-
definition-editor.js`) reads and writes those files straight through the
File System Access API, calling the stateless `POST
/api/local/definition/validate` round trip only to reuse the server's
existing structural-validation rules; the definition itself is never
uploaded or persisted server-side. Because such a definition never lives in
the server's bundled `definitionsDir`, an instance pinned to one carries its
content inline on every `/api/local/*` request that needs it (render,
compile, gate check), materialized into that request's throwaway sandbox
next to the instance's own files — a library-pinned instance is unaffected
and leaves that inline payload unset.

### Addressing

Local workspaces are addressed by **slug only**. There is no global
workspace number — the ADR-0024 numeric sequence is server-side registry
state and stays there. Instance and stage ordinals are still available:
they are computed client-side from the definition's stage order and the
list of instances found in the folder, not read from a registry.

### Ticketing

Local-workspace instances have **no ticketing**. No work-item link step in
the wizard, no "Check gate & sync work item", no "Request sign-off" /
"Check status", no review or sign-off ceremony. They advance self-serve the
moment the current stage's gate passes — the same rule a legacy local
instance follows — with no stage branches, no Pull Request, and no
re-open ceremony.

### Offline

Editing module files and saving them works with no server at all —
every read and write goes through the directory handle. Gate check,
validate and render still need the server (that is where the compute
lives).

## Rationale

- **A real third location, not a workaround.** Users who want their data on
  their own disk, with gantry hosted centrally, have no path today. Making
  "where the data lives" an explicit wizard axis is clearer than another
  implicit mode.
- **Nothing on the server to leak or lose.** With no server-side registry
  entry, a local workspace cannot be half-registered, cannot be
  orphaned when a folder moves, and carries no server state to migrate.
  `workspace.json` travels with the folder; IndexedDB is a rebuildable
  cache.
- **Layout parity buys interop for free.** Mirroring the Azure DevOps
  layout means a folder can move between a local workspace and a
  server-hosted repo with a `git clone` / `git push`, and the same `lib/`
  code renders both.
- **Compute where the dependencies already are.** Gate/validate/render
  already run server-side and depend on Pandoc for `.docx`. Keeping them
  there means the browser only moves bytes.
- **Self-serve advancement matches the trust model.** A local workspace has
  no shared Azure DevOps repo to gate against and no board to track, so the
  legacy local-instance rule — passed gate permits an explicit advance —
  is the right fit.

## Alternatives considered

- **A local companion CLI the browser talks to over localhost.** Rejected:
  forces every client to install and run a process, which defeats the
  point of a hosted gantry.
- **Upload / download round-trips with `<input webkitdirectory>` + a zip.**
  Rejected: no live sync — the user re-uploads the whole tree on every
  change and re-downloads to get results — and the zip dance is clunky.
- **Port gate / validate / render compute to client-side JS.** Rejected:
  a large reimplementation, and Pandoc `.docx` rendering cannot move to the
  browser at all.
- **Registry only in IndexedDB, with no `workspace.json` marker in the
  folder.** Rejected: the folder could not then be validated as a gantry
  workspace or reopened from another browser or machine — the portable
  marker is what makes the folder self-describing.

## Status

Accepted. "Advanced mode" (Feature #291) is a separate, later feature and
is out of scope here.
