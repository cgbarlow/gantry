# Triage Labels

The skills speak in terms of five canonical triage **state** roles and two canonical **category** roles. Azure DevOps has no native "label" concept, so this repo maps every role to a `System.Tags` string, applied via `mcp__azure-devops__wit_work_item_write` (action `update`, path `/fields/System.Tags`) — the same mechanism already used for wayfinder role tags (`wayfinder:map`, `wayfinder:research`, etc., see `docs/agents/issue-tracker.md`).

## State roles

| Canonical role  | Tag in this repo | Meaning                                  |
| --------------- | ----------------- | ----------------------------------------- |
| `needs-triage`   | `needs-triage`     | Maintainer needs to evaluate this issue   |
| `needs-info`     | `needs-info`       | Waiting on reporter for more information  |
| `ready-for-agent`| `ready-for-agent`  | Fully specified, ready for an AFK agent   |
| `ready-for-human`| `ready-for-human`  | Requires human implementation             |
| `wontfix`        | `wontfix`          | Will not be actioned                      |

`ready-for-agent` is already in live use on this tracker (e.g. WI #140) — this file formalizes the existing convention rather than introducing a new one.

## Category roles

| Canonical role | Tag in this repo | Meaning                     |
| --------------- | ----------------- | --------------------------- |
| `bug`           | `bug`              | Something is broken         |
| `enhancement`   | `enhancement`      | New feature or improvement  |

Category is a tag, not `System.WorkItemType` — the work item's type (Task, Bug, User Story, Feature, Epic) stays chosen for whatever fits the work per `docs/agents/issue-tracker.md`'s existing convention, independent of triage category.

## Applying roles

A triaged work item should carry exactly one category tag and one state tag, alongside whatever other tags it already has. When a skill mentions a role (e.g. "apply the ready-for-agent label"), add or replace the matching `System.Tags` string.

Edit this file directly if the vocabulary ever needs to diverge from the canonical names.
