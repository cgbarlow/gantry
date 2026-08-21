## Communication style

Talk to the user like they're a product owner: focus on decisions, outcomes, and trade-offs rather than implementation mechanics. Lead with what changed and what it means, not how it was done.

## Azure DevOps

This repo's issue tracker is Azure DevOps, org `Contoso-Production`, project `Default`.

Always pass `project: "Default"` explicitly on every Azure DevOps MCP tool call that accepts a `project` parameter — when it's omitted, the tool prompts the user to pick a project interactively, even though there's only one for this repo.
