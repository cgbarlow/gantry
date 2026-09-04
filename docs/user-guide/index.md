# User Guide

Gantry helps teams capture process information once and use it throughout a staged, gated process. This guide explains the engine's general concepts and uses the `design` definition as a worked example.

## Getting Started

There are two ways to get Gantry running. The usual path is cloning the repository and running `npm install`. If you're on a locked-down corporate machine with no Git and no admin rights, there's a zip-release path instead: download the zip from the project's Azure DevOps pipeline artifacts, unpack it, then run `install.cmd` followed by `run.cmd` — no Git, no admin install, and no Docker needed. Either path lands you at the same running Gantry server described below; see README.md for full setup instructions.

Start at the **Workspaces** landing page. It shows the instances that Gantry knows about and is also where you create your first one.

![Workspaces landing page showing grouped instances, search filter and creation controls](/user-guide-images/workspaces-landing.png)

Choose **+ New Workspace** to begin. By default this takes you straight into the **Local** flow — see **Local workspaces** below — with no Azure DevOps step at all. Turn on **Advanced mode** in **Settings** first if you need a Server-hosted Workspace instead; that adds a **Workspace location** choice, **Server-hosted** or **Local**, to the top of the wizard. With **Server-hosted** chosen, you can pick a workspace already registered with this Gantry server, or register an Azure DevOps repository as a new one. When registering one, provide its repository details, the Workspace Owner and the ticketing system it should use. Gantry checks that the repository is reachable before registering it.

Next choose a Definition, such as `design`, then provide the Instance's name, directory and initial Assignee. The directory defaults from the name, but you can change it. If the Workspace has a ticketing system, the final step can link the Instance to a parent work item. A Local-workspace Instance (or a legacy local Instance) skips that step entirely — neither has ticketing.

### Choosing a definition version

Each definition has numbered versions — each `draft` or `published` — with its own `CHANGELOG.md`. The New Workspace wizard lists every version for the chosen definition, shows the definition's description and the selected version's changelog underneath, and marks draft versions explicitly. Creating an instance from a draft version requires a confirmation step. Published versions are the default and are labelled "latest".

![New Workspace wizard at the definition and version pick step showing description and changelog](/user-guide-images/new-workspace-definition-step.png)

After creation, open the Instance from the landing page. Its header identifies the definition and current Stage. The stage controls let you browse the process, while each module is where you author the information that the process needs. Use the User Guide link in the header whenever you need to return to these concepts.

## Workspaces & Instances

A **Workspace** is where an Instance's data lives — shared storage for one or more Instances — and comes in two kinds: **Server-hosted**, an Azure DevOps organization, project and repository registered with Gantry, or **Local**, a folder on your own machine picked in the browser (see **Local workspaces** below). For example, a team can keep several `design` initiatives in separate directories in one Server-hosted Workspace while retaining one repository history and access boundary.

An **Instance** is one run of a Definition against one initiative. It has its own module files, current Stage and Assignee. A `design` Instance might represent one system change; another `design` Instance can represent a different change in the same Workspace.

Instances can live in one of three places:

- A **local Instance** stores its files in the Gantry server's own `instances/` directory. It is useful for individual work or offline authoring.
- A **Workspace-backed Instance** stores its `instance.yaml` and modules inside a Server-hosted Workspace's Azure DevOps repository, under `gantry-workspace/<instance-slug>/`. Its changes are made on a Stage branch and reviewed through Azure DevOps.
- A **Local-workspace Instance** stores its files the same way, under `gantry-workspace/<instance-slug>/`, but inside a Local workspace's folder on your own machine rather than an Azure DevOps repository — see **Local workspaces** below. It is a different thing from the local Instance above, even though both get called "local" in everyday speech: one lives on the machine running the Gantry server, the other lives on yours, and the server never sees it.

The storage choice changes how stage advancement and ticketing work, but not what a Module or Field means. All three kinds of Instance use the same Definition and the same authoring experience.

### Local workspaces

