# Research: can the AI draft ahead while an earlier stage's approval is pending?

Ticket: [#239](https://github.com/cgbarlow/gantry/issues/239) (map [#238](https://github.com/cgbarlow/gantry/issues/238), v0.13.0 AI interview).
Researched against `main` at `65924c7` (Release 0.12.1). Line numbers below refer to that commit.
There was no `docs/research/` folder before this one, so this file starts it.

## Verdict

**Feasible with changes.** Drafting ahead is already a designed-in behaviour of stage branches, not
something new. ADR-0014 makes later stage branches stack on an earlier stage's still-open branch "so
work continues in sequence without waiting on approval latency". The server accepts a Save to a
*later* stage today; it refuses only *earlier, completed* stages. What's missing is guard rails, not a
new branching model. Without them, an AI that drafts ahead and also requests approval can (a) get a
later stage signed off before an earlier one, and (b) produce merge conflicts that GitHub and
Atlassian give the architect no way to resolve inside Gantry.

Coverage: works on **Azure DevOps** and **GitHub** today. **Atlassian is blocked by something else
first**: module Save isn't wired for Atlassian instances at all yet (see below). The map's
"Workspace coverage" note lists Atlassian as somewhere module Save works today, and that is not
accurate. **GitLab** is out of scope for the same reason, as the map already says.

## Smallest change that makes it safe

1. **Approval in stage order (server guard).** `POST /api/instance/request-approval` and
   `POST /api/instance/check-status` should refuse a `gate` whose stage isn't the instance's current
   stage on `main`. This is one comparison, in the same place as `completedStageRefusal`. It also
   closes a hole that MCP's `request_approval` can already reach (it takes a `gate`).
2. **Shared modules are frozen for drafting ahead.** While an earlier stage's PR is open, the AI may
   not write a module that the earlier stage also mounts. This reuses the existing read-only
   refusal shape (ADR-0050) as a run-time condition rather than a Definition key. It is the only
   thing that prevents real content conflicts when the Owner requests changes.
3. **AI-written files are per stage.** The decisions log should be one file per stage (e.g.
   `decisions/<stageId>.md`), not one append-only file. Source documents should be add-only, under
   unique names.
4. **Draft in strict stage order**, or have `resolve*StageBranch` stack on the *nearest* earlier
   stage branch that exists rather than only the immediate predecessor. Today, skipping a stage
   forks from `main` and silently drops the unapproved earlier content.

Nothing here needs a new branch topology, rebasing, or retargeted PRs.

## How stage branches work today

- **Naming.** `gantry-workspace/<slug>/<stageId>`, worked out from the slug and stage id and never
  stored ([lib/stageBranch.js:8](../../lib/stageBranch.js)). CONTEXT.md, **Stage branch**.
- **Created on first write only.** `findStageBranch` is read-only. `resolveStageBranch` creates the
  branch on the first Save (lib/stageBranch.js:15-19, 168-191).
- **Stacking.** A new branch is created from the *immediately preceding* stage's branch if that branch
  exists, otherwise from `main` (lib/stageBranch.js:180-189). GitHub
  (lib/githubStageBranch.js:45-68) and Bitbucket (lib/bitbucketStageBranch.js:56-79) are exact twins.
  Branch existence is the only signal.
- **Rationale.** ADR-0014 rejected "forking each stage's branch fresh from `main`" because the
  later stage would be missing the preceding stage's unapproved work
  (docs/adr/0014-pull-request-stage-approval.md).
- **Every PR targets `main`.** A stacked stage's PR also shows its predecessor's unmerged commits;
  ADR-0014 accepts this (lib/stageApproval.js:104).
- **Merges preserve history on every provider.**
  - GitHub always uses `merge_method: 'merge'` (lib/githubPullRequestsClient.js:145-166).
  - Bitbucket uses `merge_strategy: 'merge_commit'` and `close_source_branch: false`, both "so that
    stacking is never broken" (lib/bitbucketPullRequestsClient.js:164-187).
  - Azure DevOps passes only a commit message, so the API default applies: "noFastForward … This is
    the default behavior"
    ([ADO REST 7.1, GitPullRequestMergeStrategy](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/update?view=azure-devops-rest-7.1)).
  - No squash or rebase anywhere, so a stacked successor's history is never rewritten underneath it.

## Is a Save to a not-yet-current stage refused?

**No.** Both module-save routes (`PUT /api/instance/modules`, lib/server.js:5758-5850, and
`PUT /api/instance/modules/:id`, lib/server.js:5888-5970) take `?stage=` and run two refusals before
the branch is resolved:

- `readOnlyModulesRefusal`: a module listed `read-only-modules` at that stage (ADR-0050).
- `completedStageRefusal`: refuses only when the stage's index is *earlier* than the current stage
  (web/lib/stageCompletion.js:18-22, 39-42).

A later stage passes both checks, gets its branch created or stacked by `resolveStageBranch`, and
receives the Save as one commit. The route comments say so directly ("saving a module that belongs
to a non-current stage", lib/server.js:5901). The editor's free-browse stage switcher already lets a
person do this by hand (web/app.js:856).

## What happens to a drafted-ahead stage

Example: stage 1's PR is open and the AI has drafted stage 2 on a branch stacked on stage 1.

**Owner approves stage 1.** "Check status" merges stage 1's PR and writes `stage: <stage 2>` to
`main`'s `instance.yaml` (lib/stageStatus.js:356-371). The code says explicitly that the stacked
branch's own `instance.yaml` is left alone: "Any later stage branch that already stacked on this one
keeps its own instance.yaml copy untouched — out of scope here" (lib/stageStatus.js:364-369). That's
harmless: every route reads the current stage from `main` (the "bootstrap" read). Stage 2's branch
already contains stage 1's commits, so its own PR later merges cleanly.

**Owner requests changes on stage 1.** The fixes land on stage 1's branch. Stage 2's branch doesn't
get them; there is no auto-rebase, and ADR-0026 explicitly rejected one ("rebase semantics for YAML
modules need product input"). After stage 1 merges, stage 2 is behind `main`. Whether that conflicts
depends on what both branches touched:

| Both branches touched… | Result | Evidence |
|---|---|---|
| Different module files | Clean merge | Git: only one side changed each file |
| Different top-level `instance.yaml` fields | Clean merge | WI 201 canonical key order; tests/instanceYamlCanonicalSerialization.test.js:106 |
| The same `instance.yaml` map (e.g. both stages recording `pullRequestStatuses` because both requested approval) | **Conflict** | `git merge-file` reproduction below |
| The same module (a module mounted by both stages) | **Conflict** if both edited it | Same mechanism |
| One shared append-only file (e.g. a single decisions log) | **Conflict** | `git merge-file` reproduction below |

Shared modules are the common case, not an edge case. In the bundled `design` Definition,
**13 of 22 modules are mounted by more than one stage** (`introduction` is in all four, `background`
is in shape and hld-define). None of them are `read-only-modules`, so every shared module is editable
in every stage that mounts it (`loadDefinition('design')`, checked at 65924c7).

Reproduction (`git merge-file`, base / stage 1 after changes / stage 2 drafted ahead):

- `instance.yaml`: stage 2 drafted only (no `instance.yaml` write) → 0 conflicts.
- `instance.yaml`: stage 2 also requested approval (`pullRequestStatuses.s2` vs `.s1`) → 1 conflict.
- A single decisions log appended on both branches → 1 conflict.

**What the architect can do about a conflict, by provider:**

- **Azure DevOps.** "Sync from main" exists. It fast-forwards, or opens a main→stage PR and
  auto-completes it; on a conflict it leaves that PR open for a human (lib/stageBranch.js:84-159).
  The editor's "behind main" advisory is wired for Azure DevOps only (lib/server.js:5211-5220).
- **GitHub.** No sync route; `POST /api/instance/stage-branch/sync` is Azure DevOps-only
  (lib/server.js:5460-5470), and `stageSync` is hard-coded to "not behind" (lib/server.js:5319). A
  conflict surfaces only at sign-off, as GitHub's refusal shown verbatim with "Resolve this in GitHub"
  (lib/stageStatus.js:521-538).
- **Atlassian.** Same position as GitHub, once module Save exists.

**Re-open is blocked.** ADR-0026 refuses to re-open an earlier stage while "any stage after the one
being re-opened already has a branch" (lib/stageReopen.js:67-79). Drafting ahead creates exactly
those branches. Late feedback on stage N therefore waits until the drafted-ahead stages are
completed or abandoned.

**Skipping a stage loses content.** Stacking looks only at `stages[i - 1]`. If the AI drafts stage 3
while stage 2 has no branch yet, stage 3 forks from `main` and is missing stage 1's unapproved work
(lib/stageBranch.js:181-187). In-order drafting avoids this; the alternative is a nearest-earlier-branch
walk.

## Approval out of order: the main risk

`requestStageApproval` and `checkStageApprovalStatus` choose their stage via `resolveCheckStage`, which
accepts *any* `gate` (lib/check.js:6-19). Neither checks that it is the current stage:

- The web UI never sends a `gate`; it always asks for the current stage (web/app.js:3324-3327).
- MCP's `request_approval` / `check_status` *do* pass `gate` through
  (mcp-server/src/tools/stageLifecycle.tools.js:66-86).
- On a fresh approval, the merge-and-advance path calls `writeInstanceStage(nextStage)` with no
  current-stage check (lib/stageStatus.js:356-371). Only the already-completed path checks
  `isAtPersistedStage`.

So if an AI requests approval for drafted-ahead stage 2 and the Owner approves that PR first, Gantry:

- merges stage 2's branch, which **carries stage 1's unapproved commits**, into `main`;
- sets the instance to stage 3;
- leaves stage 1's gate passed without its own sign-off.

That breaks the map's out-of-scope rule ("a passed gate must always mean a person signed off"), and
it is why change 1 above is needed. With approval in order, a drafted-ahead stage's `instance.yaml`
is never written concurrently with the earlier stage's, so the `pullRequestStatuses` conflict can't
happen either.

## Provider notes

- **Azure DevOps.** Works today. Stacking, no-FF merge (API default), and Sync from main are all in
  place. Gantry never sets `deleteSourceBranch` (opt-in per the ADO API), so merged stage branches
  stay unless the repo deletes them.
- **GitHub.** Works today. Merge commit, stacking, and refusals surfaced verbatim. No sync from main
  and no "behind" advisory, so a stacked-branch conflict can only be fixed in GitHub itself. Shared
  modules frozen while an earlier PR is open (change 2) matters most here.
- **Atlassian (Bitbucket + Jira).** At the library level the stage machinery exists: stacking
  (`resolveBitbucketStageBranch`), approval request and check, and stack-safe merge options. But:
  - `writeModule` / `writeModules` have no `options.atlassian` branch (lib/instance.js:2165-2284);
  - the server's module-save routes have no Atlassian path;
  - `resolveBitbucketStageBranch` is called only from tests;
  - the instance registry has no Atlassian entry kind (lib/instanceRegistry.js:369-373; the
    `GET /api/workspaces/:id/instances` comment at lib/server.js:3119-3123 says so).

  Drafting ahead on Atlassian waits on Atlassian module Save landing first.
- **GitLab.** Module Save is refused outright today (lib/server.js:5850-5859, 5970-5975). Out of scope, as the
  map says.

## Side finding (not blocking)

ADR-0026 and CONTEXT.md say a completed stage's branch "is deleted on PR completion". The code never
asks for that:

- ADO: no `deleteSourceBranch`.
- Bitbucket: `close_source_branch: false`.
- GitHub: the merge API doesn't delete branches.

Unless a repo-level auto-delete setting is on, merged branches stay. Consequences:

- The next stage's `resolve*StageBranch` stacks on the merged branch rather than `main`. This is
  harmless, because that branch is an ancestor of `main`.
- Re-opening that stage later fails with "branch already exists".

Worth its own ticket; it doesn't change this verdict.

## Sources

- lib/stageBranch.js, lib/githubStageBranch.js, lib/bitbucketStageBranch.js: branch naming,
  stacking, Azure DevOps sync
- lib/server.js: module-save routes (5758-5965), sync route (5460-5500), editor read path (5135-5410)
- web/lib/stageCompletion.js: completed-stage refusal
- lib/stageApproval.js, lib/stageStatus.js, lib/check.js: approval request, merge, advance
- lib/stageReopen.js: re-open guard
- lib/instance.js: `writeModule(s)`, Atlassian content store
- lib/githubPullRequestsClient.js, lib/bitbucketPullRequestsClient.js,
  lib/azureDevOpsPullRequestsClient.js: merge options
- tests/instanceYamlCanonicalSerialization.test.js: stacked-branch `instance.yaml` merge
- mcp-server/src/tools/stageLifecycle.tools.js: MCP `request_approval` / `check_status` take `gate`
- docs/adr/0014, 0018, 0026, 0040, 0042, 0050; CONTEXT.md (**Stage branch**, **Re-open a signed-off
  stage**, **Request approval / Check status**)
- [Azure DevOps REST 7.1, Pull Requests – Update](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/update?view=azure-devops-rest-7.1):
  `GitPullRequestMergeStrategy` default and `deleteSourceBranch`
