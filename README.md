# Introduction

**Gantry is a repo-driven pipeline for staged, gated processes. Capture the data once; render whatever document the gate asks for.**

Gantry separates the *content* of a process from the *documents* that process produces. You describe a process as a **definition** — its stages, its gates, its module specs — and Gantry runs it. People (or agents) fill in modules as flat files in a Git repo. Artefacts — a Solution on a Page, a business case, a handover pack — are rendered from that data on demand.

There is one set of data, not five documents that drift apart.

Gantry itself knows nothing about design, procurement or anything else. Every use case is a definition, and definitions are configuration.

Jump to [Executive Summary](exec-summary.md)

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
| **Definition** | A reusable process description. Design is one definition. Business case, procurement, incident review and operational handover are others. A Gantry repo can hold as many as you need. |
| **Stage** | A phase of the process. Stages are ordered, and each has an exit gate. |
| **Gate** | The decision point a stage feeds. Gates declare which artefacts and which modules must be complete to pass. |
| **Module** | The atomic unit of content — a single, self-contained piece of the process (context, options, non-functional requirements, security posture). Modules are the source of truth. |
| **Instance** | One run of a definition against one initiative — a folder of module files, local or living inside a workspace. Its own stored `assignee` (a single named person, editable from the dashboard, its own Instance Settings screen, or `gantry new --assignee`) is a distinct instance-level field, stable across stage transitions — separate from each module's own frontmatter `owner`, which is still just the first non-empty value found among its current stage's modules (see "Instance module files" below), unrelated and unchanged. |
| **Workspace** | An Azure DevOps organization/project/repository that backs one or more instances' data (see "Backing an instance with Azure DevOps" below). Auto-created the first time an instance is registered against that repo, and reused by every later instance registered against the same one. Holds its own free-text owner label (a workspace-level field, distinct from the per-module `owner` above) and a ticketing-system selection — edited from an instance's own Workspace Settings screen. |
| **Artefact** | A rendered output. A document, a page, a summary. Generated, never hand-edited. Every artefact, `.md` and `.docx`, ends with a footer naming a short commit hash and date it was rendered from — the current local `HEAD` for a local instance, or (for an Azure DevOps-backed one) the commit its content was pushed as, one commit behind the file's own latest history entry, since a commit can't name its own hash — so a document can always be traced back to close to the exact version that produced it. |

The key rule: **artefacts are derived, modules are authored.** If you find yourself editing a rendered artefact, something is wrong with the module spec.

## Principles

**Data over documents.** If content lives in two places, one of them is a rendering.

**Flat files, no database.** Git gives history, review, branching, access control and offline work for free. A database would give you a migration problem and a backup schedule.

**Proportionate by design.** The definition declares what each gate genuinely requires. Completeness is checked against that, not against the full module set.

**Process-agnostic engine.** Nothing in Gantry knows what a SOAP is. Design is a definition, and definitions are configuration.

**Two front ends, one store.** The form writes the files a human would have written. There is no synchronisation step, because there is nothing to synchronise.

---

# Getting Started

## Installation

Gantry runs anywhere Node.js and Pandoc do, including Windows — you don't need WSL. It's built and CI-tested on Linux, so Windows works in principle but is unverified in practice; WSL is the safer bet if you want the exact environment this project is tested against.

**1. Install Node.js 22+**

