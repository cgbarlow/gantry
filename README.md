# Introduction

**Gantry is a repo-driven pipeline for staged, gated processes. Capture the data once; render whatever document the gate asks for.**

Gantry separates the *content* of a process from the *documents* that process produces. You describe a process as a **definition** — its stages, its gates, its module specs — and Gantry runs it. People (or agents) fill in modules as flat files in a Git repo. Artefacts — a Solution on a Page, a business case, a handover pack — are rendered from that data on demand.

There is one set of data, not five documents that drift apart.

Gantry itself knows nothing about design, procurement or anything else. Every use case is a definition, and definitions are configuration.

Jump to [Executive Summary](docs/exec-summary.md)

## The problem this solves

Most governance processes accrete documents. Each gate demands its own artefact, each artefact re-states 60% of the last one in a slightly different shape, and every one of them is a separate Office file living in a separate library with a separate owner. Six months in, nobody can tell you which version is true.

The usual response is to rationalise the document set. That works for about a year.

Gantry attacks the coupling instead. The document is a *view*. The data is the thing. If a gate needs a two-page summary and the delivery team needs a detailed spec, those are two renderings of the same underlying modules — not two documents to keep in sync.

Because the shape of that problem is not unique to any one process, the engine is deliberately empty. Anything with stages, gates and repeated content is a candidate.

## How it works

```
  definition (the process)            instance (one run of it)
  ├── stages                          ├── module files (markdown + frontmatter)
  ├── gates              ────────►    ├── validated against the definition
  ├── module specs                    └── rendered to artefacts on demand
  └── artefact templates
```

1. **Write a definition.** It describes a process: its stages, the gate at the end of each stage, the modules that make up its content, and the artefacts that can be rendered from those modules.
2. **Create an instance.** One initiative, one project, one procurement — whatever the process runs on. An instance is a folder of files.
3. **Fill in modules.** By hand in your editor, by agent, or through the bundled web form.
4. **Render at the gate.** `gantry render soap` produces the document. The document is disposable; the modules are not.

Git is the audit trail. Who changed what, when, and why is a `git log`, not a version-history table nobody maintains.

## Concepts