The **+ New Workspace** wizard's **Local** option is what creates a Local-workspace Instance. Choose **Local** as the Workspace location, then either **register** a new Local workspace in an empty folder or **pick** an existing one. This needs **Chrome or Edge** — it relies on a browser API (File System Access) that only those two support today; on another browser the wizard shows a clear message and keeps **Server-hosted** available instead.

By default the wizard skips the Workspace-location question altogether and takes you straight into this flow — you only see a choice between **Server-hosted** and **Local** once **Advanced mode** is turned on (see **Settings** below). With Advanced mode off, every Instance you create is a Local-workspace Instance.

**Registering** asks you to pick a new or empty folder, then name the workspace (an owner is optional) — Gantry writes a `workspace.json` marker at the folder's root so the folder is recognisable as a Gantry workspace later. **Picking** an existing one opens a folder that already has that marker and lists the Instances already inside it; a **Recent local workspaces** list remembers folders you've opened in this browser before, so you usually don't have to browse to them again. After a browser restart — or the first time in a different browser — the browser typically needs you to **Grant access** again before it will read or write the folder; that is a normal permission reset, not a sign anything is broken. The Workspaces landing page keeps its own **Local workspaces** panel for the same purpose, so you can often get straight back into one from there without opening the wizard at all.

Editing and saving modules works entirely offline — every change goes straight to the folder through the browser, with no server involved. Checking the gate and rendering an artefact both still need the Gantry server (rendering a `.docx` in particular happens there); if the server isn't reachable, those actions say so rather than failing silently. A rendered artefact is written straight into the folder's own `out/`, the same way a Workspace-backed Instance writes into its Azure DevOps repository.

A Local-workspace Instance has no ticketing at all — no linked work item, no Review or Sign-off, no Stage branch or Pull Request. It advances the same way a local Instance does: once the current Stage's gate passes, use **Advance to next stage** to move it on yourself. See **Approval workflow** below.

### Numeric references

Every Workspace, Instance and Stage also carries a short numeric reference. Workspaces are numbered from 1 across the server; an Instance is numbered from 1 within its Workspace; a Stage's number is its position in the Instance's Definition, so Stage 1 is always the first Stage. Gantry shows these references on the Workspaces page and in the Instance header, and uses them as the canonical short form in links — for example `/instance/w2i1` opens the first Instance in Workspace 2, and `/instance/w2i1s3` opens that Instance's third Stage. A Workspace-only reference resolves to that Workspace's first Instance, and an Instance-only reference resolves to its first Stage. Older links that use an Instance's directory name still work.

### Dashboard PR status badge

On the Workspaces page, a Workspace-backed instance that has an open sign-off Pull Request shows a **PR OPEN** badge on its card. The badge reflects the persisted PR status — once the PR is completed or abandoned it disappears. Local instances never show a PR badge. Local-workspace instances are shown separately, in the landing page's own **Local workspaces** panel (see **Local workspaces** above) rather than as dashboard cards, so the badge doesn't apply to them either.

### Archive and restore

Workspaces and instances can be archived — hidden from the dashboard's default listing — and restored later, with no data deleted. Archiving is done from **Workspace Settings** or **Instance Settings** respectively. An archived instance still opens read-only at its direct `/instance/<slug>` link, with a banner explaining it is archived and linking to Instance Settings to restore it. On the dashboard, archived items appear in the collapsible **Archived instances** and **Archived workspaces** panels at the bottom of the page. A workspace that still has active instances cannot be archived until those are archived first. The **Definition Editor**'s own definitions can also be archived and restored from its rail, filtered by a "Show archived" checkbox.

### Definition versions and the Definition Editor (experimental)

Definitions are versioned. The first version of a definition is published and is the default for new instances; newer versions start as `draft`. Each version has its own `definition.yaml`, module specs, templates and `CHANGELOG.md`. Only the latest published version is used when no explicit version is requested; draft versions are opt-in via the wizard's version picker.

