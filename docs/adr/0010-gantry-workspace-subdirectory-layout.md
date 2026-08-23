# Azure-DevOps-backed instance data lives at `gantry-workspace/<slug>/`, not repo root

ADR-0005 moved an Azure-DevOps-backed instance's data (`instance.yaml`, `modules/`) into its
own external Azure DevOps repo, and ADR-0008 built the registry that routes a slug to that
repo — but both left the whole repo as necessarily *exactly one instance's* data, files sitting
directly at repo root. #96 then introduced the **workspace** as a first-class entity — an
Azure DevOps organization/project/repository, distinct from any one instance — precisely so
several instances could one day share one workspace, deferring the storage-layout change itself
to this ticket.

This is that change. An instance's data now lives at `gantry-workspace/<slug>/instance.yaml` +
`gantry-workspace/<slug>/modules/` inside its workspace's repo, rather than at repo root. A new
instance is always written directly into this subdirectory layout — including a workspace's
second and subsequent instances, which simply get their own `gantry-workspace/<other-slug>/`
alongside the first. A repo still holding data from before this change (a lone `instance.yaml`
at repo root, from when the whole repo was necessarily one instance) is migrated into the new
layout automatically, the first time `checkAzureDevOpsRepo` reads it — on the setup wizard's
"Check repo", or a `POST /api/instances/adopt` — so no repo is ever left holding both the old
root-level copy and the new subdirectory copy at once: each module's old copy is deleted as soon
as its new copy is written, but the legacy root `instance.yaml` itself — the one signal
`checkAzureDevOpsRepo` uses to decide a repo still needs migrating at all — is deliberately kept
until every module has been migrated, and only removed last. Deleting it any earlier would let a
failure partway through the modules loop (a network blip, an expired PAT) leave the repo looking
fully migrated to any later check while some module data was still silently stranded, unreachable,
at its old path; keeping it until last means a retry after such a failure is recognized as
"still legacy" and safely resumes, re-processing only whatever modules didn't already move. The
same migration logic is also exported on its own (`migrateLegacyAzureDevOpsInstance`,
`lib/repoCheck.js`) as an explicit routine a caller can invoke directly, independent of that lazy
on-first-access path — including safely a second time against an already-fully-migrated repo,
since the final legacy-`instance.yaml` delete is skipped (not treated as an error) once that file
is already gone.

Discovering "what instance(s) live in this repo" without already knowing a slug — needed by the
setup wizard's repo-check and by adopt, neither of which take a slug as input — now means listing
the `gantry-workspace/` directory (a new `listFolder` capability on `lib/azureDevOpsClient.js`,
alongside a `deleteFile` the migration routine needs) rather than probing one fixed path. A repo
holding exactly one instance there resolves the same as before; a repo already holding more than
one is reported as a distinct `{ result: 'multiple', slugs }` outcome rather than guessing — since
neither the repo-check route nor the adopt route has a slug of its own to disambiguate with, that
disambiguation is left for a later ticket's Settings/multi-instance UI (#101/#104) to build a real
slug-selection entry point for, rather than invented here without one.

A discovered slug is validated (the same single-path-segment check every client-supplied slug
already goes through) *before* it's ever used to build a `gantry-workspace/<slug>/` path — a
legacy `instance.yaml` with a missing or malformed `slug` field (untrusted content from the
target repo itself, not something gantry wrote) is reported as found-but-unresolved rather than
migrated or read from a path built out of that untrusted value, preserving the same
path-traversal protection this registration flow already had before this ticket.

Alternatives considered and rejected:

- **Require a slug up front for repo-check/adopt, instead of discovering it.** Would let this
  ticket's own storage change also solve the "which of several instances" UI problem in the same
  pass, but that's real, separate UI work (a slug-picker, not just a query param) — folding it in
  here would block a already-scoped storage migration on product design for a screen that doesn't
  exist yet. Left as `{ result: 'multiple', slugs }` for that later ticket instead.
- **A multi-file-commit rename in one push, instead of write-then-delete per file.** Azure
  DevOps's push API does support a `rename` changeType, which would make each file's move a
  single push instead of two — a real potential simplification, not pursued here only because
  `createInstance`'s own Azure DevOps path (ADR-0005/#85) already accepted "not atomic across
  files, one push per file" as its shape; migration follows that same established shape rather
  than introducing a second, different multi-file-push convention alongside it in the same
  client.
- **Leave legacy root-level repos unmigrated, reading both root and `gantry-workspace/` forever.**
  Rejected: #100's own acceptance criteria rule out a repo ever holding data at both locations,
  and a permanent two-shapes-forever read path is exactly the kind of `required-at`-style
  duplication this repo's own domain docs warn against elsewhere (see CONTEXT.md's "Module
  completeness by gate, not by authorship" entry) — one storage shape going forward, not two.

Status: accepted.
