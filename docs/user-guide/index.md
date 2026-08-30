# User Guide

Gantry helps teams capture process information once and use it throughout a staged, gated process. This guide explains the engine's general concepts and uses the `design` definition as a worked example.

## Getting Started

Start at the **Workspaces** landing page. It shows the instances that Gantry knows about and is also where you create your first one.

![Workspaces landing page showing grouped instances, search filter and creation controls](/user-guide-images/workspaces-landing.png)

Choose **+ New Workspace** to begin. You can pick a workspace already registered with this Gantry server, or register an Azure DevOps repository as a new Workspace. When registering one, provide its repository details, the Workspace Owner and the ticketing system it should use. Gantry checks that the repository is reachable before registering it.

Next choose a Definition, such as `design`, then provide the Instance's name, directory and initial Assignee. The directory defaults from the name, but you can change it. If the Workspace has a ticketing system, the final step can link the Instance to a parent work item. That link is optional for local Instances, which do not need an Azure DevOps repository.

### Choosing a definition version

Each definition has numbered versions — each `draft` or `published` — with its own `CHANGELOG.md`. The New Workspace wizard lists every version for the chosen definition, shows the definition's description and the selected version's changelog underneath, and marks draft versions explicitly. Creating an instance from a draft version requires a confirmation step. Published versions are the default and are labelled "latest".

![New Workspace wizard at the definition and version pick step showing description and changelog](/user-guide-images/new-workspace-definition-step.png)

After creation, open the Instance from the landing page. Its header identifies the definition and current Stage. The stage controls let you browse the process, while each module is where you author the information that the process needs. Use the User Guide link in the header whenever you need to return to these concepts.

## Workspaces & Instances

A **Workspace** is an Azure DevOps organization, project and repository registered with Gantry. It is shared storage for one or more Instances. For example, a team can keep several `design` initiatives in separate directories in one Workspace while retaining one repository history and access boundary.

An **Instance** is one run of a Definition against one initiative. It has its own module files, current Stage and Assignee. A `design` Instance might represent one system change; another `design` Instance can represent a different change in the same Workspace.

Instances can be local or Workspace-backed:

- A local Instance stores its files in the Gantry server's local `instances/` directory. It is useful for individual work or offline authoring.
- A Workspace-backed Instance stores its `instance.yaml` and modules in the Azure DevOps repository under `gantry-workspace/<instance-slug>/`. Its changes are made on a Stage branch and reviewed through Azure DevOps.

The storage choice changes how stage advancement works, but not what a Module or Field means. Both kinds of Instance use the same Definition and the same authoring experience.

### Numeric references

Every Workspace, Instance and Stage also carries a short numeric reference. Workspaces are numbered from 1 across the server; an Instance is numbered from 1 within its Workspace; a Stage's number is its position in the Instance's Definition, so Stage 1 is always the first Stage. Gantry shows these references on the Workspaces page and in the Instance header, and uses them as the canonical short form in links — for example `/instance/w2i1` opens the first Instance in Workspace 2, and `/instance/w2i1s3` opens that Instance's third Stage. A Workspace-only reference resolves to that Workspace's first Instance, and an Instance-only reference resolves to its first Stage. Older links that use an Instance's directory name still work.

### Dashboard PR status badge

On the Workspaces page, a Workspace-backed instance that has an open sign-off Pull Request shows a **PR OPEN** badge on its card. The badge reflects the persisted PR status — once the PR is completed or abandoned it disappears. Local instances never show a PR badge.

### Archive and restore

Workspaces and instances can be archived — hidden from the dashboard's default listing — and restored later, with no data deleted. Archiving is done from **Workspace Settings** or **Instance Settings** respectively. An archived instance still opens read-only at its direct `/instance/<slug>` link, with a banner explaining it is archived and linking to Instance Settings to restore it. On the dashboard, archived items appear in the collapsible **Archived instances** and **Archived workspaces** panels at the bottom of the page. A workspace that still has active instances cannot be archived until those are archived first. The **Definition Editor**'s own definitions can also be archived and restored from its rail, filtered by a "Show archived" checkbox.

### Definition versions and the Definition Editor (experimental)

Definitions are versioned. Version 1 of `design` is published and is the default for new instances; newer versions start as `draft`. Each version has its own `definition.yaml`, module specs, templates and `CHANGELOG.md`. Only the latest published version is used when no explicit version is requested; draft versions are opt-in via the wizard's version picker.

