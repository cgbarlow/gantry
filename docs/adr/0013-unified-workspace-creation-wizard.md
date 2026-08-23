# Instance and Workspace creation is one wizard, not two

Gantry's setup wizard has so far only ever created a single Workspace-backed
instance at a time — one Azure DevOps repo URL in, one instance out. Now
that a Workspace can hold many Instances (see the `gantry-workspace/<slug>/`
subdirectory ADR) and a Workspace itself carries its own settings (Owner,
PAT/ticketing-system overrides, edited from Settings → "Workspace
overrides"), the Workspaces landing page needs a way to both register a
brand-new Workspace and add another Instance to one that already exists.

We're replacing the landing page's standalone "+ New instance" entry point
entirely with a single **"+ New Workspace"** wizard. It lets you pick an
existing Workspace or register a new one — registering a new one is also
where that Workspace's Owner gets set for the first time, since nothing
else asks for it. Either path continues into the same instance-level
fields: Name, Directory (defaulting to Name, overridable), and initial
Assignee, then — mandatory only when the chosen Workspace has a ticketing
system configured — the Azure DevOps parent-work-item link (Organization
auto-filled read-only from the Workspace's own pinned org; Project, Parent
work item id, and Work item type as PAT-backed lookups, not freetext).

Why: a separate "+ New Workspace" action and a separate "+ New instance"
action would leave a real gap — a Workspace with zero Instances would have
nowhere to set its Owner/PAT/ticketing-system until its first instance
existed, and Workspace Settings is (deliberately) reachable only via an
instance's own Settings dropdown, not from the landing page directly.
Folding instance creation into the same wizard as Workspace registration
closes that gap without inventing a second, landing-page-level route into
Workspace Settings.

Consequence: Workspace Settings remains reachable only via an instance's
Settings dropdown — no landing-page shortcut to it is needed now that every
Workspace already gets its Owner/ticketing-system set at creation time, in
this same wizard.

Status: accepted.