- **Linux (Debian/Ubuntu)**:
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ```
- **Windows**:
  ```powershell
  winget install OpenJS.NodeJS.LTS
  ```
  Restart your terminal afterwards so `node`/`npm` are on PATH. (Or use the installer from [nodejs.org/en/download](https://nodejs.org/en/download).)

**2. Install Pandoc 3.x** (required at render time — see below)

- **Linux (Debian/Ubuntu)**:
  ```bash
  sudo apt-get install -y pandoc
  ```
  Or grab the latest `.deb` from the [Pandoc releases page](https://github.com/jgm/pandoc/releases/latest) if your distro's version lags.
- **Windows**:
  ```powershell
  winget install --source winget --exact --id JohnMacFarlane.Pandoc
  ```
  Or use the MSI installer from the [Pandoc releases page](https://github.com/jgm/pandoc/releases/latest).

**3. Clone and install Gantry** (same on both platforms)

```bash
git clone <repo-url>
cd gantry
npm install          # installs the engine's deps AND the web form's browser deps (preact, preact-iso, @preact/signals, htm, codemirror, markdown-it, dompurify) into node_modules/
npm link             # makes `gantry` available on your PATH
```

> **TODO:** replace with the real install path once packaged — a released binary or `npx gantry` avoids the clone-to-use step for people who only ever consume definitions.

## Software dependencies

| Dependency | Version | Why |
|---|---|---|
| Node.js | 22+ | Engine runtime and CLI (`package.json` `engines.node`) |
| `pandoc` | 3.x confirmed (3.1.3) | **Required at render time** — `gantry render` shells out to it to convert the compiled Markdown to `.docx` |
| Git | 2.x+ | Instance history and audit trail |
| A text editor | any | Modules are markdown; no tooling required to author them |
| `vendor/anthropic-skills/{docx,pdf,pptx,xlsx}` | pinned to a commit, see `vendor/anthropic-skills/README.md` | Document-conversion code used to *verify* rendered artefacts during development (docx→pdf→image) — source-available, not open source; see that README for the license caveat. Not required at render time. |

The web form (`web/`) is a static page with no build step — but it is **not** dependency-free: `gantry serve` generates a browser import map that serves Preact, `preact-iso`, `@preact/signals`, `htm`, CodeMirror 6, `markdown-it`, and `DOMPurify` straight out of `node_modules/` (see `docs/adr/0006-preact-frontend-framework.md`). That directory must exist wherever `gantry serve` runs — don't `npm prune --production` or ship without it.

Backing an instance with Azure DevOps needs nothing installed locally — no Azure CLI, no `az` login. It needs an Azure DevOps **Personal Access Token** (Code + Work Items, Read & write), entered once through the browser when prompted (see "Backing an instance with Azure DevOps" above).

Visually verifying a rendered `.docx` (not required to *use* Gantry, only to sanity-check output during development) additionally needs LibreOffice (`soffice`) and Poppler (`pdftoppm`) — see `vendor/anthropic-skills/docx/SKILL.md`.

## Latest releases

> **TODO:** link the releases page once tagging starts.

Early. The engine, definition schema and design definition are under active development. Treat the definition schema as unstable until v0.1.

## Repository layout

```
gantry/
├── gantry.yaml                   # engine configuration
├── definitions/
│   └── design/                   # the only definition that exists today
│       ├── definition.yaml       # stages, gates, artefacts
│       ├── modules/              # module specs
│       │   ├── context.yaml
│       │   ├── solution-definition.yaml
│       │   └── ...
│       └── templates/            # artefact templates
│           ├── soap.md.tmpl
│           └── reference.docx    # pandoc --reference-doc, derived from the real HLD template
├── instances/
│   ├── instance-registry.json    # slug -> workspace/location map, gitignored
│   ├── workspace-registry.json   # Azure DevOps org/project/repo entities, gitignored
│   └── <initiative-slug>/        # local instances only — an Azure DevOps-backed
│       ├── instance.yaml         # instance lives at gantry-workspace/<slug>/ in
│       ├── modules/              # its own repo instead (see below), never here
│       │   ├── context.md
│       │   └── solution-definition.md
│       └── out/                  # rendered artefacts (gitignored by default)
├── lib/                          # the engine: definition/instance loading, render, status, the web server
│   ├── server.js                 # HTTP routes, incl. the Azure DevOps repo-check/adopt/work-item endpoints
│   ├── instanceRegistry.js       # slug -> workspace/location lookup/registration (the registry above)
│   ├── workspaceRegistry.js      # Azure DevOps org/project/repository entities instances reference
│   ├── azureDevOpsClient.js      # PAT-authenticated Azure DevOps REST client (Git)
│   ├── azureDevOpsWorkItemsClient.js  # PAT-authenticated Azure DevOps REST client (Work Items)
│   ├── workItemLink.js           # link an instance to a work item; confirmed gate-pass state sync
│   ├── repoCheck.js              # "does this Azure DevOps repo already hold instance data", incl.
│   │                             # the legacy-root-to-gantry-workspace/<slug>/ migration routine
│   └── credential.js             # extracts a forwarded PAT from a request
├── bin/gantry.js                 # CLI entrypoint
└── web/
    ├── index.html                # app shell
    ├── app.js                     # dashboard + module editor
    ├── pages/setup-wizard.js     # "+ New instance" — local or Azure DevOps
    ├── pages/settings.js         # /settings, /settings/workspace, /settings/instance — tab-free
    ├── lib/credential.js         # client-side PAT storage/prompt, incl. per-workspace overrides
    ├── lib/ticketingSystem.js    # client-side default-ticketing-system setting
    ├── lib/apiFetch.js           # fetch wrapper: attaches the right PAT, retries once on 401
    ├── lib/validateRepo.js       # parses/checks the wizard's Azure DevOps repo URL
    └── style.css
