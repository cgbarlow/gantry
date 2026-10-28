# Target size is an authoring target, not render-time condensing

Spec #192 (design v3), ticket #202.

A Solution Architecture Document written with `design` v2 went to peer and
stakeholder review (#191). An AI agent had written it from the field guidance
and the example instance it reads over MCP. It came to about 14,000 words, and
reviewers agreed it was more than they needed and slow to review. They asked
for a lever: the same document, less of it.

Nothing in Gantry said how much to write. A Field has a title, a type and
guidance, and the example instance shows one way to fill it, at full length.
Authors, people and agents alike, wrote to the example.

## Decision

1. **An Instance has a Target size: Small, Medium or Large.** It is stored as
   `size:` in the instance's `instance.yaml`. Medium is the default, and an
   instance with no stored size works to Medium. It is chosen in the "+ New
   Workspace" / new-instance wizard, changed in Instance Settings
   (`PUT /api/instance/size`, on the stage branch like the Assignee), and set
   by MCP `create_instance`.
2. **A Field can declare a word budget per size.** `target-words: { small: 40,
   medium: 100, large: 200 }` on a `markdown` or `list` Field. It survives
   every Definition round trip (#148): save, new draft, clone, publish,
   promote, every Provider's loader and the Library cache, and a Local
   Workspace's own copy. It is shown and edited on the Definitions page.
   Calibration for design v3 (#203): Large is today's example length, Medium
   about half, Small about a fifth, adjusted per Field.
3. **The size only appears where a Definition declares a budget.** A
   Definition with no `target-words` (design v1 and v2, recruitment-onboarding)
   shows no Size in the wizard or Instance Settings, no targets in the editor,
   and its API responses are unchanged. Storing a size on such an instance is
   refused, so its `instance.yaml` never grows the key.
4. **Size is read only where content is written.**
   - The editor shows `Target ~N words (Medium)` and a live word count under
     each budgeted Field, amber once the count is over.
   - `GET /api/instance` (and so MCP `get_instance`) returns the instance's
     `size` and each budgeted Field's `targetWords` at that size.
   - The stage Save (`PUT /api/instance/modules`, and so MCP
     `update_instance_modules`) returns a `targetWordNotes` entry per
     over-budget Field it just wrote, such as `nfrs.performance: 420 words,
     Medium target ~150`, so an AI author can tighten it.
5. **It is advisory.** An over-budget Field never blocks a Save, a gate or a
   render. The gate check and the renderer don't read the size or the budgets
   at all, so a document renders exactly what was written, at any size.
6. **Words are counted as a reader reads them.** Markdown punctuation is not a
   word, a link counts its text, and fenced code blocks (a Mermaid diagram's
   source) and images are left out. The count lives in one place,
   `web/lib/targetSize.js`, shared by the server, the browser and the v3
   harness (#203).
7. **A malformed budget is an authoring problem.** Anything other than a
   positive whole number for each of small, medium and large, or a budget on
   a `select`, `text` or `date` Field, is an `invalid-target-words` problem.
   `gantry validate` and a Local Workspace report it, the Definitions page
   marks it, and Save and Publish refuse it. Like #149's gate-id problems it
   doesn't stop a Definition loading, because a budget is advisory: the places
   that read one ignore one that isn't well formed.

## Alternatives considered

- **Condense at render time with AI.** A size option on the Render dialog
  would ask a model to shorten each Field to its budget as the document is
  built. Rejected for three reasons:
  - It adds an AI dependency to rendering, which today needs only Pandoc.
  - It sends the instance's content to a model provider at render time. A
    SAD is often `IN-CONFIDENCE`, and Gantry makes no AI calls of its own.
  - It breaks reproducibility. Today the same commit always renders the same
    document. With condensing, two renders of one commit could differ, and the
    reviewed text would not be the text in the repository.
- **Different templates, sections or Fields per size.** Rejected: one size
  would then hide content another shows, and moving between sizes would lose
  or orphan Fields. The same Fields at every size keep the instance's content
  the single source of truth.
- **Enforce the budget** (refuse a Save, fail a gate). Rejected: a budget is a
  calibration, not a rule. Some Fields genuinely need more for one solution,
  and a hard limit would push authors to cut what matters or split prose
  across Fields to get past it.
- **A size on the Render dialog.** Out of scope for the same reason as render
  time condensing: size is a choice about what to write, made before writing.

## Consequences

- The length of a document is now in its authors' hands, with a visible
  target, rather than in the renderer's.
- A Definition author calibrates budgets per Field. A Definition with no
  budgets is exactly as before.
- Changing an instance's size doesn't change anything already written. It
  changes the targets the editor shows and the notes a save returns, so an
  author can then tighten (or expand) Fields to the new size.

Status: accepted.

## Amendment (ADR-0058): Target size is an Instance setting

ADR-0058 groups the per-Instance choices a Definition declares as
**Instance settings**, and Target size is the first member. With #219 the
wizard and Instance Settings show Size under an "Instance settings" heading,
the Definitions page shows it as offered "because N Fields declare word
targets", and Instance Settings saves it through the one settings write that
every Instance setting uses. Where it is offered, how it is stored (`size:`
in `instance.yaml`, written only when chosen) and what it does are
unchanged.

Decision 1's "Medium is the default" becomes "the Definition's default, else
Medium". A Definition that sets no default behaves exactly as before. #221
lets an author set one, as `instance-settings: { size: { default: ... } }`,
on a draft's Definitions page; the three sizes stay Gantry's.
