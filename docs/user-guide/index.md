# User Guide

Gantry helps teams capture process information once and use it throughout a staged, gated process. This guide explains the engine's general concepts and uses the `design` definition as a worked example.

## Getting Started

Start at the **Workspaces** landing page. It shows the instances that Gantry knows about and is also where you create your first one.

Choose **+ New Workspace** to begin. You can pick a workspace already registered with this Gantry server, or register an Azure DevOps repository as a new Workspace. When registering one, provide its repository details, the Workspace Owner and the ticketing system it should use. Gantry checks that the repository is reachable before registering it.

Next choose a Definition, such as `design`, then provide the Instance's name, directory and initial Assignee. The directory defaults from the name, but you can change it. If the Workspace has a ticketing system, the final step can link the Instance to a parent work item. That link is optional for local Instances, which do not need an Azure DevOps repository.

After creation, open the Instance from the landing page. Its header identifies the definition and current Stage. The stage controls let you browse the process, while each module is where you author the information that the process needs. Use the User Guide link in the header whenever you need to return to these concepts.

## Workspaces & Instances

A **Workspace** is an Azure DevOps organization, project and repository registered with Gantry. It is shared storage for one or more Instances. For example, a team can keep several `design` initiatives in separate directories in one Workspace while retaining one repository history and access boundary.

An **Instance** is one run of a Definition against one initiative. It has its own module files, current Stage and Assignee. A `design` Instance might represent one system change; another `design` Instance can represent a different change in the same Workspace.

Instances can be local or Workspace-backed:

- A local Instance stores its files in the Gantry server's local `instances/` directory. It is useful for individual work or offline authoring.
- A Workspace-backed Instance stores its `instance.yaml` and modules in the Azure DevOps repository under `gantry-workspace/<instance-slug>/`. Its changes are made on a Stage branch and reviewed through Azure DevOps.

The storage choice changes how stage advancement works, but not what a Module or Field means. Both kinds of Instance use the same Definition and the same authoring experience.

## Stages & Gates

A **Stage** is an ordered phase of a Definition. It makes the relevant modules available for authoring and ends at one **Gate**.

A **Gate** is the decision point at the end of a Stage. A gate checks the artefact requirements declared by the Definition. Passing a gate permits the next action; it does not advance an Instance by itself. Local Instances advance explicitly, while Workspace-backed Instances advance when their approved Pull Request is merged.

The `design` Definition has these stages:

<!-- GANTRY-DESIGN-STAGES -->

## Modules & Fields

A **Module** is a self-contained area of process content and the source of truth for that content. A Module is made up of **Fields**, which are the individual prompts shown in the editor. The `design` Definition combines those fields into documents later, rather than asking authors to maintain separate copies in each document.

For example, the `context` Module can ask for the initiative's driver, opportunity and scope. The `driver` Field records why the work is needed; it is not a separate document. In the same way, a security Module can capture the solution's security considerations in its own fields. Each field can have guidance and can be required at the gate where it matters.

You normally work through the editor's Module cards and save each Module as you complete it. The available Modules depend on the current Stage, while an artefact's own requirements decide whether that artefact is complete. This lets one set of content support multiple outputs without duplicating authoring work.

## Artefacts & Rendering

An **Artefact** is a rendered output such as a summary, design document or handover document. Artefacts are generated from module data on demand and are never the authored source of truth.

Each artefact declares the module or field content it `requires`. Those requirements determine whether that artefact is complete for its gate. Multiple artefacts can therefore render different views of the same modules without asking authors to duplicate content.

The `design` Definition has these artefacts:

<!-- GANTRY-DESIGN-ARTEFACTS -->

## Approval workflow

A gate passing permits the next action; it does not advance an Instance by itself.

For a local Instance, such as a local run of the `design` Definition, use **Advance to next stage** after the current gate has passed. Gantry performs the advancement directly and the Instance moves to the next Stage.

For a Workspace-backed Instance, such as a `design` initiative stored in Azure DevOps, use **Request Approval** after the gate has passed. Gantry opens that Stage's Pull Request into `main`. The Owner reviews and approves the Pull Request in Azure DevOps. Return to Gantry and choose **Check status** to read the review result. When the Pull Request is approved, Gantry merges it, advances the Instance and updates any linked work item. A rejection or request for changes must be addressed before approval can complete.

The linked work item is a tracking surface, not the approval mechanism. The Pull Request is what gates a Workspace-backed Stage, and Gantry does not provide a separate in-app approval button.

## Settings

Gantry's Settings are split by scope:

- **Global Settings** controls the default Azure DevOps Personal Access Token and the ticketing system new Workspaces use by default. The PAT is stored in this browser and sent to the Gantry server only for Azure DevOps requests.
- **Workspace Settings** controls the Owner, the Workspace's optional PAT override and its ticketing-system override. These settings apply to the Workspace and can be opened from an Instance that belongs to it.
- **Instance Settings** controls the Instance's Assignee and shows read-only information about the Instance and its linked work item.

An override narrows the scope of a setting: a Workspace setting takes precedence over the global default for that Workspace, while Instance settings affect only that one run of the Definition.

For example, you can give a `design` Workspace its own PAT or ticketing-system choice while leaving other Definitions on the global defaults, and assign one `design` Instance without changing its Workspace or sibling Instances.