The **Definition Editor** — linked from the Workspaces page header as **Definition Editor (experimental)** — is an experimental, rudimentary screen for inspecting and editing definitions. It is explicitly experimental and rudimentary: the screen carries a disclaimer to that effect, and the editing experience is not yet at parity with hand-editing the YAML and templates.

![Definition Editor showing a draft version of a definition with stages, artefacts and modules](/user-guide-images/definition-editor.png)

On a published version the editor is read-only, with a **View template source** toggle to inspect each artefact's `.md.tmpl`. On a `draft` version it allows editing stages, artefacts, modules and fields (titles, purposes, gates, module refs, field types and guidance), reordering via drag handles or **Move ↑/↓** buttons, editing `.md.tmpl` templates inline, creating a **New draft version**, **cloning** a definition to a new id, **archiving / restoring** definitions, and **publishing** the draft (which validates the definition and flips its status to `published`).

### Example instances

The worked example throughout this guide remains the `design` definition, illustrated by the `examples` instance (a local instance with content for every stage).

## Stages & Gates

A **Stage** is an ordered phase of a Definition. It makes the relevant modules available for authoring and ends at one **Gate**.

A **Gate** is the decision point at the end of a Stage. A gate checks the artefact requirements declared by the Definition. Passing a gate permits the next action; it does not advance an Instance by itself. Local Instances — including Local-workspace Instances (see **Local workspaces** above) — advance explicitly, while Workspace-backed Instances advance when their approved Pull Request is merged.

For a Workspace-backed Instance the gate is checked as part of the Work Item Detail card's **Check status** action; a local Instance with a linked work item checks it with **Check gate & sync work item**. A Local-workspace Instance has no linked work item at all, so its gate is checked as part of **Advance to next stage** itself, with no separate check step. See *Approval workflow* for the full sequence.

A definition lists its stages, and the gate each one ends at, in its `definition.yaml`. The `design` definition, for instance, runs from initial shaping through high-level and detailed design to operational handover, each stage ending at its own gate.

## Modules & Fields

A **Module** is a self-contained area of process content and the source of truth for that content. A Module is made up of **Fields**, which are the individual prompts shown in the editor. A definition combines those fields into documents later, rather than asking authors to maintain separate copies in each document.

For example, one module might capture an initiative's context as separate fields — its driver, the opportunity, what is out of scope — and another might capture security considerations. A field is authored once and reused wherever an artefact needs it, never copied between documents. Each field can carry guidance and can be required only at the gate where it matters.

You normally work through the editor's Module cards and save each Module as you complete it. The available Modules depend on the current Stage, while an artefact's own requirements decide whether that artefact is complete. This lets one set of content support multiple outputs without duplicating authoring work.

### The editor toolbar

Above the modules sits a view-mode bar with **Markdown / Split / Rendered** — `Rendered` is read-only and hides all editing affordances. Next to it is the **Artefact** selector, which appears when the current stage has artefacts with different field requirements; it filters the visible fields to only those the selected artefact needs, preserving drafts in hidden fields when you switch artefacts. On the right are **Clear all fields** and **Render**, and a **Review / Sign-off** shortcut that scrolls to the Work Item Detail card.

![Module editor showing the view-mode toolbar with Markdown, Split and Rendered options](/user-guide-images/module-editor-toolbar.png)

Each Markdown field has its own formatting toolbar (visible while the field has focus) with **Headings ▾**, bold, italic, inline code, link, lists, blockquote, image, table and full-screen controls. The table control appears only when the caret is inside a table.

To the right of the Artefact selector, a **Navigation ▾** dropdown jumps to any module or section heading in the current stage — useful in stages with many fields. It lists every module title and each field heading in document order.

Use **Insert ▾** below each field to add a new **Section** (a custom Markdown block) or **List** below that field. Custom sections appear as new fields with their own headings and are saved with the module.

### Adding images

To put a picture or diagram into a field, place the cursor where it should go and use the **Image** button on that field's formatting toolbar (see **The editor toolbar** above). This opens a dialog with two tabs:

