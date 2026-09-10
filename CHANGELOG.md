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