The **Definition Editor** — linked from the Workspaces page header as **Definition Editor** — is an experimental, rudimentary screen for inspecting and editing definitions. It is explicitly experimental and rudimentary: the screen carries a disclaimer to that effect, and the editing experience is not yet at parity with hand-editing the YAML and templates.

![Definition Editor showing a draft version of a definition with stages, artefacts and modules](/user-guide-images/definition-editor.png)

On a published version the editor is read-only, with a **View template source** toggle to inspect each artefact's `.md.tmpl`. On a `draft` version it allows editing stages, artefacts, modules and fields (titles, purposes, gates, module refs, field types and guidance), reordering via drag handles or **Move ↑/↓** buttons, editing `.md.tmpl` templates inline, creating a **New draft version**, **cloning** a definition to a new id, **archiving / restoring** definitions, and **publishing** the draft (which validates the definition and flips its status to `published`).

### Example instances

The worked example throughout this guide remains the `design` definition, illustrated by the `examples` instance (a local instance with content for every stage). A second populated example, `atlas-reference-design`, is also included as a reference design — it demonstrates a more fully-worked handover with additional modules — but the concepts below are explained against `design` alone.

## Stages & Gates

A **Stage** is an ordered phase of a Definition. It makes the relevant modules available for authoring and ends at one **Gate**.

A **Gate** is the decision point at the end of a Stage. A gate checks the artefact requirements declared by the Definition. Passing a gate permits the next action; it does not advance an Instance by itself. Local Instances advance explicitly, while Workspace-backed Instances advance when their approved Pull Request is merged.

For a Workspace-backed Instance the gate is checked as part of the Work Item Detail card's **Check status** action; a local Instance checks it with **Check gate & sync work item**. See *Approval workflow* for the full sequence.

The `design` Definition has these stages:

<!-- GANTRY-DESIGN-STAGES -->

## Modules & Fields

A **Module** is a self-contained area of process content and the source of truth for that content. A Module is made up of **Fields**, which are the individual prompts shown in the editor. The `design` Definition combines those fields into documents later, rather than asking authors to maintain separate copies in each document.

For example, the `context` Module can ask for the initiative's driver, opportunity and scope. The `driver` Field records why the work is needed; it is not a separate document. In the same way, a security Module can capture the solution's security considerations in its own fields. Each field can have guidance and can be required at the gate where it matters.

You normally work through the editor's Module cards and save each Module as you complete it. The available Modules depend on the current Stage, while an artefact's own requirements decide whether that artefact is complete. This lets one set of content support multiple outputs without duplicating authoring work.

### The editor toolbar

Above the modules sits a view-mode bar with **Markdown / Split / Rendered** — `Rendered` is read-only and hides all editing affordances. Next to it is the **Artefact** selector, which appears when the current stage has artefacts with different field requirements; it filters the visible fields to only those the selected artefact needs, preserving drafts in hidden fields when you switch artefacts. On the right are **Clear all fields** and **Render**, and a **Review / Sign-off** shortcut that scrolls to the Work Item Detail card.

![Module editor showing the view-mode toolbar with Markdown, Split and Rendered options](/user-guide-images/module-editor-toolbar.png)

Each Markdown field has its own formatting toolbar (visible while the field has focus) with **Headings ▾**, bold, italic, inline code, link, lists, blockquote, image, table and full-screen controls. The table control appears only when the caret is inside a table.

To the right of the Artefact selector, a **Navigation ▾** dropdown jumps to any module or section heading in the current stage — useful in stages with many fields. It lists every module title and each field heading in document order.

Use **Insert ▾** below each field to add a new **Section** (a custom Markdown block) or **List** below that field. Custom sections appear as new fields with their own headings and are saved with the module.

## Artefacts & Rendering

An **Artefact** is a rendered output such as a summary, design document or handover document. Artefacts are generated from module data on demand and are never the authored source of truth.

Each artefact declares the module or field content it `requires`. Those requirements determine whether that artefact is complete for its gate. Multiple artefacts can therefore render different views of the same modules without asking authors to duplicate content.

The `design` Definition has these artefacts:

<!-- GANTRY-DESIGN-ARTEFACTS -->

### Rendering

Use the **Render** button in the view-mode bar to open the Render dialog. It lists every artefact the current stage can produce — the same dialog whether the stage has one artefact or several sharing a gate.

![Render dialog showing selectable artefacts for the current stage](/user-guide-images/render-dialog.png)

