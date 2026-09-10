# Server workspace directories replace the legacy server instance

WI #355/#356/#358 (Epic #34). Before this work, an instance's data lived in
one of three places: an Azure DevOps repo (a **server-hosted workspace**,
`gantry-workspace/<slug>/` inside that repo), a folder on the *browser
user's* own machine (a **local workspace**, ADR-0029, never seen by the
server), or a bare directory directly under the server's own `instancesDir`
(the legacy **server instance** — no workspace above it at all). The third
predated workspaces as a concept and could not group more than one instance
together, could not carry a name or description, and forced the dashboard
to show every such instance as its own single-instance "workspace" labelled
*Server instance*. This ADR retires it in favour of a fourth, real kind: the
**server workspace**.

## Decision

### Vocabulary

**Workspace location** gains a second server-hosted kind, alongside **Azure
DevOps workspace**: the **server workspace** — a folder on the box running
`gantry serve`, holding one or more instances. *Local instance* and
*Server instance* (WI #306's dashboard label) are retired from use entirely;
every server-side instance now lives inside some real workspace, Azure
DevOps or server-directory, with no bare/unqualified case left to name.

### Disk layout — same format as a local workspace, on purpose

A server workspace directory is deliberately the **same on-disk format** a
local workspace already uses (ADR-0029), not a new one:

```
<workspaces-root>/<workspace-slug>/
  workspace.json          # { name, description?, kind: "local", createdAt }
  <instance-slug>/
    instance.yaml
    modules/
    assets/
    out/
```

`workspace.json` uses `kind: "local"` — the same value a browser-picked
local workspace's marker file already carries — not a third kind value,
because the two are meant to be byte-for-byte interchangeable: a folder can
be copied from a local workspace into the server's workspaces root, or
copied out of it into a picked browser folder, unchanged. `description` is
new in this ADR (optional; shown as the dashboard's subtitle for that
workspace's row when set).

### The workspaces root replaces the flat `instancesDir`

The server's data root (`GANTRY_INSTANCES_DIR` / `--instances-dir`, default
`instances/`) becomes a **workspaces root**: every server workspace lives
directly under it, and so do the three JSON registries
(`instance-registry.json`, `workspace-registry.json`,
`number-registry.json`) — colocated exactly as before, just one directory
up from where an instance's own files now sit. The new name is
`GANTRY_WORKSPACES_DIR` / `--workspaces-dir`, default `workspaces/`. The old
name keeps working as a deprecated alias, resolving to the identical value
with a one-line deprecation notice logged — nothing breaks for an existing
deployment that hasn't renamed its env var yet.

### Registry shape

`instance-registry.json` was a flat `{ slug: location }` map, which cannot
represent two different workspaces each holding an instance with the same
slug. It becomes scope-nested: `{ [scopeId]: { [slug]: entry } }`, where
`scopeId` is a server workspace's own folder name (or, unchanged, an Azure
DevOps workspace's uuid from `workspace-registry.json`). A directory-backed
entry's `kind` becomes `'directory'` (retiring `'local'`, which meant "bare,
unqualified" and no longer exists as a concept). Slugs are unique **within**
a workspace, not globally, matching how Azure DevOps workspaces already
worked (two different repos could always reuse a slug).

### Migration

A pre-0.4 flat workspaces root — any child directory containing
`instance.yaml` directly, with no `workspace.json` sibling — is not
discoverable by the new registry scan (which only looks inside real
workspace folders). On first start against such a root, `gantry serve`
moves every such bare child into a new, reserved `default` server
workspace, writes its `workspace.json`, and preserves every instance's
existing numbered reference and archived flag exactly. The `default`
workspace keeps the same reserved workspace number (`0`, ADR-0024's
`LOCAL_WORKSPACE_NUMBER`) every pre-migration bare instance's numbered ref
already used, so an old `w0i1`-style bookmark or link keeps resolving to
the identical instance afterward — this is the migration's own highest-risk
guarantee, and it is proven directly by a dedicated test, not just asserted
here. `gantry migrate-workspaces --dry-run` reports the same mapping without
touching disk, for an operator who wants to see it first.

### Addressing

Numbered references (`w<N>i<M>`, ADR-0024) are the canonical URL form and
are completely unchanged in format — a server workspace is numbered exactly
like an Azure DevOps workspace always was. A bare slug that is unique across
every workspace still resolves (logging a deprecation note); one present in
more than one workspace is rejected, naming every `<workspace>/<slug>`
candidate so the caller can disambiguate.

### What stayed unchanged, deliberately

The lower-level functions that actually read and write an instance's files
— `lib/instance.js`, `lib/render.js`, `lib/status.js`, `lib/check.js`,
`lib/stageAdvancement.js` — were not taught anything about workspaces. Each
still operates on one flat directory handed to it as `instancesDir`, exactly
as before this work. All new workspace-awareness lives one layer up, in the
registry (which workspace does this slug belong to) and the request-routing
layer (`lib/server.js`'s `resolveLocalDataDir`, resolving a slug's concrete
directory per request rather than assuming one fixed location) — a
deliberately contained blast radius rather than a rewrite of the engine's
own file-handling code.

## Rationale

- **One format, not two.** Making a server workspace directory identical to
  a local workspace folder (same `workspace.json`, same layout) means the
  two are genuinely interchangeable, and any future tooling that
  understands one already understands the other.
- **Grouping was the actual gap.** The legacy server instance could never
  express "these two instances belong together" — exactly the situation
  Gantry's own bundled examples needed once a second instance joined the
  first (WI #358).
- **Backward compatibility is a hard requirement, not a nicety.** A
  numbered URL is meant to be a stable, bookmarkable reference (ADR-0024);
  migration silently breaking every existing one would defeat that
  guarantee. Reserving workspace number `0` for the migrated `default`
  workspace was chosen specifically to avoid needing any renumbering step.
- **Keep the engine's own read/write code ignorant of workspaces.** Every
  other option considered threading a workspace argument through
  `lib/instance.js`/`lib/render.js`/etc. themselves, which would have
  touched the majority of the repo's test suite for a change that is really
  about *where* a flat directory sits, not how one is read.

## Alternatives considered

- **A third `workspace.json` `kind` value for server-directory workspaces.**
  Rejected: would have made the two formats subtly incompatible for no
  benefit — nothing actually differs between a folder the server owns and
  one a browser owns except who is holding the handle.
- **Renumbering every migrated instance instead of reserving workspace
  number `0`.** Rejected: breaks every bookmarked/linked numbered URL a
  real deployment might already have in the wild, for a cosmetic win
  (a "real" sequential number instead of the reserved `0`).
- **Teaching `lib/instance.js` et al. about workspaces directly** (a
  `workspace` parameter alongside `slug` on every read/write function).
  Rejected: a far larger, riskier diff across the engine's own core, for
  the same observable result the registry/routing-layer approach achieves
  with a contained change.

## Status

Accepted. Supersedes the "legacy local instance" / "Server instance"
vocabulary note in ADR-0029 — see this ADR's own Vocabulary section instead.
Azure DevOps workspaces (ADR-0005, ADR-0010, ADR-0008) and their
`gantry-workspace/<slug>/` repo layout are unaffected and out of scope here.