```

Definitions sit side by side — adding a second one requires no change to the engine — but `design` is the only one built out so far. `procurement` and `incident-review` are illustrative names from this README's own example, not real definitions in this repo.

## Two ways to work

**Clone and write.** The repo is flat files. Clone it, read the definition, fill in the module files in your editor. Every module carries its own spec and guidance, so you're not guessing at what "Context" is supposed to contain. This is the path for architects who'd rather write markdown than fight a form, and for agents driving the process programmatically.

**Use the form.** `gantry serve` opens a dashboard of every registered instance, local or Azure DevOps-backed (see below). Opening one walks you through the process stage by stage, with the spec and guidance inline. A stage switcher lets you jump to any gate's screen, not just whichever stage the instance is currently at. Fill it in, hit render, get your document. Under the hood it writes the same files to the same repo (or the same Azure DevOps repo) — there is no second store, and no import/export step.

Each gate screen also has a "Clear all fields" button, blanking every field shown for that stage without touching the saved files until you hit each module's own Save button. To see what a filled-in gate screen looks like, `gantry serve` and open `examples` from the dashboard — a fixture instance with real content for every stage.

Neither path is the "real" one. They're two front ends onto the same data.

## Backing an instance with Azure DevOps

An instance's data doesn't have to live on the machine running `gantry serve` — it can live in an Azure DevOps repo instead, with gantry acting as a form over it. This is useful when the people filling in modules aren't the people running the server.

A repo backing instance data this way is a **workspace**: `instance.yaml` and `modules/` live at `gantry-workspace/<slug>/` inside it, not at repo root — so one workspace (one Azure DevOps repo) can hold more than one instance, each in its own slug-named subdirectory, rather than being permanently tied to exactly one. A workspace isn't something you create up front — it's found-or-created automatically the first time an instance is registered or adopted against a given organization/project/repository, and reused by every instance registered against that same repo afterwards.

From the dashboard, **"+ New instance"** opens the setup wizard:

1. Paste the target repo's URL — the standard `https://dev.azure.com/{organization}/{project}/_git/{repository}` shape (an on-premises Azure DevOps Server base URL isn't supported here yet).
2. **Check repo** looks for existing instance data at that location. If it's already there, you can open it directly ("adopt" it into this server's dashboard) rather than creating a new instance over the top of it. A repo written before this per-slug layout existed (a lone `instance.yaml` at repo root) is migrated into `gantry-workspace/<slug>/` automatically the first time it's checked — no separate step.
3. If nothing's there yet, pick a definition to create a fresh instance there.

The first request against an Azure DevOps-backed instance prompts for a **Personal Access Token** with **Code (Read & write)** and **Work Items (Read & write)** scope. It's stored in the browser (`localStorage`), sent only to your own gantry server, and forwarded from there to Azure DevOps as an HTTP Basic credential — gantry's own server never persists it.

