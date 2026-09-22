# Introduction

**Gantry is a repo-driven pipeline for staged, gated processes. Capture the data once; render whatever document the gate asks for.**

Gantry separates the *content* of a process from the *documents* that process produces. You describe a process as a **definition** — its stages, its gates, its module specs — and Gantry runs it. People (or agents) fill in modules as flat files in a Git repo. Artefacts — a Solution on a Page, a business case, a handover pack — are rendered from that data on demand.

There is one set of data, not five documents that drift apart.

Gantry itself knows nothing about design, procurement or anything else. Every use case is a definition, and definitions are configuration.

Jump to [Executive Summary](docs/exec-summary.md)

<img width="1438" height="882" alt="image" src="https://github.com/user-attachments/assets/5a5d7010-30ba-47bf-987c-acc902bbd766" />

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
| **Provider** | The external suite a Server-hosted workspace's repo and work items both come from — **Azure DevOps** (Repos + Boards) and **GitHub** (repos + Issues) today, plus **GitLab** (Projects + Issues, `gitlab.com` or self-hosted CE/EE) built at the same full parity (`docs/adr/0041-gitlab-as-third-provider.md`); **Atlassian** (Bitbucket + Jira) is modelled but not built. A workspace names exactly one Provider, chosen when it is registered (`docs/adr/0037-provider-as-a-suite-one-per-workspace.md`). |
| **Workspace** | Where an instance's data lives — **Server-hosted** or **Local**, chosen as the "+ New Workspace" wizard's own "Workspace location" step (`CONTEXT.md`'s "Workspace location" glossary entry, `docs/adr/0029-local-workspaces-client-filesystem.md`). A **Server-hosted workspace** is either a remote repository on a Provider (see "Backing an instance with a remote workspace" below) or a directory on the gantry server itself: registered through the wizard the first time you create an instance against it and reused by every later instance created against the same one, with its own free-text owner label, both editable from an instance's own Workspace Settings screen. A **Local workspace** is a folder on your own machine instead (see "Backing an instance with a local folder" below) — the gantry server keeps no record that it exists. |
| **Stage advancement** | How an instance moves from one stage to the next — which depends entirely on whether it's local or Workspace-backed (see "Stage advancement and approval" below). A **local** instance — including one whose data lives in a Local workspace, not just the legacy local-instance mode — advances self-serve via "Advance to next stage", blocked until its current gate has passed. A **Workspace-backed** instance (Server-hosted only; a Local workspace never qualifies) never advances self-serve: its stage's work lives on its own **stage branch** (`gantry-workspace/<slug>/<stageId>`, stacked on the prior stage's branch while that one's still open — so `main` only ever reflects fully-approved, merged stages), and it advances only when that stage's Pull Request is approved on its Provider (Azure DevOps or GitHub) and gantry merges it. There is no third mode and no per-instance opt-out. |
| **Artefact** | A rendered output. A document, a page, a summary. Generated, never hand-edited. Every artefact, `.md` and `.docx`, ends with a footer naming a short commit hash and date it was rendered from — the current local `HEAD` for a local instance, or (for a Workspace-backed one) the commit its content was pushed as on its Provider, one commit behind the file's own latest history entry, since a commit can't name its own hash — so a document can always be traced back to close to the exact version that produced it. |

The key rule: **artefacts are derived, modules are authored.** If you find yourself editing a rendered artefact, something is wrong with the module spec.

### The Definitions page

Definitions are versioned (numbered `definitions/<id>/<n>/` dirs — see "Definition schema" below). The **Definitions** page at `/definitions` — linked from the Workspaces page header as "Definitions" — is a first-class editor: an Outline/Map view switch over one focus pane (stage/artefact/module, with compact one-at-a-time field rows) and a docked, read-only Library panel. A published version is read-only, with a **View template source** button per artefact; a *draft* version is directly editable — every element can be reordered or moved between a stage, an artefact and a module by drag or an equivalent button, template editing opens as its own focus-pane view, and the toolbar shows a live problems count sharing the server's own validation rules (`findDefinitionProblemsInStructure`, WI #381). Also: creating a new draft version, a new definition (Blank or Clone), archiving/restoring, and publishing a draft. Save follows the stage Save convention: one Save for everything changed, with a Save/Discard/Cancel prompt on leaving with unsaved changes.

<img width="1613" height="844" alt="image" src="https://github.com/user-attachments/assets/67141d7a-c613-4ae6-9ff8-1d6b7dd44eba" />

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

**3. Install Git** (needed to clone the source below, and if you'll back any instance with a remote workspace — Azure DevOps or GitHub — not needed for local-folder-only instances, see "Backing an instance with a local folder" below)

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
| Git | 2.x+ | Needed to clone the source below and for any Workspace-backed instance (Azure DevOps or GitHub). Not needed for local-folder-only instances |
| A text editor | any | Modules are markdown; no tooling required to author them |

The web form (`web/`) is a static page with no build step — but it is **not** dependency-free: `gantry serve` generates a browser import map that serves Preact, `preact-iso`, `@preact/signals`, `htm`, CodeMirror 6, `markdown-it`, `DOMPurify`, pandoc-wasm and Mermaid straight out of `node_modules/` (see `docs/adr/0006-preact-frontend-framework.md`). That directory must exist wherever `gantry serve` runs — don't `npm prune --production` or ship without it.

Backing an instance with a remote Provider (Azure DevOps or GitHub) needs nothing installed locally — no Azure CLI, no `az` login, no `gh`. It needs that workspace's own **Personal Access Token** — Azure DevOps needs Code + Work Items (+ Identity Read), GitHub needs a fine-grained token with Contents + Issues + Pull requests + Metadata — entered once through the browser when prompted (see "Backing an instance with a remote workspace" below).

Backing an instance with a local folder needs nothing installed either — just a Chromium browser (Chrome or Edge; see "Backing an instance with a local folder" below).

Visually verifying a rendered `.docx` (not required to *use* Gantry, only to sanity-check output during development) additionally needs LibreOffice (`soffice`) and Poppler (`pdftoppm`).

## Latest releases

Release notes live in **[CHANGELOG.md](CHANGELOG.md)** — one section per tagged release, newest first. It's the one place a user can see what changed without reading commit messages or having access to this repo's own issue tracker.

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
├── workspaces/                   # the workspaces root (WI #355/#358) — every server workspace lives here
│   ├── instance-registry.json    # slug -> workspace/location map, gitignored
│   ├── workspace-registry.json   # provider + location entities (Azure DevOps org/project/repo, or
│   │                             # GitHub owner/repo), gitignored (docs/adr/0037)
│   ├── number-registry.json      # scoped numeric refs (ADR-0024): workspace/instance/stage ordinals, gitignored
│   └── <workspace-slug>/         # a server workspace directory — a folder with workspace.json,
│       ├── workspace.json        # same format a local (browser) workspace uses (ADR-0029/ADR-0031)
│       └── <initiative-slug>/    # a remote-workspace instance lives at gantry-workspace/<slug>/ in its
│           ├── instance.yaml     # own repo on its Provider instead (see below), never here
│           ├── modules/
│           │   ├── context.md
│           │   └── solution-definition.md
│           ├── assets/           # (WI260) local asset store — for a Workspace-backed instance the same dir lives as gantry-workspace/<slug>/assets/ in the repo on its Provider, sibling of modules/ and out/
│           └── out/              # rendered artefacts (gitignored by default)
├── lib/                          # the engine: definition/instance loading, render, status, the web server
│   ├── server.js                 # HTTP routes, incl. the work-item, workspace, stage-advancement/approval,
│   │                             # stage-review and synced-fields (Work item details card) endpoints
│   ├── instanceRegistry.js       # slug -> workspace/location lookup/registration (the registry above)
│   ├── workspaceRegistry.js      # provider + location entities instances reference (docs/adr/0037)
│   ├── provider.js / providerRegistry.js / providerErrors.js  # the four capability interfaces
│   │                             # (content store, pull requests, work items, identity) and
│   │                             # provider-neutral errors every provider implements (docs/adr/0039)
│   ├── numberRegistry.js         # scoped numeric workspace/instance/stage references layered over slugs
│   │                             # (docs/adr/0024-scoped-numeric-references-layered-over-slugs.md)
│   ├── azureDevOpsClient.js / azureDevOpsWorkItemsClient.js / azureDevOpsPullRequestsClient.js / azureDevOpsIdentityClient.js
│   │                              # PAT-authenticated Azure DevOps REST clients (Git, Work Items, Pull
│   │                              # Requests, Identity) — create a PR, read reviewer votes, complete/merge it
│   ├── githubClient.js / githubWorkItemsClient.js / githubPullRequestsClient.js / githubIdentityClient.js
│   │                              # the GitHub twins of the above (repo contents/branches/commits,
│   │                              # Issues, Pull Requests + reviews, collaborators/org members)
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
│   ├── repoCheck.js              # "does this repo (Azure DevOps or GitHub) already hold instance
│   │                             # data", incl. the legacy-root-to-gantry-workspace/<slug>/ migration
│   └── credential.js             # extracts a forwarded PAT from a request
├── bin/gantry.js                 # CLI entrypoint
└── web/
    ├── index.html                # app shell
    ├── app.js                     # dashboard + module editor (incl. stage advancement/approval panels,
    │                              # the Work item details card and the workspace-scoped instance switcher)
    ├── pages/new-workspace-wizard.js # "+ New Workspace" — pick/register a workspace, then instance fields
    ├── pages/settings.js         # /settings, /settings/workspace, /settings/instance — tab-free
    ├── pages/user-guide.js       # /user-guide — the in-product, end-user-facing User Guide (separate surface from this README)
    ├── pages/definition-viewer.js # /definitions — the Definitions page
    ├── lib/credential.js         # client-side PAT storage/prompt, one slot per workspace, no global default (docs/adr/0038)
    ├── lib/provider.js           # client-side Provider metadata (labels, which location fields each needs)
    ├── lib/ticketingSystem.js    # client-side default-ticketing-system setting (Azure DevOps workspaces only)
    ├── lib/apiFetch.js           # fetch wrapper: attaches the right PAT, retries once on 401
    ├── lib/validateRepo.js       # parses/checks the legacy Azure DevOps repo-URL adopt flow
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

**Use the form.** `gantry serve` opens a dashboard of every registered instance — local, remote-workspace-backed (Azure DevOps or GitHub), or living in a Local workspace on your own machine (see below). Opening one walks you through the process stage by stage, with the spec and guidance inline. A stage switcher lets you jump to any gate's screen, not just whichever stage the instance is currently at. Fill it in, hit render, get your document. Under the hood it writes the same files to the same repo (or the same Provider repo) — there is no second store, and no import/export step.

Each gate screen also has a "Clear all fields" button, blanking every field shown for that stage without touching the saved files until you hit each module's own Save button. To see what a filled-in gate screen looks like, `gantry serve` and open `examples` from the dashboard — a fixture instance with real content for every stage.

Neither path is the "real" one. They're two front ends onto the same data.

## Backing an instance with a remote workspace

An instance's data doesn't have to live on the machine running `gantry serve` — it can live in a repo on a **Provider** instead, with gantry acting as a form over it. This is useful when the people filling in modules aren't the people running the server. Gantry supports two Providers you can register a brand-new workspace against through this wizard today, at full parity: **Azure DevOps** (Repos + Boards) and **GitHub** (repos + Issues) — see `CONTEXT.md`'s **Provider** entry and `docs/adr/0037-provider-as-a-suite-one-per-workspace.md`. **GitLab** (Projects + Issues, `gitlab.com` or self-hosted CE/EE) is built at that same full parity at the capability layer — content store, stage branches, Merge-Request-gated sign-off, work items, identity, Library repos — per `docs/adr/0041-gitlab-as-third-provider.md`, but this wizard's own Register-a-new-workspace step doesn't offer it as a Provider choice yet, so it shows up as a known-but-disabled option in the picker for now; a GitLab-backed workspace is reachable today by adopting a Project that already holds instance data. A fourth, **Atlassian** (Bitbucket + Jira), is modelled in the schema but not implemented at all.

A repo backing instance data this way is a **workspace**: `instance.yaml` and `modules/` live at `gantry-workspace/<slug>/` inside it, not at repo root — so one workspace (one repo) can hold more than one instance, each in its own slug-named subdirectory, rather than being permanently tied to exactly one.

The landing page's sole creation entry point is **"+ New Workspace"** (`/new-workspace`) — a single wizard that covers both registering a brand-new workspace and adding another instance to one that already exists (there is no separate "+ New instance" action, and no paste-a-URL-first flow any more):

1. **Pick an existing workspace** from those this server already knows, or **register a new one**. Registering starts with a **Provider** choice, which drives everything after it: Azure DevOps collects `https://dev.azure.com/{organization}/{project}/_git/{repository}`-shaped fields (Organization/Project/Repository; an on-premises Azure DevOps Server base URL isn't supported here yet), while GitHub collects Owner/Repository (with an optional GitHub Enterprise Server base URL, gated behind an explicit server-side allow flag, the same SSRF protection an on-premises Azure DevOps Server base URL already has). Registering also sets that workspace's **Owner** in the same step — nothing else asks for it ahead of an instance existing in it. The PAT you're prompted for here proves real access to that exact repo before anything is recorded, and becomes that workspace's own PAT once registration succeeds (see the credentials paragraph below) — a failed registration discards it rather than storing it anywhere.
2. **Instance fields** — Name, Directory (defaulting to the slugified Name, overridable), and an initial Assignee.
3. **Work-item link** — every remote workspace tracks work items on its own Provider (a suite always supplies both halves — ADR-0037), so this step always runs for a Server-hosted workspace and never for a Local one: an Azure DevOps parent-work-item link with Organization *and* Project auto-filled read-only, Parent work item id / Work item type as real PAT-backed lookups; a GitHub parent-issue link the same way but with no Work item type field at all, since GitHub issues are untyped (`docs/adr/0040-github-work-item-and-review-model.md`).

**Credentials are per workspace, with no global fallback** (`docs/adr/0038-per-workspace-pat-no-global-credential.md`). The first request against a workspace with no PAT stored prompts for one, naming that workspace and its Provider; the PAT is stored in the browser (`localStorage`), scoped to that one workspace's slot, sent only to your own gantry server, and forwarded from there to the Provider as an HTTP Basic credential — gantry's own server never persists it. There is no default token that could be sent to the wrong Provider by accident. The scopes/permissions needed differ by Provider:

- **Azure DevOps**: **Code (Read & write)**, **Work Items (Read & write)**, and **Identity (Read)**.
- **GitHub**: a fine-grained token with **Contents**, **Issues** and **Pull requests** set to Read & write, and **Metadata** set to Read-only. A token missing one of these reports the repository itself as **not found** (GitHub's own documented behaviour — a permissions problem and a missing repository are indistinguishable from the HTTP response alone), so a bare "repository not found" is worth re-checking the token's permissions for before assuming the owner/repository name is wrong.
- **GitLab**: a Personal, Project or Group Access Token with the **api** scope (or, narrower, **read_repository** and **write_repository** together with API access to Issues and Merge Requests). GitLab, like GitHub, reports a Project as **not found** for a token missing a required scope, the same response a genuinely missing namespace/project produces.

If you upgrade from a version that stored a single global PAT, it's copied automatically into every workspace registered at the time, once, on first load — nothing needs re-entering, and the old global entry is then removed.

Settings is three separate, tab-free screens, reached differently depending on where you are:

- From the dashboard (Home), **Settings** goes straight to **Global Settings** (`/settings`) — no intermediate step.
- From an open instance, **Settings** opens a dropdown offering **Global Settings**, **Workspace Settings**, and **Instance Settings**.

Each screen's own back control returns to wherever it was actually opened from (Home, or that same instance screen) — not browser history — falling back to Home for a direct/bookmarked Settings URL.

- **Global Settings** (`/settings`) — the **Advanced mode** toggle, off by default (see "Backing an instance with a local folder" below), and a **default ticketing system** selector that only ever affects a *new* Azure DevOps workspace's own ticketing-system override (Jira is listed but disabled). There is no global PAT control here any more, for any Provider — see the credentials paragraph above.
- **Workspace Settings** (`/settings/workspace`, from an instance's own Settings dropdown) — the workspace *behind that one instance* (never a picker across every registered workspace): its Provider and repo location, a free-text **owner** label, and that workspace's own **PAT** — set, replace or clear it, with no effect on any other workspace. For an Azure DevOps workspace only, a **ticketing-system** override is also shown (Jira is listed but disabled — a GitHub or GitLab workspace has no such choice, since its tracker is fixed by its Provider, GitHub Issues or GitLab Issues respectively). It also offers **Archive** — a reversible "set aside" that drops the workspace out of the default dashboard and API listings without deleting anything on disk or on the Provider (blocked while it still has an active instance; `?archived=1` reveals archived rows for a per-row Restore). A local instance has no workspace, so this screen reports that instead.
- **Instance Settings** (`/settings/instance`, from an instance's own Settings dropdown) — that instance's own stored **Assignee** (editable), read-only instance info (slug, definition, current stage), and a read-only view of its linked work item (organization/project or owner/repository, parent work item/issue, type where the Provider has one, and each stage's own child work item id). Re-linking isn't supported here or anywhere else after creation — linking happens only at instance creation (see "Linking an instance to a tracked work item" below). This screen also offers **Archive** for the instance itself — the same reversible set-aside as for a workspace; an archived instance still resolves read-only at its direct URL.

Once registered, a server-workspace-backed and a remote-workspace-backed instance are indistinguishable from the dashboard's point of view — same listing, same module editor, same render command, regardless of which Provider a remote workspace uses. Where each one's data actually lives is tracked server-side across three registry files at the workspaces root (`workspaces/instance-registry.json`: slug -> workspace; `workspaces/workspace-registry.json`: workspace -> provider/location/owner/ticketing-system/`archived`, for a remote workspace, or -> its own `workspace.json`, for a server workspace directory; `workspaces/number-registry.json`: the scoped numeric ordinals of ADR-0024 — all gitignored, application state, not source), not in any client-visible config. A flat, pre-Provider record is read forward into the nested `{provider, location}` shape automatically the first time it's touched, and rewritten in that shape on next write — there is no separate migration step to run.

## Backing an instance with a local folder

An instance's data doesn't have to live on the machine running `gantry serve`, or in a repo on a Provider either — it can live in a folder on the *browser user's own machine* instead, picked directly through the browser (`docs/adr/0029-local-workspaces-client-filesystem.md`; see also the "Workspace location" entry in `CONTEXT.md`'s glossary). Choose this when you want your data to never leave your machine: gantry's server keeps no registry entry, no row and no numeric reference for a Local workspace — the folder itself, plus this browser's own cache of it, is the only record that it exists anywhere.

This needs **Chrome or Edge**. It's built on the File System Access API (`showDirectoryPicker()`), which is Chromium-only; in Firefox and Safari the wizard still offers the Local option but disables it, with "Local workspaces need Chrome or Edge" shown in its place. Server-hosted workspaces have no such restriction.

By default the "+ New Workspace" wizard skips the location question entirely and takes you straight into this flow — the Server-hosted option, and the rest of the Provider / work-item / sign-off UI, only appears once **Advanced mode** is turned on from Global Settings (`/settings`). With Advanced mode on, the wizard's first step becomes an explicit **Workspace location: Server-hosted | Local** choice.

**Creating one.** Choose **Local**, then:

1. **Pick a new or empty folder.** Gantry writes `gantry-workspace/` inside it — a folder that already has a `gantry-workspace/` in it is refused here (open it with "Pick existing local workspace" instead).
2. **Name the workspace** (an optional free-text owner too) — this is written into a `workspace.json` marker at the folder root, `{ name, owner, kind: "local", createdAt }`, which is what makes the folder recognisable as a gantry workspace the next time anyone opens it.
3. **Instance fields** — Definition, Name, Directory (defaulting to the slugified Name) and an initial Assignee, same as the Server-hosted flow. There is no work-item step: a Local workspace has no Provider, so there is nothing to link to.

**Reopening one.** The quickest path back is the **Local workspaces** panel the Workspaces landing page shows once this browser remembers any — each row opens straight to its instances once permission is confirmed, offers **Click to open** / **Reopen** when a permission or the folder itself needs re-confirming (the normal state after a browser restart, or the first time in a new browser or machine), and a per-row **Remove** that only forgets the browser's cache, never anything on disk. The wizard's own **Local → Pick existing local workspace** step does the same job from inside the wizard: **Open folder** browses to any folder holding a `gantry-workspace/workspace.json`, and its **Recent local workspaces** list re-offers folders opened before, each with the same **Grant access** re-permission step when needed.

**Disk layout.** A Local workspace mirrors the layout a Server-hosted remote workspace uses exactly:

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

**No ticketing.** A Local-workspace instance has no linked work item, no "Check gate & sync work item", no Review/Sign-off flow, no stage branches and no Pull Requests. It advances exactly the way a server-workspace instance does (see "Stage advancement and approval" below): once the current stage's gate passes, **Advance to next stage** moves it on directly, self-serve, with no approval ceremony. This is a genuinely different thing from a **server workspace** instance (data stored server-side under `workspaces/`, reachable by `gantry serve` on the box, not picked in the browser) — both are "local" in the everyday sense, but one is data the server has no handle on at all and the other is data sitting right there on the box running `gantry serve`. See `CONTEXT.md`'s "Workspace location" entry for the fuller distinction.

## Linking an instance to a tracked work item

Optionally, an instance can be linked to a parent work item on its Provider — an Azure DevOps work item or a GitHub issue — so its progress is trackable where the rest of the team already looks. Linking happens when the instance is created, via the "+ New Workspace" wizard's work-item step (above) — a step every remote-workspace instance gets, so an instance has no linking path outside creation (the module editor's old free-text link form is gone, and an instance created without a link shows a "Link to a work item" prompt in its place pointing back at creation; re-linking isn't supported after the fact). A Local-workspace instance has no Provider, so it never gets this step or anything described below (see "Backing an instance with a local folder" above).

Linking creates one child work item per stage in the instance's definition underneath that parent, in one step — on GitHub, as a native sub-issue where the repository has that feature enabled, falling back to a task-list entry in the parent's body plus a `Part of #<n>` line in the child otherwise (`docs/adr/0040`). From then on:

- A **Work item details** card at the top of the instance screen shows the current stage's live tracking fields at a glance: the work item type (default `Task`; omitted entirely on GitHub, since issues are untyped), a title auto-populated as "{instance name} — {stage title}" but overridable per stage, the linked work item's own current Status read straight from the Provider, the stage's Pull Request state, and the Assignee (inherited from the instance's stored assignee, overridable per stage). The same card now also carries the stage's **Reviews & sign-off** — see "Stage advancement and approval" below — and its commit-history dialog.
- The card keeps a **Check gate & sync work item** action — it checks the currently-viewed stage's gate and, only if it passes, opens a confirmation dialog before pushing a new state to that stage's own work item; declining leaves the state untouched. On Azure DevOps the state actually pushed is drawn from whatever states the configured work item type genuinely supports in your project (via its own `getWorkItemTypeStates` lookup), never a fixed list Gantry invents — see `docs/adr/0011-azure-devops-work-item-linking.md`. For a Workspace-backed instance this gate-check-and-confirm step is folded into the card's single "Check status" click (WI217); a local instance keeps it as its own standalone button.
- On Azure DevOps, Gantry also tracks a custom review/sign-off status alongside native `System.State` (`Requested` / `In review` / `Changes requested` / `Approved` / `Rejected`), because the `Task` type's `System.State` transitions are locked — see `docs/adr/0024-custom-review-status-field.md`. On GitHub the same five-value status rides reserved `gantry:review/<status>` labels on the issue instead, created on demand — GitHub issues have no custom fields to carry it, and open/closed alone can't express five states (`docs/adr/0040`).
- For a **Workspace-backed** instance the linked work item is a board-visible tracking surface only (title, status, assignee) — it plays no part in gating stage advancement any more; that's the stage's Pull Request (see below), on every Provider.

## Stage advancement and approval

Nothing moves an instance from one stage to the next by itself — advancement is always explicit, and how it works depends entirely on whether the instance is local or Workspace-backed (`docs/adr/0012-stage-advancement-board-side-approval.md`, as reworked by `docs/adr/0014-pull-request-stage-approval.md`, which supersedes ADR-0012's ticketing-mode mechanism). In both modes the action is blocked until the current stage's gate has genuinely passed — re-checked server-side at the moment of the action, never trusted from an earlier client-side check — and multiple stages may sit pending approval concurrently: starting the next stage never waits on the previous one's approval.

**Local instances** advance self-serve: an "Advance to next stage" panel runs the gate check, asks for confirmation, and moves the instance's stage pointer directly — nothing is pushed anywhere else. The panel isn't rendered for a Workspace-backed instance at all, which has no self-serve path out of a stage. A Local-workspace instance (see "Backing an instance with a local folder" above) follows this exact same rule — the gate check runs through `/api/local/check` instead of `/api/instance/check`, but the panel, the confirmation, and the direct stage-pointer move are otherwise identical.

**Workspace-backed instances** are gated by a real Pull Request the Owner reviews *on the workspace's own Provider* — Azure DevOps or GitHub — there is no separate approve button inside gantry:

1. The moment the first save of a stage lands, that stage gets its own branch — `gantry-workspace/<slug>/<stageId>` — and every subsequent read/write targets it. If the previous stage's branch is still open (its PR unmerged), the new branch stacks on top of it rather than forking fresh from `main`, so work continues in sequence through approval latency; `main` itself only ever reflects fully-approved, merged stages.
2. Every module save re-renders whichever of the stage's artefacts have enough data and commits them to the same branch, so the eventual Pull Request's diff always carries the generated documents alongside the module files.
3. **Request Sign-off** (called "Request approval" in `docs/adr/0014`) opens that stage's Pull Request into `main` — the actual approval gate — but only once the stage's gate has passed. Committing to the branch before that is unrestricted throughout the stage; opening the PR is what's gated. Separately, **Request Review** (WI197) sends an informal, non-gating feedback request — one work item per reviewer (one Azure DevOps work item, or one GitHub issue) — available at any point in the stage. On GitHub this deliberately mirrors the Azure DevOps shape (one issue per reviewer) even though a single issue could take several assignees, because only separate issues can carry separate per-reviewer statuses.
4. The Owner reviews and votes on the Pull Request directly on the Provider. **Check status** then reads the PR's reviewer votes — explicitly distinguishing a rejection or changes-requested vote from a merely-still-pending review, so "the Owner asked for changes" never reads as an ambiguous "not yet approved". On GitHub, `APPROVED` and `CHANGES_REQUESTED` map to those two outcomes directly, while `COMMENTED` and `DISMISSED` read as still-pending, the same as no review at all (`docs/adr/0040`). The one "Check status" button on the Work item details card refreshes reviews and sign-off together.
5. On detecting approval, gantry completes (merges) the Pull Request itself with a merge commit, advances the instance's stage pointer, and pushes the linked work item's state where one is linked — one click resolves everything, with no second manual merge step. Detection stays manual (this explicit "Check status" click): no polling, no webhooks. On GitHub, a refusal from branch protection or a required check is surfaced back to you exactly as GitHub reported it, as a blocked sign-off — Gantry never retries the merge with a different merge method, since stage branches are stacked and squash/rebase would rewrite history a later stacked stage still depends on.

## Your first instance

```bash
gantry new design my-initiative                 # start an instance
gantry status my-initiative                     # what does the current stage need?
gantry check my-initiative --gate business-case # does it pass the gate? (any gate, not just the current stage's)
gantry serve my-initiative                      # fill it in via the form, or edit the files by hand
gantry render my-initiative soap                # produce the artefact
```

Instances live inside a **workspace** under the workspaces root, so a listing names both: `default/my-initiative`. Every command that takes a `<slug>` accepts either the bare slug or that workspace-qualified form — the qualified one matters only when the same slug exists in two workspaces, where a bare slug reports the ambiguity rather than guessing.

---

# Reference

## CLI

| Command | Does | Status |
|---|---|---|
| `gantry definitions [--json]` | List definitions available in this repo, with their stages and versions | Implemented |
| `gantry instances [--json]` | List instances available in this repo, with the workspace each lives in, its definition and current stage | Implemented |
| `gantry new <definition> <slug> [--owner <name>] [--assignee <name>]` | Create an instance, in the reserved `default` workspace — `--owner` seeds each first-stage module file's own frontmatter `owner`; `--assignee` sets the instance record's own stored assignee | Implemented |
| `gantry status <slug> [--json]` | Current stage, module completeness, what's outstanding | Implemented |
| `gantry check <slug> [--gate <id>] [--json]` | Validate an instance against a gate's requirements — any gate, not just the instance's current stage | Implemented |
| `gantry render <slug> <artefact> [--dry-run]` | Render an artefact to `out/` | Implemented |
| `gantry serve [slug] [--port <port>]` | Serve the web app (default port 3000): a dashboard of every registered instance at `/`, local or remote-workspace-backed (Azure DevOps or GitHub), and the stage-by-stage form at `/instance/<slug>`. `[slug]` only sets a fallback default for API requests made with no `?slug=<slug>` of their own — it doesn't change what the dashboard shows or require picking one instance up front. `/new-workspace` is the "+ New Workspace" wizard, `/settings` the Settings screens, `/user-guide` the in-product User Guide, `/definitions` the Definitions page (see "Backing an instance with a remote workspace" above) | Implemented |
| `gantry validate <definition> [--json]` | Report every structural problem with a definition in one pass | Implemented |
| `gantry backfill-numeric-refs` | One-time (idempotent) backfill of scoped numeric workspace/instance references (ADR-0024) for workspaces/instances that predate the feature | Implemented |

`definitions`, `instances`, `status`, `check` and `validate` all emit structured output with `--json` for scripting and agent use.

Every command that reads instance data takes `--workspaces-dir <path>` (or `GANTRY_WORKSPACES_DIR`) to point at a workspaces root other than `./workspaces`. A failure prints a single line explaining it; set `GANTRY_DEBUG=1` to get the full stack as well.

**Where definitions come from.** Definitions ship with Gantry, so every command finds them wherever you run it — you don't have to be standing in a Gantry checkout. If the working directory has a `definitions/` of its own it wins, so a checkout keeps working on its own definitions; `--definitions-dir <path>` names one explicitly. Instance data is the opposite and stays relative to where you are, which is why the two have separate flags.

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
    gate: hld-arb-approved
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
    gate: hld-arb-approved
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

A module can be required at more than one gate (e.g. `nfrs` at both `hld-arb-approved` and `build-ready-checklist`), with a field expected to be filled in progressively — light at the earlier gate, complete by the later one. `required: true|false` alone can't express that: it's one value, applied wherever the module appears.

For a field whose requiredness genuinely differs by gate, use `required-at` instead of `required` — a list of the gate ids at which the field becomes required. At any other gate the module is also required at, the field is optional.

```yaml
  - id: disaster-recovery-and-backup
    title: Disaster recovery and backup
    type: markdown
    required-at: [build-ready-checklist]
    guidance: >
      Recovery time/point objectives, backup schedule and retention. Light
      or absent at `hld-arb-approved`; required by `build-ready-checklist`.
```

Where a field's *content* genuinely changes shape across the gates its module spans — not just gains depth — model it as two fields on the shared module instead of one field with `required-at`. See `definitions/design/1/modules/dependencies.yaml`: `dependencies-overview` (narrative, required at the earlier gate) and `dependency-list` (structured, required at the later gate) answer the same question in two different shapes, not two depths of one answer.

`required` and `required-at` are mutually exclusive on a field — use `required` for a field whose requiredness doesn't vary by gate (including fields in single-gate modules), and `required-at` only where it does. Don't reach for `required-at` by default; most fields don't need it.

## Instance module files

**`workspaces/<workspace>/my-initiative/modules/context.md`** — what someone actually writes:

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

Open http://localhost:3000 in a browser. The dashboard shows one **Examples** workspace shipped with the repo, holding two instances: `kiwi-cover-mutual`, a fully worked design (Kiwi Cover Mutual's claims handling modernisation) with content and diagrams for every stage, and `gantry`, Gantry's own Azure Container Apps hosting proposal as a complete Full SOAP with Mermaid diagrams (WI #354; identifiers are angle-bracket placeholders, not real Contoso resources). Click either instance to view its stages, modules, and completeness. This one-liner uses the bundled `workspaces/` baked into the image — no volume mounts, no env vars.

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
# Render the SOAP artefact for the "kiwi-cover-mutual" instance in the Examples workspace
docker run gantry render kiwi-cover-mutual soap --workspaces-dir workspaces/examples

# Extract the rendered .docx to your host
docker run -v "$(pwd)/output:/app/workspaces/examples/kiwi-cover-mutual/out" gantry render kiwi-cover-mutual soap --workspaces-dir workspaces/examples
```

After the volume-mounted run, the rendered document is at `./output/Kiwi Cover Mutual - Solution on a Page.docx` —
rendered artefacts are named `<Instance name> - <Full artefact title>.docx` (the instance's `name:`, or a
title-cased form of its slug, plus the artefact's title from the definition).

## Other commands

```bash
# List instances
docker run gantry instances

# Check gate status
docker run gantry status kiwi-cover-mutual --workspaces-dir workspaces/examples

# Validate the design definition
docker run gantry validate design
```

## Customise

| Override | How |
|---|---|
| Port | `docker run -p 3000:3000 gantry serve --port 3000` or `-e PORT=3000 -p 3000:3000 gantry serve` (see Port below) |
| Workspaces directory | `-e GANTRY_WORKSPACES_DIR=/data -v gantry-data:/data` (see Persistence below) |
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

Gantry has no built-in authentication — this is intentional. Each user supplies their own Personal Access Token in the browser, one per remote workspace with no global fallback (`docs/adr/0038-per-workspace-pat-no-global-credential.md`): the web UI stores each token in `localStorage`, scoped to the workspace it was entered for, and forwards it as HTTP Basic on every API request that needs it (instance reads/writes, work-item linking) to whichever Provider — Azure DevOps or GitHub — that workspace uses. There is no server-side session or shared credential.

Gate access at the network layer (VPN, private network, reverse proxy with SSO, firewall rules) rather than inside the app. Treat Gantry as an internal tool that assumes the network has already authenticated the caller.

### Persistence

The container's filesystem is ephemeral — use a persistent volume for instance data:

```bash
docker run -d \
  --name gantry \
  -p 3000:3000 \
  -e GANTRY_WORKSPACES_DIR=/data \
  -v gantry-data:/data \
  --restart unless-stopped \
  gantry
```

Or with Compose (see `compose.yaml` at the repo root):

```bash
GANTRY_IMAGE=gantry:0.0.1 docker compose up -d
```

- `GANTRY_WORKSPACES_DIR` tells the server (and the `new`/`status`/`check`/`render`/`instances` CLI commands) where to read/write server workspaces — each a folder with its own `workspace.json` and instance subdirectories. The image's `workspaces/` baked into `/app/workspaces` is still there, but when `GANTRY_WORKSPACES_DIR` points elsewhere (e.g. `/data`) that directory is used instead. `GANTRY_INSTANCES_DIR` still works as a deprecated alias, resolving to the same value with a one-line deprecation notice logged.
- The bundled `Examples` workspace ships inside the image at `/app/workspaces/examples`. When you switch the data dir to `/data`, it will not appear on the dashboard — this is expected. Seed the volume once (copy `workspaces/examples` in, or start the server against `/data` so it migrates/creates the reserved `default` workspace, then create a fresh instance inside it: `docker exec gantry node bin/gantry.js new design my-instance --workspaces-dir /data/default`).
- The runtime image runs as `USER node` (uid 1000) and does `mkdir -p workspaces && chown -R node:node /app` at build time, so the baked-in `workspaces/` is writable by `node`. For a **named volume** (`gantry-data:/data`), Docker initialises ownership correctly — no extra steps.
- For a **bind mount** (`-v "$PWD/my-data:/data"`), the host directory must be writable by uid 1000: `mkdir -p my-data && chown 1000:1000 my-data` (or `chmod 777 my-data` if `chown` is not possible). Without this, writes from `USER node` will fail with `EACCES`.

**Or, bootstrap workspaces from an env var instead of a volume.** Set `GANTRY_BOOTSTRAP_WORKSPACES` to a JSON array of workspace declarations and every `gantry serve` startup registers them again, idempotently — restarting twice creates no duplicates and keeps the same workspace ids, so an ephemeral container filesystem stops mattering for the workspaces you name here. Unlike the volume approach above, this never repoints `GANTRY_WORKSPACES_DIR`, so the bundled `Examples` workspace keeps working alongside whatever you declare. Each declaration is `{"provider", "location", "owner"}` (provider defaults to `azure-devops`; add an explicit `"id"` only if you need to pin a specific workspace id rather than the one derived from provider + location):

```bash
docker run -d \
  --name gantry \
  -p 3000:3000 \
  -e GANTRY_BOOTSTRAP_WORKSPACES='[{"provider":"github","location":{"owner":"cgbarlow","repository":"gantry-workspace-testing"},"owner":"c.barlow"}]' \
  --restart unless-stopped \
  gantry
```

A workspace registered this way derives a stable id from its provider + location, so a `GANTRY_WORKSPACE_PATS` entry keyed by that id (see the MCP server docs) survives a restart even with the registry file deleted. A malformed `GANTRY_BOOTSTRAP_WORKSPACES` — invalid JSON, an unknown `provider`, or a declaration missing its `location` — fails startup with a single actionable line rather than booting into a half-configured server.

**To read those ids, use `gantry workspace-id` — no server, no registry, no boot required.** Both PAT maps below (`GANTRY_SHARED_WORKSPACE_PATS` here, `GANTRY_WORKSPACE_PATS` in the MCP server) are keyed by workspace id, and this command computes the same id the server derives. Name a location on the command line, for any provider:

```bash
gantry workspace-id --provider github --owner cgbarlow --repository gantry-workspace-testing
# 017ed5e6-a18c-573a-9621-4c91c47ab907
```

…or give it no location at all and it reads the same `GANTRY_BOOTSTRAP_WORKSPACES` value the server reads, printing one id per declaration — with `--json` emitting a ready-to-paste `GANTRY_SHARED_WORKSPACE_PATS` skeleton you fill the tokens into rather than transcribing UUIDs:

```bash
export GANTRY_BOOTSTRAP_WORKSPACES='[{"provider":"github","location":{"owner":"cgbarlow","repository":"gantry-workspace-testing"},"owner":"c.barlow"}]'

gantry workspace-id
# 017ed5e6-a18c-573a-9621-4c91c47ab907  github cgbarlow/gantry-workspace-testing

gantry workspace-id --json
# {
#   "017ed5e6-a18c-573a-9621-4c91c47ab907": ""
# }
```

An unknown `--provider`, a missing location field, or a malformed `GANTRY_BOOTSTRAP_WORKSPACES` fails with the same single actionable line startup would give. No PAT is read, printed, or logged by this command — it deals in ids only.

`gantry serve` also logs one line per bootstrapped workspace at startup, naming the location and the id it is registered under (`gantry serve: bootstrapped workspace github cgbarlow/gantry-workspace-testing — id 017ed5e6-…`), so on a hosted platform the deploy log is enough. Prefer that line over the command when a server already has workspaces registered: `gantry workspace-id` prints the id a declaration *would* derive, while a workspace already registered at that location keeps whatever id it was first registered under — bootstrap never re-keys an existing workspace.

Registering a workspace this way (or restoring a workspace registration after the registry file was deleted) is not the same as having its instances show up on the dashboard: a Provider-backed workspace has no local directory for the usual instance-registry backfill to scan, so its instances are instead discovered by listing `gantry-workspace/` in its own repo — but only once a request actually carries a credential for it. That means a freshly bootstrapped workspace's instances appear on the *first authenticated request* against `GET /api/instances`, not at server boot — the container can be up and serving before anyone has supplied a PAT for that workspace, and its instances simply aren't listed yet. Once discovered, they're registered like any other instance and no later request re-lists the repo.

**Optionally, share a workspace with every visitor to this deployment — no credential of their own required.** Set `GANTRY_SHARED_WORKSPACE_PATS` — off by default, opt in only if you need it — to a JSON object mapping workspace id to PAT, `{"<workspaceId>": "<pat>", ...}`, the same shape as `GANTRY_WORKSPACE_PATS` (see the MCP server docs). Get the ids to key it by from `gantry workspace-id --json` above (or the `gantry serve` startup log) — you never have to boot the server and read `GET /api/workspaces` to find them.

This is a real, security-relevant decision, not a startup convenience (`docs/adr/0047-a-workspace-can-be-shared-by-its-deployment.md`): a workspace with an entry here is *shared*, meaning **anyone who can reach this deployment can browse it** — `GET /api/instances` falls back to this credential for any request that carries none of its own, for that one workspace only. It does two things at once. First, at boot, `gantry serve` runs a one-time discovery pass for any workspace `GANTRY_BOOTSTRAP_WORKSPACES` just registered that also has an entry here, so `GET /api/instances` already has that workspace's rows in its registry before anyone has loaded the dashboard — useful for an unattended deployment (the hosted demo, for one) where "restored" and "still empty" would otherwise look identical until someone shows up. Second, and this is the actual point of the setting, every later anonymous request to `GET /api/instances` resolves that same credential again, per row, for that workspace — a viewer with their own PAT for it still uses their own, never the shared one. This is a genuine trade-off, not a free win: it means the server itself holds a read credential for that workspace, which `docs/adr/0038-per-workspace-pat-no-global-credential.md`'s "no server-side credential, no fallback" deliberately avoided everywhere else — see `docs/adr/0047` for why this is scoped the way it is, and `docs/adr/0046-boot-time-bootstrap-pats-amend-adr-0038.md` for the narrower, boot-only exception this supersedes. It is used for reads only — never for a write, which always resolves the requesting person's own credential or does not proceed — never returned by any API response, never written to any registry file, and never logged. A workspace whose shared PAT is missing, rejected, or expired simply has that row omitted, logged by workspace id only; startup and every other row are unaffected:

```bash
docker run -d \
  --name gantry \
  -p 3000:3000 \
  -e GANTRY_BOOTSTRAP_WORKSPACES='[{"provider":"github","location":{"owner":"cgbarlow","repository":"gantry-workspace-testing"},"owner":"c.barlow"}]' \
  -e GANTRY_SHARED_WORKSPACE_PATS='{"017ed5e6-a18c-573a-9621-4c91c47ab907":"<its-github-pat>"}' \
  --restart unless-stopped \
  gantry
```

A malformed `GANTRY_SHARED_WORKSPACE_PATS` — invalid JSON, not a JSON object, or an entry whose value isn't a non-empty string — fails startup with a single actionable line, the same as a malformed `GANTRY_BOOTSTRAP_WORKSPACES` does. Without an entry for a given workspace, reading its Provider-backed rows still needs a per-request credential exactly as before — so an anonymous request to `GET /api/instances` returns nothing for that workspace's instances either way.

**Upgrading an existing deployment:** this env var name changed (see `CHANGELOG.md`) — rename it in your deployment config, or it will simply be ignored and that workspace stays unshared (an unset value is a no-op, not an error, so a stale old name fails silently rather than loudly).

### Port

Inside the container Gantry always listens on `3000` (`EXPOSE 3000`, `CMD ["serve", "--port", "3000"]`). Map it to any host port with `-p`:

```bash
docker run -p 3000:3000 gantry          # host 3000 → container 3000
docker run -p 8080:3000 gantry          # host 8080 → container 3000
```

To change the in-container port, set `PORT` or pass `--port` — the server resolves it as `--port` flag > `PORT` env > `3000` (and the workspaces directory as `--workspaces-dir` flag > `GANTRY_WORKSPACES_DIR` env > `--instances-dir` flag (deprecated) > `GANTRY_INSTANCES_DIR` env (deprecated) > `workspaces`):

```bash
docker run -e PORT=4000 -p 4000:4000 gantry serve
docker run -p 4000:4000 gantry serve --port 4000
```

`compose.yaml` maps `3000:3000` by default; change the left side to expose a different host port.

### Outbound network

When instances are backed by a remote workspace, the server (and CLI) makes outbound HTTPS calls to that workspace's Provider — `https://dev.azure.com` (or your on-premises Azure DevOps Server if configured) for Azure DevOps, `https://api.github.com` (or your GitHub Enterprise Server host if configured) for GitHub, `https://gitlab.com` (or your self-hosted GitLab CE/EE host if configured) for GitLab. The host running the container must allow egress to whichever host(s) your workspaces actually use.

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
  -e GANTRY_WORKSPACES_DIR=/data \
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
