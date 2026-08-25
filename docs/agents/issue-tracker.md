# Issue tracker: Azure DevOps Boards

Issues and specs for this repo live as Azure DevOps work items in the **Default** project (org: `Contoso-Production`), under the **Epic "gantry" (work item #34)**.

## Conventions

> **Running under ready-for-agent?** If this session was started by the
> ready-for-agent harness (worktree path contains `/tmp/ready-for-agent/`),
> do **not** create, comment on, or transition Azure DevOps work items — the
> harness owns the ticket lifecycle and will drop your run
> (`issue_not_found`) if the ticket's state changes mid-flight. Everything
> below applies only to human-driven interactive sessions.

Use the `azure-devops` MCP tools (`mcp__azure-devops__wit_*`), not a CLI.

- **Create a work item**: `mcp__azure-devops__wit_work_item_write` (action: create). Project `Default`. Pick a type appropriate to the work (`Task`, `Bug`, `User Story`, etc.) and link it as a child of Epic #34 via `mcp__azure-devops__wit_work_item_link_write`.
- **Read a work item**: `mcp__azure-devops__wit_work_item` (action: get), with `id` and `project: "Default"`. Use `expand: "All"` to pull relations and check `list_comments` for discussion.
- **List work items**: `mcp__azure-devops__wit_query` with a WIQL query scoped to Area Path `Default`, filtered to children of Epic #34 or by state.
- **Comment on a work item**: `mcp__azure-devops__wit_work_item_comment_write`.
- **Close a work item**: `mcp__azure-devops__wit_work_item_write` (action: update), setting `System.State` to the type's closed state (check valid states first via `wit_work_item` action `get_type`).

## When a skill says "publish to the issue tracker"

Create a new Azure DevOps work item in project `Default`, linked as a child of Epic #34 ("gantry").

## When a skill says "fetch the relevant ticket"

`mcp__azure-devops__wit_work_item` (action: get) with the work item id, project `Default`.

## Pull requests as a triage surface

Not applicable — the `triage` skill isn't installed in this repo.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single work item with **child** work items as tickets, all under Epic #34 ("gantry").

- **Map**: a work item (pick a type that fits, e.g. `Task` or `Feature`) tagged `wayfinder:map` via the `System.Tags` field, created as a child of Epic #34. Body goes in `System.Description` (Markdown format) via `mcp__azure-devops__wit_work_item_write` (action: `create`, `format: "Markdown"`).
- **Child ticket**: a work item linked as a child of the map via `mcp__azure-devops__wit_work_item_write` (action: `add_child`, `parentId: <map id>`), tagged `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`) in `System.Tags`. Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: Azure DevOps' **native Predecessor/Successor link** — the canonical, UI-visible representation (shown in the work item's Links tab and the Boards dependency view). Add it with `mcp__azure-devops__wit_work_item_link_write` (action: `link`, `updates: [{id: <ticket id>, linkToId: <blocker id>, type: "predecessor"}]`) — this marks `<blocker id>` as blocking `<ticket id>`. A ticket is unblocked when every predecessor is `Closed`/`Done`.
- **Frontier query**: `mcp__azure-devops__wit_work_item` (action: `get`, `id: <map id>`, `expand: "Relations"`) to find child ids (`System.LinkTypes.Hierarchy-Forward` relations), then `mcp__azure-devops__wit_work_item` (action: `get_batch`, `expand: "Relations"`) on those ids. Keep the ones that are open, unassigned (`System.AssignedTo` empty), and have no open `predecessor` relation; first in map order wins.
- **Claim**: `mcp__azure-devops__wit_work_item_write` (action: `update`, path `/fields/System.AssignedTo`, value `<the driving dev's identity>`) — the session's first write.
- **Resolve**: `mcp__azure-devops__wit_work_item_comment_write` (action: `add`) with the answer, then `mcp__azure-devops__wit_work_item_write` (action: `update`, path `/fields/System.State`, value the type's closed state — check via `wit_work_item` action `get_type`), then append a context pointer (gist + link) to the map's Decisions-so-far by updating its `System.Description`.