Settings is three separate, tab-free screens, reached differently depending on where you are:

- From the dashboard (Home), **Settings** goes straight to **Global Settings** (`/settings`) — no intermediate step.
- From an open instance, **Settings** opens a dropdown offering **Global Settings**, **Workspace Settings**, and **Instance Settings**.

Each screen's own back control returns to wherever it was actually opened from (Home, or that same instance screen) — not browser history — falling back to Home for a direct/bookmarked Settings URL.

- **Global Settings** (`/settings`) — set, replace or clear the Azure DevOps PAT ahead of ever being prompted for one, and pick the default **ticketing system** new workspaces use. Azure DevOps is the only ticketing system gantry actually talks to today; a second option is listed but disabled ("coming soon") so the schema and UI don't need a migration once a second one ships.
- **Workspace Settings** (`/settings/workspace`, from an instance's own Settings dropdown) — the workspace *behind that one instance* (never a picker across every registered workspace): its Azure DevOps repo URL and three editable fields — a free-text **owner** label, a **PAT override** for that workspace alone (falls back to the Global Settings PAT when unset, and — like the global PAT — never leaves the browser), and a per-workspace **ticketing-system** override. A local instance has no workspace, so this screen reports that instead.
- **Instance Settings** (`/settings/instance`, from an instance's own Settings dropdown) — that instance's own stored **Assignee** (editable), read-only instance info (slug, definition, current stage), and a read-only view of its Azure DevOps work-item link (organization/project/parent work item/type, and each stage's own child work item id). Re-linking isn't supported here — that's still the module editor's own work-item panel (see "Linking an instance to an Azure DevOps work item" below).

Once registered, a local and an Azure DevOps-backed instance are indistinguishable from the dashboard's point of view — same listing, same module editor, same render command. Where each one's data actually lives is tracked server-side across two registry files (`instances/instance-registry.json`: slug -> workspace; `instances/workspace-registry.json`: workspace -> organization/project/repository/owner/ticketing-system — both gitignored, application state, not source), not in any client-visible config.

## Linking an instance to an Azure DevOps work item

Optionally, and independently of where an instance's own data lives (local or Azure DevOps-backed — the two are unrelated), an instance can be linked to a parent Azure DevOps work item. The module editor's **Azure DevOps work item** panel (below Render) offers a small form — organization, project, parent work item id, and an optional work item type (defaulting to `Task`, a safe default across every stock process template; override it to match your organization's own template).

Linking creates one child work item per stage in the instance's definition underneath that parent, in one step. From then on, the panel's **Check gate & sync work item** action checks the currently-viewed stage's gate and, only if it passes, opens a confirmation dialog before pushing a new state to that stage's own work item — declining the confirmation leaves the work item's state untouched. The state actually pushed is drawn from whatever states the configured work item type genuinely supports in your project (via its own `getWorkItemTypeStates` lookup), never a fixed list Gantry invents — see `docs/adr/0011-azure-devops-work-item-linking.md` for the full mapping rationale.

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
| `gantry serve [slug] [--port <port>]` | Serve the web form (port 3000): a dashboard of every registered instance at `/`, local or Azure DevOps-backed, and the stage-by-stage form at `/instance/<slug>`. `[slug]` only sets a fallback default for API requests made with no `?slug=<slug>` of their own — it doesn't change what the dashboard shows or require picking one instance up front. `/setup` is the instance-setup wizard, `/settings` is the Settings screen (see "Backing an instance with Azure DevOps" above) | Implemented |
| `gantry validate <definition> [--json]` | Report every structural problem with a definition in one pass | Implemented |

`status`, `check` and `validate` all emit structured output with `--json` for scripting and agent use.

## Definition schema

**`definitions/design/definition.yaml`**

```yaml
id: design
title: Solution Design
description: >
  Design content for an initiative, from shaping through to build readiness
  and operational handover.

stages:
  - id: shape
    title: Shape
    gate: business-case
    modules: [context, problem, options, indicative-cost]

  - id: define
    title: Define
    gate: design-authority
    modules: [chosen-option, architecture, integration, nfrs, security, risks]

  - id: build-ready
    title: Build Ready
    gate: build-ready-checklist
    modules: [increment-scope, open-investigations, decisions]

artefacts:
  - id: soap
    title: Solution on a Page
    template: templates/soap.md.tmpl
    gate: business-case
    requires: [context, problem, options, indicative-cost]

  - id: detailed-design
    title: Detailed Design
    template: templates/detailed-design.md.tmpl
    gate: design-authority
    requires: [chosen-option, architecture, integration, nfrs, security]
```

## Module specs

**`definitions/design/modules/context.yaml`**

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

Where a field's *content* genuinely changes shape across the gates its module spans — not just gains depth — model it as two fields on the shared module instead of one field with `required-at`. See `definitions/design/modules/dependencies.yaml`: `dependencies-overview` (narrative, required at the earlier gate) and `dependency-list` (structured, required at the later gate) answer the same question in two different shapes, not two depths of one answer.

`required` and `required-at` are mutually exclusive on a field — use `required` for a field whose requiredness doesn't vary by gate (including fields in single-gate modules), and `required-at` only where it does. Don't reach for `required-at` by default; most fields don't need it.

## Instance module files

**`instances/my-initiative/modules/context.md`** — what someone actually writes:

```markdown
---
module: context
status: draft
owner: c.barlow
---

## Business driver

...

## Affected domains

- Payments
- Client Record

## Explicitly out of scope

...
```

Module files are markdown so they're readable, diffable and editable anywhere. Frontmatter carries the machine-legible state.

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

There is no build/compile step — the CLI and engine (`bin/`, `lib/`) run directly as Node ESM, and the web form (`web/`) is static, served as-is by `gantry serve`.

## Test

```bash
npm test               # engine unit tests (node --test)
```

> **TODO:** add coverage thresholds once the schema stabilises.

## Validating definitions and instances

`gantry validate <definition> [--json]` reports every structural problem with a definition in one pass — a missing module reference, an invalid field type, a `required`/`required-at` conflict — instead of fixing one, rerunning, and hitting the next.

`gantry check <slug> [--gate <id>] [--json]` validates an instance against a gate's requirements, PASS/FAIL with a matching exit code. Defaults to the instance's current stage; `--gate` resolves any stage's gate, so you can check readiness for a later gate before the instance actually gets there.

`gantry render my-initiative soap --dry-run` resolves the template without writing anything, and fails fast (with a descriptive error) if the definition, an instance module reference, a field type, or a `required`/`required-at` conflict is malformed.

## Continuous integration

`azure-pipelines.yml` (repo root) runs on every pull request and push to `main`: `npm test`, then `gantry render` for every artefact the `design` definition currently defines, against the `examples` fixture instance — a failure in any step fails the build.

---

# Contribute

**New definitions are the most useful contribution.** If you have a staged, gated process that currently runs on a set of Office templates, it is a candidate — write the definition and the module specs, and see whether the artefacts fall out of it. If they don't, that usually tells you something interesting about the process.

To propose one:

1. Open an issue describing the process, its stages and its gates, before writing the YAML. The decomposition is the hard part and it is much cheaper to argue about in prose.
2. Add `definitions/<id>/` with a definition, module specs and at least one artefact template.
3. Add an example instance so CI can render it.
4. Run `gantry validate <id>` and `npm test`, then raise a pull request.

For engine changes, one rule governs: **if supporting a new process requires changing the engine, treat that as a design problem first.** Sometimes the engine genuinely is missing something — conditional stages and cross-module dependencies are known gaps. More often the definition is trying to encode a document rather than a process, and the fix belongs in the definition.

Conventions:

- Module ids are lower-kebab-case and name the *content*, not the section of a document it used to live in.
- Guidance text in module specs is written for the person filling it in, not for a reviewer.
- Never add a field that exists only to satisfy a template's layout.