| Term | What it is |
|---|---|
| **Definition** | A reusable, versioned process description. Design is one definition. Business case, procurement, incident review and operational handover are others. A Gantry repo can hold as many as you need, each definition carrying numbered versions (`definitions/<id>/<n>/`) with `version:` and `status:` (`draft` \| `published`). |
| **Stage** | A phase of the process. Stages are ordered, and each has an exit gate. |
| **Gate** | The decision point a stage feeds. Gates declare which artefacts and which modules must be complete to pass. |
| **Module** | The atomic unit of content — a single, self-contained piece of the process (context, options, non-functional requirements, security posture). Modules are the source of truth. |
| **Instance** | One run of a definition against one initiative — a folder of module files, local or living inside a workspace. Its own stored `assignee` (a single named person, editable from its Instance Settings screen or `gantry new --assignee`) is a distinct instance-level field, stable across stage transitions — separate from each module's own frontmatter `owner`, which is still just the first non-empty value found among its current stage's modules (see "Instance module files" below), unrelated and unchanged. |
| **Workspace** | Where an instance's data lives — **Server-hosted** or **Local**, chosen as the "+ New Workspace" wizard's own "Workspace location" step (`CONTEXT.md`'s "Workspace location" glossary entry, `docs/adr/0029-local-workspaces-client-filesystem.md`). A **Server-hosted workspace** is an Azure DevOps organization/project/repository (see "Backing an instance with Azure DevOps" below): registered through the wizard the first time you create an instance against that repo and reused by every later instance created against the same one, with its own free-text owner label and a ticketing-system selection, both editable from an instance's own Workspace Settings screen. A **Local workspace** is a folder on your own machine instead (see "Backing an instance with a local folder" below) — the gantry server keeps no record that it exists. |
| **Stage advancement** | How an instance moves from one stage to the next — which depends entirely on whether it's local or Workspace-backed (see "Stage advancement and approval" below). A **local** instance — including one whose data lives in a Local workspace, not just the legacy local-instance mode — advances self-serve via "Advance to next stage", blocked until its current gate has passed. A **Workspace-backed** instance (Server-hosted only; a Local workspace never qualifies) never advances self-serve: its stage's work lives on its own **stage branch** (`gantry-workspace/<slug>/<stageId>`, stacked on the prior stage's branch while that one's still open — so `main` only ever reflects fully-approved, merged stages), and it advances only when that stage's Pull Request is approved in Azure DevOps and gantry merges it. There is no third mode and no per-instance opt-out. |
| **Artefact** | A rendered output. A document, a page, a summary. Generated, never hand-edited. Every artefact, `.md` and `.docx`, ends with a footer naming a short commit hash and date it was rendered from — the current local `HEAD` for a local instance, or (for an Azure DevOps-backed one) the commit its content was pushed as, one commit behind the file's own latest history entry, since a commit can't name its own hash — so a document can always be traced back to close to the exact version that produced it. |

The key rule: **artefacts are derived, modules are authored.** If you find yourself editing a rendered artefact, something is wrong with the module spec.

### Definition Editor (experimental)

Definitions are versioned (numbered `definitions/<id>/<n>/` dirs — see "Definition schema" below). An experimental **Definition Editor** screen at `/definitions` — linked from the Workspaces page header as "Definition Editor (experimental)" — shows any definition version read-only and, on a *draft* version, allows editing its structure, modules, fields and `.md.tmpl` templates, reordering stages/modules/fields, and creating a new draft version, cloning a definition, archiving/restoring, and publishing a draft. It is experimental and may change without notice.

## Principles

**Data over documents.** If content lives in two places, one of them is a rendering.

**Flat files, no database.** Git gives history, review, branching, access control and offline work for free. A database would give you a migration problem and a backup schedule.

**Proportionate by design.** The definition declares what each gate genuinely requires. Completeness is checked against that, not against the full module set.

**Process-agnostic engine.** Nothing in Gantry knows what a SOAP is. Design is a definition, and definitions are configuration.

**Two front ends, one store.** The form writes the files a human would have written. There is no synchronisation step, because there is nothing to synchronise.

---

# Getting Started

## Installation

Gantry runs anywhere Node.js does, including Windows — you don't need WSL. Pandoc is only needed for the `gantry render` CLI command or the web UI's native-rendering toggle (see step 2). It's built and CI-tested on Linux, so Windows works in principle but is unverified in practice; WSL is the safer bet if you want the exact environment this project is tested against.

**1. Install Node.js 24+** (`package.json` `engines.node` is `>=24`)

- **Linux (Debian/Ubuntu)**:
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ```
- **Windows**: download the 64-bit **Windows Installer (`.msi`)** from https://nodejs.org/en/download and run it (standard wizard), then restart your terminal so `node`/`npm` are on PATH.

**2. Install Pandoc 3.x** (optional if you only use the web UI — see below)

Rendering from the web UI (`gantry serve`, both local-folder and Azure-DevOps-backed instances) goes through an in-browser WASM build of Pandoc by default, so a native Pandoc install isn't required just to use Gantry that way — Settings has a toggle to the native engine, and Gantry falls back to it automatically if the WASM engine ever fails to load. The **`gantry render` CLI command** is a separate path (used e.g. by `npm run render:examples`) that always shells out to native Pandoc — install it if you'll use that command directly.

- **Linux (Debian/Ubuntu)**:
  ```bash
  sudo apt-get install -y pandoc
  ```
  Or grab the latest `.deb` from the [Pandoc releases page](https://github.com/jgm/pandoc/releases/latest) if your distro's version lags.
- **Windows**: download `pandoc-<version>-windows-x86_64.msi` from https://github.com/jgm/pandoc/releases/latest and run it.

**3. Install Git** (needed to clone the source below, and if you'll back any instance with Azure DevOps — not needed for local-folder-only instances, see "Backing an instance with a local folder" below)

- **Linux (Debian/Ubuntu)**:
  ```bash
  sudo apt-get install -y git
  ```
- **Windows**: download the 64-bit standalone installer from https://git-scm.com/download/win and run it.

Already have winget? `winget install OpenJS.NodeJS.LTS` and `winget install --exact --id JohnMacFarlane.Pandoc` also work.

> **Corporate proxy / TLS inspection (Windows).** If `npm install` fails with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` for `registry.npmjs.org`, `github.com`, or both, your network is doing HTTPS inspection (Zscaler, Netskope, a corporate firewall) with a CA that Windows trusts but Node doesn't. Tell Node to use the Windows certificate store:
>
> ```powershell
> setx NODE_USE_SYSTEM_CA 1
> ```
>
> Then open a **new terminal** (`setx` only affects new sessions — a terminal or Explorer window that was already open keeps the old environment, which is the usual reason this looks like it didn't work) and re-run `npm install`. For a single session instead: `set NODE_USE_SYSTEM_CA=1` (cmd) or `$env:NODE_USE_SYSTEM_CA=1` (PowerShell). `NODE_USE_SYSTEM_CA` needs Node 22+ (already required above).
>
> If an install still fails after that, your proxy's CA isn't in the Windows root store — ask IT where it lives and point `NODE_EXTRA_CA_CERTS` at a PEM copy of it before re-running.

**4. Clone and install Gantry** (same on both platforms)

```bash
git clone <repo-url>
cd gantry
npm install          # installs the engine's deps AND the web form's browser deps (preact, preact-iso, @preact/signals, htm, codemirror, markdown-it, dompurify) into node_modules/
npm link             # makes `gantry` available on your PATH
```

> **TODO:** publish to an npm feed (`npx gantry`) too, for people who only ever consume definitions and don't want a clone-and-install step at all.

**5. Run it.** `gantry serve` (from step 4's `npm link`), then open the URL it prints in your browser. Same on all platforms.

## Software dependencies

| Dependency | Version | Why |
|---|---|---|
| Node.js | 24+ | Engine runtime and CLI (`package.json` `engines.node` is `>=24`) |
| `pandoc` | 3.x confirmed (3.1.3) | **Required for the `gantry render` CLI command** (shells out to it unconditionally). Optional for the web UI — `gantry serve` renders via an in-browser WASM Pandoc by default; native Pandoc is only needed there if you use Settings' native-engine toggle, or as the automatic fallback if WASM fails to load |
| Git | 2.x+ | Needed to clone the source below and for any Azure-DevOps-backed instance. Not needed for local-folder-only instances |
| A text editor | any | Modules are markdown; no tooling required to author them |
| `vendor/anthropic-skills/{docx,pdf,pptx,xlsx}` | pinned to a commit, see `vendor/anthropic-skills/README.md` | Document-conversion code used to *verify* rendered artefacts during development (docx→pdf→image) — source-available, not open source; see that README for the license caveat. Not required at render time. |

The web form (`web/`) is a static page with no build step — but it is **not** dependency-free: `gantry serve` generates a browser import map that serves Preact, `preact-iso`, `@preact/signals`, `htm`, CodeMirror 6, `markdown-it`, `DOMPurify`, pandoc-wasm and Mermaid straight out of `node_modules/` (see `docs/adr/0006-preact-frontend-framework.md`). That directory must exist wherever `gantry serve` runs — don't `npm prune --production` or ship without it.

Backing an instance with Azure DevOps needs nothing installed locally — no Azure CLI, no `az` login. It needs an Azure DevOps **Personal Access Token** (Code + Work Items, Read & write), entered once through the browser when prompted (see "Backing an instance with Azure DevOps" above).

Backing an instance with a local folder needs nothing installed either — just a Chromium browser (Chrome or Edge; see "Backing an instance with a local folder" below).

Visually verifying a rendered `.docx` (not required to *use* Gantry, only to sanity-check output during development) additionally needs LibreOffice (`soffice`) and Poppler (`pdftoppm`) — see `vendor/anthropic-skills/docx/SKILL.md`.

## Latest releases

Release notes live in **[CHANGELOG.md](CHANGELOG.md)** — one section per tagged release, newest first. It's the one place a user can see what changed without reading commit messages or having Azure DevOps access.

Releases are tagged `v<version>` on their merge commit on `main`. Every version bump adds a changelog section in the same commit — `tests/changelog.test.js` fails the build otherwise. Full process: [`docs/agents/release-process.md`](docs/agents/release-process.md).

Early. The engine, definition schema and design definition are under active development. Treat the definition schema as unstable until v0.1.

## Repository layout

```
gantry/
├── gantry.yaml                   # engine configuration
├── definitions/
│   └── design/                   # the only definition that exists today
│       └── 1/                    # numbered version dirs — one per definition version
│           ├── definition.yaml   # stages, gates, artefacts (with version: and status:)
│           ├── CHANGELOG.md      # per-version changelog
│           ├── modules/          # module specs for this version
│           │   ├── context.yaml
│           │   ├── solution-definition.yaml
│           │   └── ...
│           └── templates/        # artefact templates for this version
│               ├── soap.md.tmpl  # one .md.tmpl per artefact (soap, soap-full, hld, sad, ssad, as-built)
│               ├── ...
│               └── reference-*.docx  # pandoc --reference-doc, one per artefact, derived from the real templates
├── instances/
│   ├── instance-registry.json    # slug -> workspace/location map, gitignored
│   ├── workspace-registry.json   # Azure DevOps org/project/repo entities, gitignored
│   ├── number-registry.json      # scoped numeric refs (ADR-0024): workspace/instance/stage ordinals, gitignored
│   └── <initiative-slug>/        # local instances only — an Azure DevOps-backed
│       ├── instance.yaml         # instance lives at gantry-workspace/<slug>/ in
│       ├── modules/              # its own repo instead (see below), never here
│       │   ├── context.md
│       │   └── solution-definition.md
│       ├── assets/               # (WI260) local asset store — for a Workspace-backed instance the same dir lives as gantry-workspace/<slug>/assets/ in the Azure DevOps repo, sibling of modules/ and out/
│       └── out/                  # rendered artefacts (gitignored by default)
├── lib/                          # the engine: definition/instance loading, render, status, the web server
│   ├── server.js                 # HTTP routes, incl. the work-item, workspace, stage-advancement/approval,
│   │                             # stage-review and synced-fields (Work item details card) endpoints
│   ├── instanceRegistry.js       # slug -> workspace/location lookup/registration (the registry above)
│   ├── workspaceRegistry.js      # Azure DevOps org/project/repository entities instances reference
│   ├── numberRegistry.js         # scoped numeric workspace/instance/stage references layered over slugs
│   │                             # (docs/adr/0024-scoped-numeric-references-layered-over-slugs.md)
│   ├── azureDevOpsClient.js       # PAT-authenticated Azure DevOps REST client (Git)
│   ├── azureDevOpsWorkItemsClient.js  # PAT-authenticated Azure DevOps REST client (Work Items)
│   ├── azureDevOpsPullRequestsClient.js # PAT-authenticated Azure DevOps REST client (Pull Requests):
│   │                              # create a PR, read reviewer votes, complete/merge it
│   ├── stageBranch.js             # per-stage branch names/lifecycle for Workspace-backed instances
│   │                              # (gantry-workspace/<slug>/<stageId>, stacked on an open prior stage's branch)
│   ├── stageAdvancement.js        # local instances' gate-gated self-serve "Advance to next stage"
│   ├── stageApproval.js           # Workspace-backed "Request Sign-off": open the stage's gate-pass-gated PR
│   ├── stageStatus.js             # "Check status": read the PR's reviewer votes; on approval, merge,
│   │                              # advance the stage and push the linked work item
│   ├── stageReview.js             # Workspace-backed "Request Review": informal, non-gating reviewer feedback
│   ├── reviewStatus.js            # custom review/sign-off status field on the Work item details card
│   ├── syncedFields.js            # the instance screen's Work item details card (type/title/status/PR state/assignee)
│   ├── workItemLink.js           # link an instance to a work item; confirmed gate-pass state sync
│   ├── repoCheck.js              # "does this Azure DevOps repo already hold instance data", incl.
│   │                             # the legacy-root-to-gantry-workspace/<slug>/ migration routine
│   └── credential.js             # extracts a forwarded PAT from a request
├── bin/gantry.js                 # CLI entrypoint
└── web/
    ├── index.html                # app shell
    ├── app.js                     # dashboard + module editor (incl. stage advancement/approval panels,
    │                              # the Work item details card and the workspace-scoped instance switcher)
    ├── pages/new-workspace-wizard.js # "+ New Workspace" — pick/register a workspace, then instance fields
    ├── pages/settings.js         # /settings, /settings/workspace, /settings/instance — tab-free
    ├── pages/user-guide.js       # /user-guide — the in-product, end-user-facing User Guide (separate surface from this README)
    ├── pages/definition-viewer.js # /definitions — Definition Editor (experimental)
    ├── lib/credential.js         # client-side PAT storage/prompt, incl. per-workspace overrides
    ├── lib/ticketingSystem.js    # client-side default-ticketing-system setting
    ├── lib/apiFetch.js           # fetch wrapper: attaches the right PAT, retries once on 401
    ├── lib/validateRepo.js       # parses/checks the wizard's Azure DevOps repo URL
    ├── lib/markdown.js           # markdown-it + DOMPurify rendering
    ├── lib/mermaid.js            # ```mermaid fences → SVG in the preview, PNG in WASM docx exports (docs/adr/0030)
    ├── lib/dropdown.js           # reusable dropdown (trigger + menu)
    ├── lib/reorder.js            # pure array reorder helper
    ├── user-guide-images/        # User Guide screenshots, served statically
    └── style.css
```

Definitions sit side by side — adding a second one requires no change to the engine — but `design` is the only one built out so far. `procurement` and `incident-review` are illustrative names from this README's own example, not real definitions in this repo.

## Two ways to work

**Clone and write.** The repo is flat files. Clone it, read the definition, fill in the module files in your editor. Every module carries its own spec and guidance, so you're not guessing at what "Context" is supposed to contain. This is the path for architects who'd rather write markdown than fight a form, and for agents driving the process programmatically.

**Use the form.** `gantry serve` opens a dashboard of every registered instance — local, Azure DevOps-backed, or living in a Local workspace on your own machine (see below). Opening one walks you through the process stage by stage, with the spec and guidance inline. A stage switcher lets you jump to any gate's screen, not just whichever stage the instance is currently at. Fill it in, hit render, get your document. Under the hood it writes the same files to the same repo (or the same Azure DevOps repo) — there is no second store, and no import/export step.

Each gate screen also has a "Clear all fields" button, blanking every field shown for that stage without touching the saved files until you hit each module's own Save button. To see what a filled-in gate screen looks like, `gantry serve` and open `examples` from the dashboard — a fixture instance with real content for every stage.

Neither path is the "real" one. They're two front ends onto the same data.

## Backing an instance with Azure DevOps

An instance's data doesn't have to live on the machine running `gantry serve` — it can live in an Azure DevOps repo instead, with gantry acting as a form over it. This is useful when the people filling in modules aren't the people running the server.

A repo backing instance data this way is a **workspace**: `instance.yaml` and `modules/` live at `gantry-workspace/<slug>/` inside it, not at repo root — so one workspace (one Azure DevOps repo) can hold more than one instance, each in its own slug-named subdirectory, rather than being permanently tied to exactly one.

The landing page's sole creation entry point is **"+ New Workspace"** (`/new-workspace`) — a single wizard that covers both registering a brand-new workspace and adding another instance to one that already exists (there is no separate "+ New instance" action, and no paste-a-URL-first flow any more):

1. **Pick an existing workspace** from those this server already knows, or **register a new one** against a `https://dev.azure.com/{organization}/{project}/_git/{repository}` location (an on-premises Azure DevOps Server base URL isn't supported here yet). Registering sets that workspace's **Owner** and ticketing system in the same step — nothing else asks for either ahead of an instance existing in it. The PAT you're prompted for here proves real access to that exact repo before anything is recorded.
2. **Instance fields** — Name, Directory (defaulting to the slugified Name, overridable), and an initial Assignee.
3. **Work-item link** — only when the chosen workspace has a ticketing system configured: the Azure DevOps parent-work-item link, with Organization *and* Project auto-filled read-only from the workspace's own pinned values, and Parent work item id / Work item type as real PAT-backed lookups rather than freetext. Skipped entirely for a workspace with no ticketing system.

The first request against an Azure DevOps-backed instance prompts for a **Personal Access Token** with **Code (Read & write)** and **Work Items (Read & write)** scope. It's stored in the browser (`localStorage`), sent only to your own gantry server, and forwarded from there to Azure DevOps as an HTTP Basic credential — gantry's own server never persists it.

Settings is three separate, tab-free screens, reached differently depending on where you are:

- From the dashboard (Home), **Settings** goes straight to **Global Settings** (`/settings`) — no intermediate step.
- From an open instance, **Settings** opens a dropdown offering **Global Settings**, **Workspace Settings**, and **Instance Settings**.

Each screen's own back control returns to wherever it was actually opened from (Home, or that same instance screen) — not browser history — falling back to Home for a direct/bookmarked Settings URL.

- **Global Settings** (`/settings`) — an **Advanced mode** toggle, off by default (see "Backing an instance with a local folder" below), plus, once it's on: set, replace or clear the Azure DevOps PAT ahead of ever being prompted for one, and pick the default **ticketing system** new workspaces use. Azure DevOps is the only ticketing system gantry actually talks to today; a second option is listed but disabled ("coming soon") so the schema and UI don't need a migration once a second one ships.
- **Workspace Settings** (`/settings/workspace`, from an instance's own Settings dropdown) — the workspace *behind that one instance* (never a picker across every registered workspace): its Azure DevOps repo URL and three editable fields — a free-text **owner** label, a **PAT override** for that workspace alone (falls back to the Global Settings PAT when unset, and — like the global PAT — never leaves the browser), and a per-workspace **ticketing-system** override. It also offers **Archive** — a reversible "set aside" that drops the workspace out of the default dashboard and API listings without deleting anything on disk or in Azure DevOps (blocked while it still has an active instance; `?archived=1` reveals archived rows for a per-row Restore). A local instance has no workspace, so this screen reports that instead.
- **Instance Settings** (`/settings/instance`, from an instance's own Settings dropdown) — that instance's own stored **Assignee** (editable), read-only instance info (slug, definition, current stage), and a read-only view of its Azure DevOps work-item link (organization/project/parent work item/type, and each stage's own child work item id). Re-linking isn't supported here or anywhere else after creation — linking happens only at instance creation (see "Linking an instance to an Azure DevOps work item" below). This screen also offers **Archive** for the instance itself — the same reversible set-aside as for a workspace; an archived instance still resolves read-only at its direct URL.

Once registered, a local and an Azure DevOps-backed instance are indistinguishable from the dashboard's point of view — same listing, same module editor, same render command. Where each one's data actually lives is tracked server-side across three registry files (`instances/instance-registry.json`: slug -> workspace; `instances/workspace-registry.json`: workspace -> organization/project/repository/owner/ticketing-system/`archived`; `instances/number-registry.json`: the scoped numeric ordinals of ADR-0024 — all gitignored, application state, not source), not in any client-visible config.

## Backing an instance with a local folder

An instance's data doesn't have to live on the machine running `gantry serve`, or in an Azure DevOps repo either — it can live in a folder on the *browser user's own machine* instead, picked directly through the browser (`docs/adr/0029-local-workspaces-client-filesystem.md`; see also the "Workspace location" entry in `CONTEXT.md`'s glossary). Choose this when you want your data to never leave your machine: gantry's server keeps no registry entry, no row and no numeric reference for a Local workspace — the folder itself, plus this browser's own cache of it, is the only record that it exists anywhere.

This needs **Chrome or Edge**. It's built on the File System Access API (`showDirectoryPicker()`), which is Chromium-only; in Firefox and Safari the wizard still offers the Local option but disables it, with "Local workspaces need Chrome or Edge" shown in its place. Server-hosted workspaces have no such restriction.

By default the "+ New Workspace" wizard skips the location question entirely and takes you straight into this flow — the Server-hosted (Azure DevOps) option, and the rest of the Azure DevOps / ticketing / sign-off UI, only appears once **Advanced mode** is turned on from Global Settings (`/settings`). With Advanced mode on, the wizard's first step becomes an explicit **Workspace location: Server-hosted | Local** choice.

**Creating one.** Choose **Local**, then:

1. **Pick a new or empty folder.** Gantry writes `gantry-workspace/` inside it — a folder that already has a `gantry-workspace/` in it is refused here (open it with "Pick existing local workspace" instead).
2. **Name the workspace** (an optional free-text owner too) — this is written into a `workspace.json` marker at the folder root, `{ name, owner, kind: "local", createdAt }`, which is what makes the folder recognisable as a gantry workspace the next time anyone opens it.
3. **Instance fields** — Definition, Name, Directory (defaulting to the slugified Name) and an initial Assignee, same as the Server-hosted flow. There is no work-item step: Local workspaces have no ticketing.

**Reopening one.** The quickest path back is the **Local workspaces** panel the Workspaces landing page shows once this browser remembers any — each row opens straight to its instances once permission is confirmed, offers **Click to open** / **Reopen** when a permission or the folder itself needs re-confirming (the normal state after a browser restart, or the first time in a new browser or machine), and a per-row **Remove** that only forgets the browser's cache, never anything on disk. The wizard's own **Local → Pick existing local workspace** step does the same job from inside the wizard: **Open folder** browses to any folder holding a `gantry-workspace/workspace.json`, and its **Recent local workspaces** list re-offers folders opened before, each with the same **Grant access** re-permission step when needed.

**Disk layout.** A Local workspace mirrors the layout a Server-hosted (Azure DevOps) workspace uses exactly:

```
<picked folder>/gantry-workspace/
  workspace.json
  <instance-slug>/
    instance.yaml
    modules/
    out/
    assets/
```

Because the layout is identical, a picked folder can be a plain `git clone` of a Server-hosted workspace's repo — the same files work in both places.

**What works offline.** Editing module files and saving them needs no server at all — every read and write goes straight through the browser's own handle on the folder. Checking a gate, validating and rendering an artefact still need the gantry server (that's where the compute lives, Pandoc `.docx` step included): the browser sends the relevant file contents to a stateless `/api/local/*` endpoint for a one-off run and gets the result back, and the server never keeps a copy. Those actions report a clear "connect to the gantry server" message rather than failing silently when it can't be reached.

**No ticketing.** A Local-workspace instance has no linked Azure DevOps work item, no "Check gate & sync work item", no Review/Sign-off flow, no stage branches and no Pull Requests. It advances exactly the way a legacy local instance does (see "Stage advancement and approval" below): once the current stage's gate passes, **Advance to next stage** moves it on directly, self-serve, with no approval ceremony. This is a genuinely different thing from that legacy **local instance** mode (data stored server-side under `instances/`, reachable by `gantry serve` on the box, not picked in the browser) — both are "local" in the everyday sense, but one is data the server has no handle on at all and the other is data sitting right there on the box running `gantry serve`. See `CONTEXT.md`'s "Workspace location" entry for the fuller distinction.

## Linking an instance to an Azure DevOps work item

Optionally, an instance can be linked to a parent Azure DevOps work item so its progress is trackable on the board. Linking happens when the instance is created, via the "+ New Workspace" wizard's work-item step (above) — a step only instances created inside a ticketing-enabled workspace get, so an instance has no linking path outside creation (the module editor's old free-text link form is gone, and an instance created without a link shows a "Link to a work item" prompt in its place pointing back at creation; re-linking isn't supported after the fact). A Local-workspace instance is never ticketing-enabled, so it never gets this step or anything described below (see "Backing an instance with a local folder" above).

Linking creates one child work item per stage in the instance's definition underneath that parent, in one step. From then on:

- A **Work item details** card at the top of the instance screen (the old "synced-fields" panel, consolidated by WI213/WI217) shows the current stage's live tracking fields at a glance: the work item type (default `Task`), a title auto-populated as "{instance name} — {stage title}" but overridable per stage, the linked work item's own current Status read straight from Azure DevOps, the stage's Pull Request state, and the Assignee (inherited from the instance's stored assignee, overridable per stage). The same card now also carries the stage's **Reviews & sign-off** — see "Stage advancement and approval" below — and its commit-history dialog.
- The card keeps a **Check gate & sync work item** action — it checks the currently-viewed stage's gate and, only if it passes, opens a confirmation dialog before pushing a new state to that stage's own work item; declining leaves the state untouched. The state actually pushed is drawn from whatever states the configured work item type genuinely supports in your project (via its own `getWorkItemTypeStates` lookup), never a fixed list Gantry invents — see `docs/adr/0011-azure-devops-work-item-linking.md`. For a Workspace-backed instance this gate-check-and-confirm step is folded into the card's single "Check status" click (WI217); a local instance keeps it as its own standalone button.
- Gantry also tracks a custom review/sign-off status alongside native `System.State` (`Requested` / `In review` / `Changes requested` / `Approved` / `Rejected`), because the `Task` type's `System.State` transitions are locked — see `docs/adr/0024-custom-review-status-field.md`.
- For a **Workspace-backed** instance the linked work item is a board-visible tracking surface only (title, status, assignee) — it plays no part in gating stage advancement any more; that's the stage's Pull Request (see below).

## Stage advancement and approval

Nothing moves an instance from one stage to the next by itself — advancement is always explicit, and how it works depends entirely on whether the instance is local or Workspace-backed (`docs/adr/0012-stage-advancement-board-side-approval.md`, as reworked by `docs/adr/0014-pull-request-stage-approval.md`, which supersedes ADR-0012's ticketing-mode mechanism). In both modes the action is blocked until the current stage's gate has genuinely passed — re-checked server-side at the moment of the action, never trusted from an earlier client-side check — and multiple stages may sit pending approval concurrently: starting the next stage never waits on the previous one's approval.

**Local instances** advance self-serve: an "Advance to next stage" panel runs the gate check, asks for confirmation, and moves the instance's stage pointer directly — nothing is pushed anywhere else. The panel isn't rendered for a Workspace-backed instance at all, which has no self-serve path out of a stage. A Local-workspace instance (see "Backing an instance with a local folder" above) follows this exact same rule — the gate check runs through `/api/local/check` instead of `/api/instance/check`, but the panel, the confirmation, and the direct stage-pointer move are otherwise identical.

**Workspace-backed instances** are gated by a real Azure DevOps Pull Request the Owner reviews *in Azure DevOps* — there is no separate approve button inside gantry:

1. The moment the first save of a stage lands, that stage gets its own branch — `gantry-workspace/<slug>/<stageId>` — and every subsequent read/write targets it. If the previous stage's branch is still open (its PR unmerged), the new branch stacks on top of it rather than forking fresh from `main`, so work continues in sequence through approval latency; `main` itself only ever reflects fully-approved, merged stages.
2. Every module save re-renders whichever of the stage's artefacts have enough data and commits them to the same branch, so the eventual Pull Request's diff always carries the generated documents alongside the module files.
3. **Request Sign-off** (called "Request approval" in `docs/adr/0014`) opens that stage's Pull Request into `main` — the actual approval gate — but only once the stage's gate has passed. Committing to the branch before that is unrestricted throughout the stage; opening the PR is what's gated. Separately, **Request Review** (WI197) sends an informal, non-gating feedback request — one Azure DevOps work item per reviewer — available at any point in the stage.
4. The Owner reviews and votes on the Pull Request directly in Azure DevOps. **Check status** then reads the PR's reviewer votes — explicitly distinguishing a rejection or changes-requested vote from a merely-still-pending review, so "the Owner asked for changes" never reads as an ambiguous "not yet approved". The one "Check status" button on the Work item details card refreshes reviews and sign-off together.
5. On detecting approval, gantry completes (merges) the Pull Request itself, advances the instance's stage pointer, and pushes the linked work item's state where one is linked — one click resolves everything, with no second manual merge step. Detection stays manual (this explicit "Check status" click): no polling, no webhooks.

## Your first instance

```bash
gantry new design my-initiative                 # start an instance
gantry status my-initiative                     # what does the current stage need?
gantry check my-initiative --gate business-case # does it pass the gate? (any gate, not just the current stage's)
gantry serve my-initiative                      # fill it in via the form, or edit the files by hand
gantry render my-initiative soap                # produce the artefact
```

> `gantry definitions` is not yet implemented. Everything else in the CLI reference below is live.

---

# Reference

## CLI

| Command | Does | Status |
|---|---|---|
| `gantry definitions` | List definitions available in this repo | Not yet implemented |
| `gantry instances [--json]` | List instances available in this repo, with definition and current stage | Implemented |
| `gantry new <definition> <slug> [--owner <name>] [--assignee <name>]` | Create an instance — `--owner` seeds each first-stage module file's own frontmatter `owner`; `--assignee` sets the instance record's own stored assignee | Implemented |
| `gantry status <slug> [--json]` | Current stage, module completeness, what's outstanding | Implemented |
| `gantry check <slug> [--gate <id>] [--json]` | Validate an instance against a gate's requirements — any gate, not just the instance's current stage | Implemented |
| `gantry render <slug> <artefact> [--dry-run]` | Render an artefact to `out/` | Implemented |
| `gantry serve [slug] [--port <port>]` | Serve the web app (default port 3000): a dashboard of every registered instance at `/`, local or Azure DevOps-backed, and the stage-by-stage form at `/instance/<slug>`. `[slug]` only sets a fallback default for API requests made with no `?slug=<slug>` of their own — it doesn't change what the dashboard shows or require picking one instance up front. `/new-workspace` is the "+ New Workspace" wizard, `/settings` the Settings screens, `/user-guide` the in-product User Guide, `/definitions` the Definition Editor (experimental) (see "Backing an instance with Azure DevOps" above) | Implemented |
| `gantry validate <definition> [--json]` | Report every structural problem with a definition in one pass | Implemented |
| `gantry backfill-numeric-refs` | One-time (idempotent) backfill of scoped numeric workspace/instance references (ADR-0024) for workspaces/instances that predate the feature | Implemented |

`status`, `check` and `validate` all emit structured output with `--json` for scripting and agent use.

## Definition schema

**`definitions/design/1/definition.yaml`** — `definitions/<id>/<n>/definition.yaml`

```yaml
id: design
version: 1
status: published
title: Solution Design
description: >
  Design content for an initiative, from shaping through HLD approval,
  build-ready detailed design, and operational handover.

stages:
  - id: shape
    title: SOAP
    gate: business-case
    modules: [context, solution-definition, team-and-estimates, dependencies, soap-full-details]

  - id: hld-define
    title: High-level Design
    gate: hld-tac-approved
    modules: [hld-submission, problem-statement, proposed-solution, alternatives-considered, open-questions, nfrs, risks, security, dependencies]

  - id: detailed-design
    title: Detailed Design
    gate: build-ready-checklist
    modules: [architecture, integration, data, nfrs, security, risks, dependencies, support-and-operations]

  - id: handover
    title: Operational Handover
    gate: operational-handover
    modules: [as-built-notes]

artefacts:
  - id: soap
    title: Solution on a Page
    template: templates/soap.md.tmpl
    gate: business-case
    requires: [context, solution-definition, team-and-estimates]

  - id: soap-full            # heavier variant sharing the business-case gate; field-level requires
    title: Full Solution on a Page
    template: templates/soap-full.md.tmpl
    gate: business-case
    requires: [context.driver, context.opportunity, solution-definition.high-level-requirements, ...]

  - id: hld
    title: High Level Design
    template: templates/hld.md.tmpl
    gate: hld-tac-approved
    requires: [hld-submission, problem-statement, proposed-solution, alternatives-considered, open-questions, nfrs, risks, security, dependencies]

  # sad and ssad also render at build-ready-checklist, each with its own field-level requires list;
  # as-built renders at operational-handover. See definitions/design/1/definition.yaml for the full file.
```

Every `definition.yaml` starts with `version:` (integer) and `status:` (`draft` | `published`). Definitions carry numbered versions (`definitions/<id>/<n>/`), each with its own `definition.yaml`, `modules/`, `templates/` and `CHANGELOG.md`. The latest `published` version is the default for new instances; `draft` versions are opt-in via the New Workspace wizard's version picker.

A gate passes when *at least one* of its gate-matching artefacts has its own `requires` complete — not when a stage's whole `modules` list is filled in (`docs/adr/0019-gate-passing-per-artefact-not-per-stage-module-list.md`). `requires` entries can be whole module ids or `module.field` references, so a heavier artefact (`soap-full`, `sad`, `ssad`) can reuse a module without dragging in every field a lighter artefact on the same gate leaves optional (`docs/adr/0020-full-soap-artefact.md`, `docs/adr/0021-sad-ssad-artefact-requirements.md`). A field reference may carry a trailing `?` (`module.field?`): the field is still in the artefact's scope — rendered, and shown in the lightweight editor — but it only blocks the gate when the field is independently required there via its own `required` / `required-at`. A bare `module.field` always blocks the gate when empty; `?` on a whole-module entry is a validation error (WI #276).

## Module specs

**`definitions/design/1/modules/context.yaml`**

```yaml
id: context
title: Context
purpose: >
  Why this initiative exists and what it is responding to. Enough for a reader
  with no prior knowledge to understand the situation in under two minutes.

fields:
  - id: driver
    title: Business driver
    type: markdown
    required: true
    guidance: >
      The change in the world that makes this necessary — legislative,
      operational, commercial, or a constraint that has become binding.

  - id: affected-domains
    title: Affected domains
    type: list
    required: true

  - id: out-of-scope
    title: Explicitly out of scope
    type: markdown
    required: false
```

Modules can be shared between definitions where the content genuinely is the same thing — and should not be where it merely looks similar.

### Field requiredness across shared gates

A module can be required at more than one gate (e.g. `nfrs` at both `hld-tac-approved` and `build-ready-checklist`), with a field expected to be filled in progressively — light at the earlier gate, complete by the later one. `required: true|false` alone can't express that: it's one value, applied wherever the module appears.

For a field whose requiredness genuinely differs by gate, use `required-at` instead of `required` — a list of the gate ids at which the field becomes required. At any other gate the module is also required at, the field is optional.

```yaml
  - id: disaster-recovery-and-backup
    title: Disaster recovery and backup
    type: markdown
    required-at: [build-ready-checklist]
    guidance: >
      Recovery time/point objectives, backup schedule and retention. Light
      or absent at `hld-tac-approved`; required by `build-ready-checklist`.
```

Where a field's *content* genuinely changes shape across the gates its module spans — not just gains depth — model it as two fields on the shared module instead of one field with `required-at`. See `definitions/design/1/modules/dependencies.yaml`: `dependencies-overview` (narrative, required at the earlier gate) and `dependency-list` (structured, required at the later gate) answer the same question in two different shapes, not two depths of one answer.

`required` and `required-at` are mutually exclusive on a field — use `required` for a field whose requiredness doesn't vary by gate (including fields in single-gate modules), and `required-at` only where it does. Don't reach for `required-at` by default; most fields don't need it.

## Instance module files

**`instances/my-initiative/modules/context.md`** — what someone actually writes:

```markdown
---
module: context
status: draft
owner: c.barlow
---

# Context

## Business driver

...

## Affected domains

- Payments
- Client Record

## Explicitly out of scope

...
```

Module files are markdown so they're readable, diffable and editable anywhere. Frontmatter carries the machine-legible state.

Headings follow one document scale (ADR-0016): the module's title sits at `#`, each field heading at `##`, and author content starts at `###` — so an author's own sub-heading can never collide with a field boundary. Files written before this scale existed are migrated in place on first read; no manual step is needed.

In the web form, each markdown field grows a slim formatting toolbar while it has focus (bold, italic, strikethrough, inline code, link, a Lists menu, quote, rule, code block, direct Image/Table actions, and a Headings menu starting at Heading 3 to match that scale), driven by deterministic text transforms over CodeMirror's syntax tree so buttons and `Ctrl/Cmd` shortcuts are one code path (ADR-0017). Insert ▾ keeps the Section and List actions; the toolbar's Table action opens an 8×8 size grid, and picking a size inserts a GFM pipe table with the caret in the first body cell. While the caret sits inside a well-formed table, a contextual strip offers row/column add, remove and per-column alignment, Tab walks the cells (Enter appends a row from the last one), and anything malformed is a silent no-op rather than a rewrite (ADR-0018).

## The design definition

Design is the first definition, and the reason Gantry exists. It replaces a document set in which the Solution on a Page, High Level Design, Solution Architecture Document, Solution Support Architecture Document and detailed design each restated overlapping content in a different template, at a different gate, owned by a different group.

In Gantry these become artefact declarations over one module set. The SOAP renders the shaping modules for a business case audience. The detailed design renders the same architecture and integration modules at greater depth for the build team. Nothing is transcribed from one to the other, because there is nothing to transcribe.

The level of content remains proportionate to the increment: a small, familiar change completes fewer modules, and the definition marks which modules are mandatory per gate rather than requiring the full set every time.

Read the design definition before writing your own — not because your process resembles design, but because it is a worked example of how to decompose a document set into modules without smuggling the old templates back in.

## Working with agents

The definition is the contract. Because every module carries a machine-readable purpose, field list and guidance, an agent can be pointed at an instance and told to complete a module without further prompting — the spec *is* the prompt.

- `gantry status --json` and `gantry check --json` let an agent determine what's missing and act on it.
- Modules are independent files. Parallel agents can work on separate modules without conflict.
- Keep agent output in the module files, never in rendered artefacts — an agent editing `out/` is doing the equivalent of editing a build artefact.
- Frontmatter `status:` (`draft`, `review`, `agreed`) distinguishes agent-drafted content from human-agreed content at the gate.

---

# Build and Test

## Build

```bash
npm install
```

There is no build/compile step — the CLI and engine (`bin/`, `lib/`) run directly as Node ESM, and the web app (`web/`) is static, served as-is by `gantry serve`.

## Test

```bash
npm run test:unit      # engine unit & integration tests (node --test, excludes Playwright)
npm run test:e2e       # Playwright browser tests (web UI)
npm test               # node --test with no filter — runs every *.test.js, Playwright specs included
```

`npm run test:unit:ci` runs the same unit suite with coverage gates (`--test-coverage-lines=80`, `--test-coverage-branches=75`, `--test-coverage-functions=70` over `lib/`, `bin/`, `web/`) plus JUnit XML and LCOV output; `npm run test:e2e:ci` does the same for the Playwright suite.

## Validating definitions and instances

`gantry validate <definition> [--json]` reports every structural problem with a definition in one pass — a missing module reference, an invalid field type, a `required`/`required-at` conflict — instead of fixing one, rerunning, and hitting the next.

`gantry check <slug> [--gate <id>] [--json]` validates an instance against a gate's requirements, PASS/FAIL with a matching exit code. Defaults to the instance's current stage; `--gate` resolves any stage's gate, so you can check readiness for a later gate before the instance actually gets there.

`gantry render my-initiative soap --dry-run` resolves the template without writing anything, and fails fast (with a descriptive error) if the definition, an instance module reference, a field type, or a `required`/`required-at` conflict is malformed.

## Continuous integration

`azure-pipelines.yml` (repo root) has no CI or PR triggers of its own (`trigger: none`, `pr: none`) — it runs only when an Azure DevOps branch-protection build-validation policy invokes it. The pipeline does a single `docker build` of `ContainerFile`, whose stages run `npm run test:unit:ci`, `npm run test:e2e:ci`, and `npm run render:examples` (rendering the `examples` fixture for `soap`, `hld`, `sad`, `ssad` and `as-built`). Test results and coverage are embedded in the image and extracted afterwards; the pipeline's `PublishTestResults` (`failTaskOnFailedTests`) and the render stage's non-zero exit are the gates.

---

# Contribute

**New definitions are the most useful contribution.** If you have a staged, gated process that currently runs on a set of Office templates, it is a candidate — write the definition and the module specs, and see whether the artefacts fall out of it. If they don't, that usually tells you something interesting about the process.

To propose one:

1. Open an issue describing the process, its stages and its gates, before writing the YAML. The decomposition is the hard part and it is much cheaper to argue about in prose.
2. Add `definitions/<id>/1/` with a definition, module specs and at least one artefact template (numbered version dirs — see "Definition schema" above — each version carries its own `definition.yaml`, `modules/`, `templates/` and `CHANGELOG.md`).
3. Add an example instance so CI can render it.
4. Run `gantry validate <id>` and `npm test`, then raise a pull request.

For engine changes, one rule governs: **if supporting a new process requires changing the engine, treat that as a design problem first.** Sometimes the engine genuinely is missing something — conditional stages and cross-module dependencies are known gaps. More often the definition is trying to encode a document rather than a process, and the fix belongs in the definition.

Conventions:

- Module ids are lower-kebab-case and name the *content*, not the section of a document it used to live in.
- Guidance text in module specs is written for the person filling it in, not for a reviewer.
- Never add a field that exists only to satisfy a template's layout.
- Comment/prose text (code comments, `CONTEXT.md`, `docs/adr/`) is written one paragraph per line, not hard-wrapped at a fixed column — see `docs/adr/0015`.

# Container demo

A multi-stage `ContainerFile` at the repo root builds a minimal runtime image (`node:24-slim` base) with Node.js 24, Pandoc, Git and unzip — everything needed to serve the web UI and render artefacts. Verification stages (`test`, `test-e2e`, `render`) run inside the same `ContainerFile`; the `runtime` stage is the only one shipped.

## Build the image

```bash
docker build -f ContainerFile -t gantry .
```

To build behind a TLS-intercepting proxy, pass the CA at build time (see also [Corporate proxy / custom CA certificates](#corporate-proxy--custom-ca-certificates)):

```bash
podman build --file ContainerFile \
  --volume /etc/ssl/certs/ca-certificates.crt:/certs/corporate-ca.pem:ro \
  --env NODE_EXTRA_CA_CERTS=/certs/corporate-ca.pem -t gantry .
```

## Run locally

```bash
docker run -p 3000:3000 gantry
```

Open http://localhost:3000 in a browser. The dashboard lists the instances shipped with the repo: `examples`, a fully worked design (Kiwi Cover Mutual's claims handling modernisation) with content and diagrams for every stage, and `gantry`, Gantry's own Azure Container Apps hosting proposal as a complete Full SOAP with Mermaid diagrams (WI #354; identifiers are angle-bracket placeholders, not real Contoso resources). Click any instance to view its stages, modules, and completeness. This one-liner uses the bundled `instances/` baked into the image — no volume mounts, no env vars.

## Corporate proxy / custom CA certificates

If running behind a TLS-intercepting proxy (e.g. Zscaler), mount your certificate chain into the container and tell Node.js to trust it via `NODE_EXTRA_CA_CERTS`:

```bash
docker run -d \
  --name gantry \
  --publish 3000:3000 \
  --volume /etc/ssl/certs/ca-certificates.crt:/certs/corporate-ca.pem:ro \
  --env NODE_EXTRA_CA_CERTS=/certs/corporate-ca.pem \
  gantry serve
```

For `npm install` TLS failures on Windows itself (not in a container), see the Windows note under Installation above.

## Render an artefact

The default entrypoint is `node bin/gantry.js`, so any gantry subcommand can be passed directly:

```bash
# Render the SOAP artefact for the "examples" instance
docker run gantry render examples soap

# Extract the rendered .docx to your host
docker run -v "$(pwd)/output:/app/instances/examples/out" gantry render examples soap
```

After the volume-mounted run, the rendered document is at `./output/Examples - Solution on a Page.docx` —
rendered artefacts are named `<Instance name> - <Full artefact title>.docx` (the instance's `name:`, or a
title-cased form of its slug, plus the artefact's title from the definition).

## Other commands

```bash
# List instances
docker run gantry instances

# Check gate status
docker run gantry status examples

# Validate the design definition
docker run gantry validate design
```

## Customise

| Override | How |
|---|---|
| Port | `docker run -p 3000:3000 gantry serve --port 3000` or `-e PORT=3000 -p 3000:3000 gantry serve` (see Port below) |
| Instances directory | `-e GANTRY_INSTANCES_DIR=/data -v gantry-data:/data` (see Persistence below) |
| Your own definitions/instances | Mount a volume: `-v /path/to/your/repo:/app` |
| Custom CA certs | `-v /etc/pki/tls/certs/ca-bundle.crt:/certs/ca-bundle.crt:ro -e NODE_EXTRA_CA_CERTS=/certs/ca-bundle.crt` |
| Shell into the container | `docker run -it --entrypoint sh gantry` |

## Deploying to a server (UAT / production)

For a long-running deployment, run the published image from the registry built by `azure-pipelines.release.yml` rather than rebuilding from source on the server.

If you do run from a source checkout on the host, once the repo is there and dependencies are installed, `npm link` (or adding `bin/` to `PATH`) makes `gantry <command>` work directly, and `node bin/gantry.js <command>` always works regardless.

### Published image and tags

`azure-pipelines.release.yml` builds `ContainerFile --target runtime` and pushes three tags on every push to `main`:

- `gantry:<version>` — the `version` from `package.json` (e.g. `0.0.1`)
- `gantry:<short-sha>` — the first 8 characters of `$(Build.SourceVersion)` (the commit that triggered the build)
- `gantry:latest` — always the most recent `main` build

Pull whichever tag matches your promotion model. For a pinned UAT, use the version or short SHA; for "latest UAT", use `latest`. The first release will be `0.0.1`; later releases bump `package.json` and get a new version tag automatically.

### Access control

Gantry has no built-in authentication — this is intentional. Each user supplies their own Azure DevOps PAT in the browser: the web UI stores it in `localStorage` and forwards it as HTTP Basic on every API request that needs it (instance reads/writes, work-item linking). There is no server-side session or shared credential.

Gate access at the network layer (VPN, private network, reverse proxy with SSO, firewall rules) rather than inside the app. Treat Gantry as an internal tool that assumes the network has already authenticated the caller.

### Persistence

The container's filesystem is ephemeral — use a persistent volume for instance data:

```bash
docker run -d \
  --name gantry \
  -p 3000:3000 \
  -e GANTRY_INSTANCES_DIR=/data \
  -v gantry-data:/data \
  --restart unless-stopped \
  gantry
```

Or with Compose (see `compose.yaml` at the repo root):

```bash
GANTRY_IMAGE=gantry:0.0.1 docker compose up -d
```

- `GANTRY_INSTANCES_DIR` tells the server (and the `new`/`status`/`check`/`render`/`instances` CLI commands) where to read/write `instance.yaml` and `modules/*.md`. The image's `instances/` baked into `/app/instances` is still there, but when `GANTRY_INSTANCES_DIR` points elsewhere (e.g. `/data`) that directory is used instead.
- The bundled `examples` fixture ships inside the image at `/app/instances`. When you switch the data dir to `/data`, it will not appear on the dashboard — this is expected. Seed the volume once (copy it in, or create a fresh instance with `docker exec gantry node bin/gantry.js new design my-instance --instances-dir /data`).
- The runtime image runs as `USER node` (uid 1000) and does `mkdir -p instances && chown -R node:node /app` at build time, so the baked-in `instances/` is writable by `node`. For a **named volume** (`gantry-data:/data`), Docker initialises ownership correctly — no extra steps.
- For a **bind mount** (`-v "$PWD/my-data:/data"`), the host directory must be writable by uid 1000: `mkdir -p my-data && chown 1000:1000 my-data` (or `chmod 777 my-data` if `chown` is not possible). Without this, writes from `USER node` will fail with `EACCES`.

### Port

Inside the container Gantry always listens on `3000` (`EXPOSE 3000`, `CMD ["serve", "--port", "3000"]`). Map it to any host port with `-p`:

```bash
docker run -p 3000:3000 gantry          # host 3000 → container 3000
docker run -p 8080:3000 gantry          # host 8080 → container 3000
```

To change the in-container port, set `PORT` or pass `--port` — the server resolves it as `--port` flag > `PORT` env > `3000` (and `--instances-dir` as `--instances-dir` flag > `GANTRY_INSTANCES_DIR` env > `instances`):

```bash
docker run -e PORT=4000 -p 4000:4000 gantry serve
docker run -p 4000:4000 gantry serve --port 4000
```

`compose.yaml` maps `3000:3000` by default; change the left side to expose a different host port.

### Outbound network

When instances are backed by Azure DevOps (workspaces), the server (and CLI) makes outbound HTTPS calls to `https://dev.azure.com` (or your on-premises Azure DevOps Server if configured). The host running the container must allow egress to that host.

If that egress goes through a TLS-intercepting proxy, mount the corporate CA and set `NODE_EXTRA_CA_CERTS` as shown in [Corporate proxy / custom CA certificates](#corporate-proxy--custom-ca-certificates) and in the commented block inside `compose.yaml`:

```yaml
# in compose.yaml, uncomment inside the gantry service:
# environment:
#   - NODE_EXTRA_CA_CERTS=/certs/corporate-ca.pem
# volumes:
#   - /etc/ssl/certs/ca-certificates.crt:/certs/corporate-ca.pem:ro
```

### Health and restart

The `runtime` stage declares a `HEALTHCHECK`:

```
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node","-e","fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
```

Docker (or an orchestrator) will mark the container `healthy` once `GET /` returns 200. Use `--restart unless-stopped` (or `restart: unless-stopped` in Compose) so the container comes back after a reboot. Check health with:

```bash
docker inspect --format '{{.State.Health.Status}}' gantry
```

### Upgrade

To upgrade without losing data:

```bash
docker pull gantry:0.0.2          # or gantry:latest / gantry:<short-sha>
docker rm -f gantry
docker run -d --name gantry \
  -p 3000:3000 \
  -e GANTRY_INSTANCES_DIR=/data \
  -v gantry-data:/data \
  --restart unless-stopped \
  gantry:0.0.2
```

Or with Compose:

```bash
GANTRY_IMAGE=gantry:0.0.2 docker compose up -d
```

Recreating the container against the same named volume preserves all instances. No migration is needed — instance data is plain files under the volume.

## Issues

1. For testing with git dependencies it is using the source git folder instead of setting up a dedicated fixture
