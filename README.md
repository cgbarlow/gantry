# Introduction

**Gantry is a repo-driven pipeline for staged, gated processes. Capture the data once; render whatever document the gate asks for.**

Gantry separates the *content* of a process from the *documents* that process produces. You describe a process as a **definition** — its stages, its gates, its module specs — and Gantry runs it. People (or agents) fill in modules as flat files in a Git repo. Artefacts — a Solution on a Page, a business case, a handover pack — are rendered from that data on demand.

There is one set of data, not five documents that drift apart.

Gantry itself knows nothing about design, procurement or anything else. Every use case is a definition, and definitions are configuration.

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
| **Instance** | One run of a definition against one initiative. A folder of module files. |
| **Artefact** | A rendered output. A document, a page, a summary. Generated, never hand-edited. |

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

```bash
git clone <repo-url>
cd gantry
npm install          # TODO: confirm once the engine's runtime is settled
npm link             # makes `gantry` available on your PATH
```

> **TODO:** replace with the real install path once packaged — a released binary or `npx gantry` avoids the clone-to-use step for people who only ever consume definitions.

## Software dependencies

> **TODO:** confirm and pin.

| Dependency | Version | Why |
|---|---|---|
| Node.js | TODO | Engine runtime and CLI |
| Git | 2.x+ | Instance history and audit trail |
| A text editor | any | Modules are markdown; no tooling required to author them |

The web form has no build step and no runtime dependencies — it is a single static HTML page served from the repo.

## Latest releases

> **TODO:** link the releases page once tagging starts.

Early. The engine, definition schema and design definition are under active development. Treat the definition schema as unstable until v0.1.

## Repository layout

```
gantry/
├── gantry.yaml                   # engine configuration
├── definitions/
│   ├── design/
│   │   ├── definition.yaml       # stages, gates, artefacts
│   │   ├── modules/              # module specs
│   │   │   ├── context.yaml
│   │   │   ├── options.yaml
│   │   │   └── ...
│   │   └── templates/            # artefact templates
│   │       ├── soap.md.tmpl
│   │       └── detailed-design.md.tmpl
│   ├── procurement/
│   │   └── ...
│   └── incident-review/
│       └── ...
├── instances/
│   └── <initiative-slug>/
│       ├── instance.yaml         # which definition, which stage, metadata
│       ├── modules/              # authored content
│       │   ├── context.md
│       │   └── options.md
│       └── out/                  # rendered artefacts (gitignored by default)
└── web/
    └── index.html                # the stage-by-stage form
```

Definitions sit side by side. Adding a second one requires no change to the engine.

## Two ways to work

**Clone and write.** The repo is flat files. Clone it, read the definition, fill in the module files in your editor. Every module carries its own spec and guidance, so you're not guessing at what "Context" is supposed to contain. This is the path for architects who'd rather write markdown than fight a form, and for agents driving the process programmatically.

**Use the form.** `gantry serve` opens a single HTML page that walks you through the process stage by stage, showing only the modules the current gate requires, with the spec and guidance inline. Fill it in, hit render, get your document. Under the hood it writes the same files to the same repo — there is no second store, and no import/export step.

Neither path is the "real" one. They're two front ends onto the same data.

## Your first instance

```bash
gantry definitions                              # list available definitions
gantry new design my-initiative                 # start an instance
gantry status my-initiative                     # what does the current stage need?
gantry serve my-initiative                      # fill it in via the form, or edit the files
gantry check my-initiative --gate business-case # completeness against the gate
gantry render my-initiative soap                # produce the artefact
```

---

# Reference

## CLI

| Command | Does |
|---|---|
| `gantry definitions` | List definitions available in this repo |
| `gantry new <definition> <slug>` | Create an instance |
| `gantry status <slug>` | Current stage, module completeness, what's outstanding |
| `gantry check <slug> [--gate <id>]` | Validate an instance against a gate's requirements |
| `gantry render <slug> <artefact>` | Render an artefact to `out/` |
| `gantry serve [<slug>]` | Serve the stage-by-stage form |
| `gantry validate <definition>` | Validate a definition against the schema |

`status` and `check` emit structured output with `--json` for scripting and agent use.

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
npm run build          # TODO: confirm target and output path
```

The web form is static and requires no build step; `gantry serve` serves `web/index.html` directly.

## Test

```bash
npm test               # engine unit tests
npm run test:watch
```

> **TODO:** confirm the runner and add coverage thresholds once the schema stabilises.

## Validating definitions and instances

Definitions and instances are validated by the same machinery the CLI uses, so a broken definition fails fast rather than at render time:

```bash
gantry validate design                      # definition against the schema
gantry check my-initiative --gate <id>      # instance against a gate
gantry render my-initiative soap --dry-run  # template resolution without writing
```

## Continuous integration

> **TODO:** pipeline definition.

CI should, at minimum: validate every definition in `definitions/`, run the engine tests, and render every artefact for the example instances to catch template drift.

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