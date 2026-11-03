# A later stage re-approves the earlier stage Fields it changes

Ticket #146, map #238 (v0.13.0, the AI interview). Builds on ADR-0014 (Pull
Request approval), ADR-0018 (approval invalidated by later commits) and
ADR-0063 (drafting ahead). Leaves ADR-0026's re-open guard unchanged.

Shared modules are mounted at several stages, so a later stage can change
content an earlier stage was approved on. On a real `design` instance, review
fixes on a re-opened HLD changed the approved SOAP. Nothing flagged it, the
SOAP documents on `main` stopped matching the SOAP content, and the SOAP
couldn't be re-approved: ADR-0026 refuses to re-open a stage while a later one
has a branch. The workaround was to render the SOAP onto the HLD branch, so it
merged under the HLD's approval with no SOAP sign-off. v0.13.0 makes this more
likely. The AI drafts ahead and extends shared modules once an earlier stage
merges (ADR-0063), and changed Source documents carry forward into approved
stages (#249).

**Remote workspaces only.** "Approved" means a person signed off a Pull
Request, which only remote workspaces have. Local and server workspaces
advance self-serve and show nothing.

**What counts as changed.** A Field that any of the earlier stage's Artefacts
print (its `requires` lists), compared with the content at that stage's last
approval. Shared modules are meant to grow across stages, so changes to
Fields only later Artefacts print don't count. This covers every earlier
approved stage, not just the one before.

**The earlier stage is flagged "changed since approval"** wherever status
shows: its stage tab, the later stage's status and Request approval panel
("also re-approves SOAP: 2 Fields"), the dashboard row, the Interview run
plan and MCP `check_status`. The editor shows each affected Field's approved
and current text, with **Restore approved text**. Restoring puts the approved
wording back on the later stage's branch, and the flag clears if nothing else
changed.

**The later stage's approval re-approves it.** The later stage's Pull Request
lists the earlier stage's changed Fields. The earlier stage's required
reviewer is added as an extra required reviewer, and Check status waits for
both votes. A passed gate keeps meaning the right person signed off.

**Re-rendering is required, and old documents are kept.** Request approval
refuses until the earlier stage's Artefacts that print a changed Field are
re-rendered on the later stage's branch. The earlier approved copies move to
`out/approved/` with their approval in the name (for example
`SOAP — approved 2026-10-12.docx`). The new render takes the usual name, so
the usual name always means the currently approved version.

**Both histories record it.** The earlier stage keeps its original approval
and gains a re-approval entry: by which stage, which Pull Request, which
Fields, which reviewers, and when. A linked work item gets a comment, as on
re-open.

**In the AI interview**, such a change comes only through a card that says it
changes approved content needing re-approval with this stage. The decisions
log records it. Source-document carry-forward (#249) follows the same rule.
The stage-end "Save, request approval" step renders the affected earlier
Artefacts first, and its card says so.

A change already on `main` from before this rule, which no re-approval
covered, is flagged the same way and rides on the current stage's next
approval.

## Consequences

- One Pull Request can need two approvers from different bodies (for
  example the business case board and the ARB). If the earlier stage's
  reviewer requests changes, the later stage waits, or the author restores
  the approved text.
- Gantry has to remember the content at each stage's approval, at least as
  a commit to compare against.
- Rendering a completed stage's Artefacts now has a supported path: onto the
  later stage's branch, during re-approval.

## Considered options

- **Relax ADR-0026's re-open guard**, with a rebase story for later
  branches. Rejected: ADR-0026 rejected auto-rebase, and drafted-ahead
  branches (ADR-0063) make re-opening harder still.
- **Freeze an approved stage's printed Fields.** Rejected: it blocks the
  normal fix-it-at-HLD flow.
- **Flag only.** Rejected: it gives no supported way back to an approved
  state.
- **Any change to a shared module counts.** Rejected: in `design`, 13 of 22
  modules are shared, so it would fire on almost every stage.
- **Only the later stage's reviewer approves.** Rejected: the ARB would sign
  off business-case content.
- **Optional re-render.** Rejected: the approved documents on `main` would
  drift from the content, which was half the original problem.
- **Keep the old file at its name and give the new one a suffix.** Rejected:
  the usual name would stop meaning the current version.
