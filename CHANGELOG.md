# Changelog

Release notes for Gantry itself — one section per tagged release, newest first.
Written for the people who *run* Gantry, including anyone who never reads the
repository and has no Azure DevOps access to read instead.

Not to be confused with `definitions/<id>/<n>/CHANGELOG.md`, which is a different
thing entirely: those describe changes to a *design definition* (modules renamed,
sections restructured) for the people authoring against it, and are surfaced in
the app. This file describes changes to the application.

**Maintaining it is a release requirement, not a courtesy.** Every version bump
adds a section here in the same commit, and `tests/changelog.test.js` fails the
build if the version in `package.json` has no entry. See
`docs/agents/release-process.md` for the full convention.

Versions are the `package.json` version; each is tagged `v<version>` on its merge
commit on `main`.

## 0.5.1-beta — 2026-09-13

### Changed

- **You can always see which pane you are typing in** (WI #375). The editor
  pane that has focus now carries a thick frame — including while you are
  typing in one of its Visual table cells — and in Split view the other pane
  fades back, so it is obvious whether you are editing the Markdown or the
  Visual side.

## 0.5.0-beta — 2026-09-13

### Added

- **Visual view: edit a field the way it reads** (WI #374). Markdown fields now
  open in a new **Visual** view, where headings, bold and italic, code, quotes,
  links, images and Mermaid diagrams are drawn as they will appear and edited in
  place. Tables are real grids: click any cell to type, Tab between cells (Tab
  from the last cell adds a row), hover a table's top or left edge for column
  and row handles that insert, delete, re-align and — by dragging — move columns
  and rows, and use the corner handle to delete the whole table. A diagram's
  text is edited from an **Edit diagram text** pop-over. Nothing about how your
  content is stored changes: a field you open and save without editing is
  written back byte for byte, and editing one table cell changes only that row.
- **Undo and Redo on the formatting toolbar**, covering every change in a field
  whichever view it was made in.

### Changed

- **The view switcher is now a Mode ▾ dropdown: Visual, Split, Markdown**, with
  Visual the default. Split now shows the raw Markdown beside the Visual view,
  both editable, with one formatting toolbar that acts on whichever side you are
  working in. `Ctrl+Shift+V` cycles the three views in that order.
- **Rendered view is gone** — Visual replaces it. Editing controls are now hidden
  only on an archived instance, which is read-only in every view.
- In **Markdown** view the table button strip still appears while the caret is
  in a table; Visual and Split use the table's own handles instead.

## 0.4.10-beta — 2026-09-11

### Fixed

- **Gantry's commands now work wherever you run them** (WI #371). `gantry
  definitions` reported "No definitions found." and `gantry new design
  my-initiative` failed with "Definition "design" has no version 1" unless the
  directory you happened to be standing in was a copy of the Gantry source
  repository. The definitions that ship with Gantry are now found from any
  directory, the way `gantry serve` already found them. If the directory you're
  in has a `definitions/` folder of its own it still takes precedence, so
  working inside a Gantry checkout is unchanged, and `--definitions-dir <path>`
  names one explicitly.
- **A missing definitions folder says so** (WI #371), instead of reporting the
  definition itself as having no version 1 — which sent you looking at the
  definition when the problem was that Gantry never found a definitions folder
  at all.

## 0.4.9-beta — 2026-09-11

### Fixed

- **The command line can see your instances again** (WI #370). `gantry
  instances` reported "No instances found." in a directory that plainly had
  them, and `gantry status`, `gantry check` and `gantry render` failed outright
  on any instance you hadn't pointed them at by hand. Gantry 0.4 moved where
  instance data is stored — into a workspace folder, one level deeper than
  before — and the web app was taught the new layout while the command line was
  not, so the two disagreed about the very same directory. They now share one
  answer, and the command line lists exactly what the dashboard does.
- **An instance you create on the command line survives starting the web app**
  (WI #370). `gantry new` wrote its instance in the old location; the first
  `gantry serve` moved it to the new one; after that the command line could no
  longer find the instance it had just made. `gantry new` now creates instances
  where the web app already puts them, so nothing is moved and nothing goes
  missing. Instances made before this change are picked up automatically.
- **`gantry validate --version` and `gantry new --version` work again**
  (WI #370). Since 0.4.8-beta these were being read as a request for Gantry's
  own version number: the command printed `0.4.8-beta` and did nothing else.
  They once again mean the *definition* version, and `gantry --version` still
  reports the build you're running.
- **`gantry backfill-numeric-refs` now runs against the directory you point it
  at** (WI #370). It always used the pre-0.4 location regardless of
  `--workspaces-dir` or `GANTRY_WORKSPACES_DIR`, so it reported nothing to do
  while leaving real instances unnumbered.
- **Errors read like errors** (WI #370). A mistyped instance or definition name
  printed a page of internal Node detail. It now prints one line saying what
  was wrong — and, when an instance isn't found, which ones do exist. Set
  `GANTRY_DEBUG=1` if you want the full technical detail back.
- **`gantry serve` no longer leaves uncommitted changes behind** in a Git
  checkout of Gantry itself (WI #370).

### Added

- **`gantry definitions`** (WI #370) — previously a placeholder that printed
  "not yet implemented". It lists the definitions available to you with their
  stages and versions, and takes `--json` like the other listing commands.
- **Workspace-qualified names on the command line** (WI #370). Instances are
  now listed as `workspace/slug`, and any command taking an instance name
  accepts that form. It matters when the same name exists in two workspaces:
  previously one was picked silently, and now Gantry says which two it found
  and asks you to be specific.

## 0.4.8-beta — 2026-09-11

### Added

- **`gantry --version`** (WI #369). There was no way to ask Gantry which build
  you were running — the flag simply didn't exist — which made "did my upgrade
  take effect?" surprisingly hard to answer. `gantry --version` (or `-V`) now
  reports it, and reports it for the install actually being run, even when
  that's a symlink on your PATH invoked from somewhere else entirely.
  `gantry new --version` and `gantry validate --version` are unchanged and
  still refer to a *definition* version.

## 0.4.7-beta — 2026-09-11

### Fixed

- **Upgrading Gantry no longer leaves an open browser tab running the old
  version** (WI #368). If you had Gantry open in a tab, upgraded the server and
  carried on in that same tab, the page could keep running the *previous*
  version's code against the new server — with no sign anything was wrong, and
  no fix other than a hard reload nobody knew to do. It also made "did my
  upgrade actually take effect?" impossible to answer from the outside. Pages
  and scripts now tell the browser to check with the server before reusing
  them, so an upgrade is picked up on the next navigation. Unchanged files are
  still not re-downloaded, so this costs nothing in day-to-day use.

## 0.4.6-beta — 2026-09-11

### Fixed

- **Diagrams you upload are no longer missing from rendered Word documents**
  (WI #367). An image looked right in the Gantry preview but came out of the
  .docx blank — silently, with the render reporting success. Mermaid diagrams
  were unaffected, which made it look like a content problem rather than a
  rendering one. The cause was the browser-based render engine: it was told
  where each image lived on the *server's* disk, which means nothing inside a
  browser, so Word documents were built with the pictures left out. The images
  now travel to the browser with the document text. Nothing to change in your
  own instances, and anything you rendered without its diagrams just needs
  rendering again. This affected server-hosted instances from 0.4.1-beta
  onward, and Azure DevOps-backed instances for longer.

## 0.4.5-beta — 2026-09-11

### Fixed

- **Instances in different workspaces can now share a slug** (WI #366). Two
  workspaces each holding an instance with the same name used to break: the
  server looked a slug up by searching every workspace for it, and when more
  than one matched it gave up rather than choosing, so that instance could not
  be opened at all and there was no way to say which one you meant. The server
  now resolves an instance within the workspace it actually belongs to, so
  identical slugs in different workspaces are no longer a collision. Nothing to
  change in your own workspaces — existing links, bookmarks and numbered
  references keep working exactly as before.
- **The log no longer fills with deprecation notices you could not act on**
  (WI #366). Running Gantry logged `resolved via a bare, workspace-unqualified
  slug (deprecated, WI #356)` on essentially every request, recommending a
  `<workspace>/<slug>` form that the server did not actually accept. That form
  now works, the app uses it, and the notice is back to meaning what it says —
  something addressed the old way and can be moved to the new one.

## 0.4.4-beta — 2026-09-10

### Changed

- **The built-in "Gantry hosting" example now says what Gantry's own build
  pipeline does and does not check for security** (WI #365). This is the
  example text the Solution Design editor offers at the SOAP stage, so it is
  the wording other people start from. It previously said nothing about the
  assurance behind the container image the proposal runs, which invited the
  assumption that a pipeline-built image had been security reviewed. It has
  not been: the build gates every merge on the full test suite, coverage
  thresholds and a successful render, and performs no static analysis, no
  dependency vulnerability scan and no image scan. The example now states
  that plainly — including the hardening that *is* real (production
  dependencies only, non-root runtime, no public endpoint) — carries the
  missing scanning as an estimate caveat, and raises it as an open question
  owned by the network and security team rather than presenting it as
  something already done.

## 0.4.3-beta — 2026-09-10

### Fixed

- **The "Source:" citation under a diagram now opens the file it names**
  (WI #364). Clicking the citation beneath an embedded diagram appeared to do
  nothing useful: the address bar changed to the asset's file address, but the
  Workspaces home screen came up instead of the image — and any unsaved edits
  in the module you were in went with it. The click was never leaving the
  browser: the app was treating the link as a move to another screen, found no
  screen at that address, and fell back to the dashboard. The file itself was
  being served correctly the whole time. Citations now open in a new tab, so
  the file loads and you keep your place — and your unsaved edits — in the
  module editor. Any other link in a module's text behaves the same way; only
  in-page links to a heading still jump within the page.


## 0.4.2-beta — 2026-09-10

### Fixed

- **The Full Solution on a Page no longer carries the HLD's committee footer**
  (WI #363). Every page of a Full SOAP rendered to Word was footed
  "Technical Architecture Committee – High Level Solution Design" — a
  governance body that document never goes to, on a document people were
  circulating for a decision. The Full SOAP now uses the same neutral footer
  as the Solution on a Page (page number and the Contoso strapline); the HLD is
  still footed with the Technical Architecture Committee, which is correct
  for it. Re-render any Full SOAP you have already produced to pick up the
  corrected footer — the fix is in the template, not the document. This
  affects both the installed-Pandoc and the in-browser render, and both
  published versions of the Solution Design definition.
- **A new artefact can no longer silently inherit another artefact's footer.**
  The shared fallback template every artefact falls back to when it has no
  template of its own no longer names any committee, and the build now fails
  if an artefact is added without its own Word template — so the next
  artefact cannot repeat this.

## 0.4.1-beta — 2026-09-10

### Added

- **A docx/md toggle in the Render dialog** (WI #359). A new radio choice sits
  immediately left of the Render button, defaulting to docx. Choosing md
  renders only the Markdown — no `.docx` is produced at all — and choosing
  docx (the default) no longer leaves a stray `.md` file behind next to it;
  the Markdown is still compiled as an internal step (Pandoc needs it), but
  it's no longer written anywhere. This applies across every instance kind
  and both render engines. Mermaid diagrams keep rendering correctly either
  way — as an image in the docx, as the original fenced code in the md.

### Changed

- **Rendering a server-hosted instance now downloads the file to your browser
  instead of saving it into the repository** (WI #360). Previously, clicking
  Render on an instance stored under a `workspaces/<workspace>/` directory on
  the server wrote the result into that instance's own `out/` folder, the
  same way an Azure DevOps-backed instance's render is pushed to its repo.
  That made sense for Azure DevOps, where `out/` is the shared, durable
  record — but for a server-hosted instance there was no equivalent reason to
  persist it there, and it meant this second copy is what a browser download
  now replaces. Nothing changes for an Azure DevOps-backed instance (still
  pushed to the repo) or a local workspace opened in the browser (still
  written into the folder you picked) — this is specific to the server-
  hosted case introduced by the workspace-directories work (WI #355-358,
  0.4.0-beta).

## 0.4.0-beta — 2026-09-10

### Added

- **Server workspace directories** (WI #355/#356/#358, `docs/adr/0031-server-workspace-directories.md`).
  A server-hosted instance's data now lives inside a **server workspace** — a
  folder with its own `workspace.json` (the same format a Local workspace
  already uses, plus an optional `description`), holding one or more
  instances — instead of the old flat `instances/<slug>` layout with no
  grouping above it. Two different server workspaces can each have an
  instance with the same slug; the dashboard shows one row per workspace,
  with every instance — server workspace or Local workspace alike — getting
  the same full status card (stage, complete/incomplete badge, assignee,
  updated, Edit/Check).
- **`GANTRY_WORKSPACES_DIR` / `--workspaces-dir`** replace `GANTRY_INSTANCES_DIR`
  / `--instances-dir` as the primary way to point Gantry at its data,
  default `workspaces/`. The old names keep working everywhere, resolving
  to the same value with a one-line deprecation notice logged — nothing
  breaks for an existing install that hasn't switched yet.
- **Automatic migration.** The first time `gantry serve` starts against a
  pre-0.4 flat data directory, every bare instance directory it finds moves
  into a new, reserved `default` server workspace, preserving every
  instance's numbered reference and archived state exactly — a bookmarked
  or linked `w0i1`-style URL keeps working unchanged. `gantry migrate-workspaces
  --dry-run` shows the same mapping first, without touching anything.
- The bundled example data moves onto the new shape: `workspaces/examples/`
  now holds both `kiwi-cover-mutual` (the Kiwi Cover Mutual worked example,
  previously the single `examples` instance) and `gantry` (Gantry's own
  hosting SOAP, WI #354) — one workspace, two instances, matching what the
  dashboard shows.

### Changed

- CLI commands (`new`, `status`, `check`, `render`, `instances`, `serve`)
  all resolve their data directory through the new `--workspaces-dir` /
  `GANTRY_WORKSPACES_DIR` precedence, with `--instances-dir` /
  `GANTRY_INSTANCES_DIR` kept working as deprecated aliases.

## 0.3.1-beta — 2026-09-10

### Changed

- **The bundled `gantry` example now proposes Azure Container Apps instead of
  virtual machines** (WI #354). Engineering review pointed out that Container
  Apps provides the load balancing, health probing, always-on replicas,
  revision-based deployment and log collection that the VM design would have
  assembled by hand, so the Full SOAP's overview, topology diagrams, feature
  breakdown, dependencies, sequencing, caveats and open questions were rewritten
  around it. The VM design stays in the Alternatives sketch as the rejected
  option. No application behaviour changes in this release.

## 0.3.0-beta — 2026-09-10

### Added

- **Mermaid diagrams render in the preview and in exported Word documents**
  (WI #353). Put a fenced ```` ```mermaid ```` block in any markdown field
  and the editor preview shows the diagram instead of the source. When you
  Render with the default WASM engine, the `.docx` carries the diagram as an
  image; the `.md` written beside it keeps the Mermaid source so it stays
  editable. A block Mermaid cannot parse stays as source with a short error
  note under it, and never stops the rest of the render. Two limits to know
  about: the Native Pandoc engine and the `gantry render` command still
  export the block as source text, and HTML markup inside diagram labels is
  not supported.

## 0.2.3-beta — 2026-09-09

### Removed

- **The zip-release install path has moved off `main`** (WI #352). `install.cmd`,
  `run.cmd` and the pipeline that packaged them into a downloadable zip now live
  on the `zip-release` branch, cut from `main` at 0.2.2-beta. Nothing about a
  normal install changes: clone the repository, `npm install`, `npm link`, then
  `gantry serve` — the same on Windows, macOS and Linux. If you installed from a
  zip or used `install.cmd`/`run.cmd`, that copy keeps working and keeps getting
  fixes on the `zip-release` branch, but releases from `main` no longer produce a
  zip. The corporate-proxy guidance those scripts automated is still in
  README.md as the manual `NODE_USE_SYSTEM_CA` step.

## 0.2.2-beta — 2026-09-09

### Fixed

- **A TLS-inspecting corporate proxy no longer breaks `install.cmd`** (WI #350).
  Behind Zscaler, the installer downloaded the portable Node ZIP fine and then
  died on the first npm tarball with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`: the
  proxy re-signs every HTTPS response with a CA that Windows trusts but Node does
  not, and curl (which uses the Windows store) sailed through while npm did not.
  `install.cmd` and `run.cmd` now set `NODE_USE_SYSTEM_CA` themselves and export
  the Windows root stores to `.node-runtime\windows-ca.pem` for
  `NODE_EXTRA_CA_CERTS`, so the documented manual `setx` step is no longer
  needed — it was easy to apply and still have no effect, because `setx` only
  reaches processes started afterwards. Both mechanisms only *add* trust anchors;
  certificate verification stays on, and nothing is written to the user's
  persistent environment or the registry. `run.cmd` gets the same treatment
  because the same proxy would otherwise break Gantry's own Azure DevOps calls at
  runtime.

## 0.2.1-beta — 2026-09-08

### Fixed

- **Local instances render through WASM Pandoc rather than native Pandoc**
  (WI #349). A local instance's render went down the native path and failed with
  `spawnSync pandoc ENOENT` on a zip-release install, where no native Pandoc is
  present — despite the web UI defaulting to the in-browser WASM engine
  everywhere else.

## 0.2.0-beta — 2026-09-08

### Changed

- **The `examples` fixture is now a fully populated design v2 mock** — Kiwi Cover
  Mutual, exercising every diagram in the SAD template, with local-file asset
  citations (WI #348). Replaces the previous thin fixture, so the bundled example
  shows what a genuinely complete instance looks like.

## 0.1.2-beta — 2026-09-08

### Added

- **Definition Reference Guide (Contoso Solution Design)** in the in-app User Guide
  (WI #347).

## 0.1.1-beta — 2026-09-04

### Fixed

- Local-workspace asset images, plus two zip-release install bugs.
- The user guide reconciled against actual app behaviour.

### Changed

- Removed the redundant `slug=` query parameter from local instance URLs.

## 0.1.0 — 2026-09-03

Initial tagged release. Headline capabilities at this point:

- **Local workspaces** — instance data in a folder on the browser user's own
  machine via the File System Access API, alongside server-hosted (Azure DevOps)
  workspaces (ADR-0029).
- **Advanced mode** — hides the Azure DevOps surfaces for people who only ever
  work locally.
- **The `design` definition, version 2** — SOAP, HLD, SAD, SSAD and As-built
  artefacts with per-artefact field-level requirements.
- **WASM Pandoc as the default render path**, with a Settings toggle to native
  Pandoc and automatic fallback (WI #314).
- **`install.cmd` / `run.cmd`** — a no-admin-rights install and one-step launcher
  for locked-down corporate Windows machines, using Node's portable ZIP build
  (WI #327, #332, #335, #336, #337, #338, #339).
- **The zip-release pipeline** — a trimmed, runtime-only, Git-free package for
  machines that can't clone (WI #340).
