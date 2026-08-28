# Scoped numeric references, layered over existing slugs/ids

WI200 asks for a short numeric reference for workspaces, instances, and
stages, usable in URLs, with "default to first" behavior when a URL omits
the more specific parts (workspace only → its first instance; instance only
→ its first stage). Today none of these three entities has a numeric
identifier: instances are keyed by a string slug (which is also the on-disk
directory name and the Azure DevOps registry key), workspaces get a
`randomUUID()`, and stages are keyed by a string `stage.id` from the
definition YAML — embedded directly in every Stage branch name
(`gantry-workspace/<slug>/<stageId>`). Several real, hard-to-reverse
decisions follow from how a new numeric scheme relates to these existing
identifiers.

**Decision**:

1. Numeric references are **scoped to their parent**, not global: instance
   numbering restarts at 1 within each workspace; stage numbering follows
   each instance's own definition order (stage 1 is that instance's first
   stage). Workspace numbering, having no parent, is a single global
   sequence.
2. Numeric references are a **new lookup layered on top** of today's
   identifiers — mirroring the precedent `workspaceRegistry.js` already
   sets for workspace UUIDs. Slugs and stage ids are unchanged and remain
   the actual storage keys, directory names, and Stage branch components.
   Nothing is renamed.
3. Numeric references become the **primary/canonical form Gantry generates
   and displays in URLs**, not just an alternate accepted input. The
   existing slug/stage-id query params keep working as a fallback so
   existing bookmarks and links (including ones already posted in Azure
   DevOps work item descriptions and PR bodies) don't break.
4. "First instance" ordering needs a real, tracked creation-order field —
   today's incidental alphabetical-by-slug listing order isn't anyone's
   actual choice and would produce numbering that reshuffles if a slug's
   naming convention changes.
5. Numeric references are shown in the UI (not purely a URL-addressing
   detail) — a reference meant to be shared/cited should be discoverable on
   screen, not something a user can only find by reading the URL bar.
6. Existing workspaces/instances (created before this feature ships, with
   no tracked creation order) are backfilled once, using each entity's
   underlying storage timestamp as a best-effort proxy for real creation
   order, rather than alphabetical-by-slug. These numbers become permanent
   shared references once assigned, so the one-time backfill favors a
   closer approximation of true order over a free but arbitrary one.

Alternatives considered and rejected:

- **Global numbering for instances/stages** — rejected: doesn't match the
  ticket's own "start from 1" / "default to first" wording, which only
  makes sense as a per-parent ordinal (a workspace's first instance being
  numbered anything other than 1 defeats the point).
- **Renaming slugs/stage-ids to numbers** — rejected: both are embedded in
  existing on-disk paths, Azure DevOps registry entries, and — for stage
  ids specifically — every already-created Stage branch name. Renaming
  would break every in-flight instance and stage.
- **Numeric ids as an additional accepted form only, without becoming
  canonical** — rejected: the ticket explicitly asks for Gantry to
  *default* to using these references in URLs, which reads as wanting the
  numeric form to be what the app generates, not just an alternate parser.
- **Dropping old slug/stage-id URL support once numeric ids ship** —
  rejected: a cleaner cutover isn't worth breaking every existing bookmark
  and any link already posted in Azure DevOps comments or PR descriptions
  from before this shipped.
- **Backfilling existing entities alphabetically by slug** — rejected: once
  assigned, these numbers are permanent, shared references; alphabetical
  order is free but arbitrary, while a storage-timestamp proxy is a closer
  approximation of what people will actually assume "instance #1" means.

Status: accepted.