Toggle the artefacts you want, then press **Render**. Gantry renders each selected artefact in sequence and reports the output path (and, for Workspace-backed instances, the Azure DevOps URL) in the dialog. For a Workspace-backed instance the rendered `.docx` is pushed to `gantry-workspace/<instance>/out/` in the repository; for a local instance it appears under `instances/<slug>/out/`.

## Approval workflow

A gate passing permits the next action; it does not advance an Instance by itself.

For a local Instance, such as a local run of the `design` Definition, use **Advance to next stage** after the current gate has passed. Gantry performs the advancement directly and the Instance moves to the next Stage. A local Instance with a linked work item also keeps a **Check gate & sync work item** button, which re-checks the current gate and, if it passes, offers to push a state update to that work item in Azure DevOps.

For a Workspace-backed Instance, such as a `design` initiative stored in Azure DevOps, everything to do with review and sign-off happens in the **Work Item Detail card** at the top of the Stage screen. There is no separate section further down the page.

### The Work Item Detail card

The card shows this Stage's synced fields — work item type, title, status, assignee and parent work item — alongside its Reviews, its Sign-off Pull Request and its commit history. You edit the title and assignee in place; clearing an override restores the inherited value.

The card's header holds **Show files** (when a workspace is linked), **Show commit history** and the single **Check status** button. The **Reviews** section header holds **Request Review** and the **Sign-off** section header holds **Request Sign-off** — there are no separate sign-off or review panels further down the page.

![The Work Item Detail card at the top of the Stage screen](/user-guide-images/work-item-detail-card.png)

### Check status

One **Check status** button at the top of the card refreshes everything in a single click: the linked and parent work items, every review request for the Stage, and the sign-off Pull Request. For a Workspace-backed Instance the same click then runs the gate-check-and-sync step — if the current Stage's gate passes and a work item is linked, Gantry offers to push a state update to it. When the sign-off Pull Request has been approved, this is also the click that merges it, advances the Instance and updates the linked work item.

### Reviews

Use **Request Review** in the Reviews section header to ask one or more people to look at the Stage before sign-off. Each request is tracked as its own work item and shows the reviewer's name. Reviews refresh from the card's **Check status** button, not per row. Once a Stage has more than two reviews, Gantry groups them by outcome — pending, changes requested and approved — so it is easy to see what still needs attention.

### Sign-off

Use **Request Sign-off** in the Sign-off section header after the gate has passed. Gantry opens that Stage's Pull Request into `main` and records the Owner as the reviewer. The Owner reviews and approves the Pull Request in Azure DevOps; you then return to Gantry and choose **Check status**. A rejection, a request for changes, or an approval invalidated by later commits on the branch must be resolved before sign-off can complete.

The linked work item is a tracking surface, not the approval mechanism. The Pull Request is what gates a Workspace-backed Stage, and there is no separate in-app Request Approval button — the sign-off flow is the approval mechanism.

### Review and sign-off status

Each review and sign-off item carries a Gantry status — Requested, In review, Changes requested, Approved or Rejected — kept separate from the native Azure DevOps work item state, which continues to drive the board. If a project has not been set up with the custom status field, Gantry falls back to reading the native state instead, so the card still shows a sensible status.

### Commit history

Use **Show commit history** in the card header to open a dialog listing the commits on the current Stage's branch. This works before a Pull Request exists, so you can see what has been committed to the Stage while it is still in progress.

## Settings

Gantry's Settings are split by scope:

- **Global Settings** controls the default Azure DevOps Personal Access Token and the ticketing system new Workspaces use by default. The PAT is stored in this browser and sent to the Gantry server only for Azure DevOps requests.
- **Workspace Settings** controls the Owner, the Workspace's optional PAT override and its ticketing-system override. These settings apply to the Workspace and can be opened from an Instance that belongs to it. The same screen also holds **Archive workspace** / **Restore workspace**.
- **Instance Settings** controls the Instance's Assignee and shows read-only information about the Instance and its linked work item. The same screen also holds **Archive instance** / **Restore instance**. An archived instance is hidden from the dashboard but still opens at its direct URL.

An override narrows the scope of a setting: a Workspace setting takes precedence over the global default for that Workspace, while Instance settings affect only that one run of the Definition.

For example, you can give a `design` Workspace its own PAT or ticketing-system choice while leaving other Definitions on the global defaults, and assign one `design` Instance without changing its Workspace or sibling Instances.