- **Upload new** — choose an image file (PNG or JPEG), optionally give it a name, and provide its **Source location**: a link to where the original file lives, such as a Draw.io diagram or an export from a design tool. The source location is required — it's what lets anyone reading the finished document trace a picture back to where it came from — and Gantry shows that link as a small citation beneath the image wherever it's used.
- **Choose existing** — reuse a picture already uploaded elsewhere in the same instance instead of uploading it again.

Either way, Gantry inserts the reference into the field for you at the cursor.

For a Workspace-backed Instance (see **Workspaces & Instances** above), images work a little differently: uploading through the editor isn't available, since a picture needs to be committed to the Azure DevOps repository the same way everything else about the instance is. Instead, add the image file straight to the instance's own `assets` folder in the repository (alongside its `modules` folder), then reference it from a field yourself, the same way you would reference any other image, for example `![description](assets/your-file.png)`. Gantry resolves it the same way in both the live preview and rendered documents.

## Artefacts & Rendering

An **Artefact** is a rendered output such as a summary, design document or handover document. Artefacts are generated from module data on demand and are never the authored source of truth.

Each artefact declares the module or field content it `requires`. Those requirements determine whether that artefact is complete for its gate. Multiple artefacts can therefore render different views of the same modules without asking authors to duplicate content.

A definition lists its artefacts in `definition.yaml`, each with the gate it renders at and the module or field content it `requires`. One definition can declare several artefacts over the same modules — a short summary and a fuller specification, say — without duplicating any authored content.

### Rendering

Use the **Render** button in the view-mode bar to open the Render dialog. It lists every artefact the current stage can produce — the same dialog whether the stage has one artefact or several sharing a gate.

![Render dialog showing selectable artefacts for the current stage](/user-guide-images/render-dialog.png)

Toggle the artefacts you want, then press **Render**. Gantry renders each selected artefact in sequence and reports the output path (and, for Workspace-backed instances, the Azure DevOps URL) in the dialog. For a Workspace-backed instance the rendered `.docx` is pushed to `gantry-workspace/<instance>/out/` in the repository; for a local instance it appears under `instances/<slug>/out/`; for a Local-workspace instance it is written straight into that same `gantry-workspace/<instance>/out/` path, but inside your own folder rather than a repository.

## Approval workflow

A gate passing permits the next action; it does not advance an Instance by itself.

For a local Instance, such as a local run of the `design` Definition, use **Advance to next stage** once the current gate has passed. Clicking it re-checks the gate and, if it passes, opens a confirmation dialog — confirm to move the Instance on to its next Stage, or decline to leave it where it is. A local Instance with a linked work item also keeps a separate **Check gate & sync work item** button, which re-checks the current gate and, if it passes, offers to push a state update to that work item in Azure DevOps. A Local-workspace Instance (see **Local workspaces** above) works the same way but has no linked work item and so no separate check button — **Advance to next stage** is the only action needed.

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

- **Global Settings** holds the **Advanced mode** toggle, off by default — with it off, a browser only ever sees the Local workspace flow (see **Local workspaces** above), with no Azure DevOps, ticketing or sign-off UI anywhere in the app. Turning it on reveals the rest of this screen: the default Azure DevOps Personal Access Token and the ticketing system new Workspaces use by default. The PAT is stored in this browser and sent to the Gantry server only for Azure DevOps requests.
- **Workspace Settings** controls the Owner, the Workspace's optional PAT override and its ticketing-system override. These settings apply to the Workspace and can be opened from an Instance that belongs to it. The same screen also holds **Archive workspace** / **Restore workspace**.
- **Instance Settings** controls the Instance's Assignee and shows read-only information about the Instance and its linked work item. The same screen also holds **Archive instance** / **Restore instance**. An archived instance is hidden from the dashboard but still opens at its direct URL.

An override narrows the scope of a setting: a Workspace setting takes precedence over the global default for that Workspace, while Instance settings affect only that one run of the Definition.

For example, you can give a `design` Workspace its own PAT or ticketing-system choice while leaving other Definitions on the global defaults, and assign one `design` Instance without changing its Workspace or sibling Instances.
