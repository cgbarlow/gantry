## v3

Production-ready Word output and content guidance, from the peer and stakeholder review of a
Solution Architecture Document written with v2 (spec #192, review #191). v3 starts as a copy of
v2 (#193), and each later ticket records its change here under its own `### <change> (#NNN)`
heading. v1 and v2 stay published and unchanged, so instances pinned to them render exactly as
before.

**Status: draft.** New design instances are still created on v2, the latest published version.
v3 stays a draft when spec #192 is complete; publishing it is the process owner's step.

### Started as a copy of v2 (#193)

- **Same content as v2.** Stages, Gates, Artefacts, Modules, Fields, templates and reference Word
  documents are v2's, file for file. Only `version` and `status` differ, plus the Stage examples
  below. v3 was made as a file copy rather than through the app's "New draft", which rewrites
  `definition.yaml` without its comments and starts the changelog empty; the v2 and v1 history
  sits below this section.
- **The bundled design examples are on v3.** `examples/kiwi-cover-mutual` and `examples/gantry`
  are pinned to `definitionVersion: 3`, and both still pass every Gate they passed on v2. Field
  ids are unchanged, so v1 and v2 still read the same files.
- **"Populate example text" points at the bundled example by its real slug.** Every v3 Stage's
  `example:` is `kiwi-cover-mutual`, the example that covers every Stage, so the button fills from
  the Examples workspace. v2's `example: examples` names a slug the Examples workspace doesn't
  have, so it is left as it is: v2 is published and stays unchanged.

### Design decisions as an AD | Decision | ADR table (#200)

Review items GF-007 and GF-008: the v2 guidance let an author (in the review, an AI agent) treat
every design decision as an ADR needing ARB endorsement.

- **`architecture.design-decisions` asks for a table**, `| AD | Decision | ADR |`. Every decision
  gets an AD id (AD01, AD02, …). The ADR column is filled only for a decision that needs
  governance endorsement, as `ADRYYY` until the ADR is registered.
- **The four ADR-candidate criteria are in the guidance**: enterprise reuse exists, a new platform
  or product is introduced, an architecture precedent is created, or governance endorsement is
  explicitly required. It says plainly not to assume ARB endorsement is needed: a decision is not
  an ADR, and an ADR is not an ARB item.
- **`as-built-notes.architecture-decisions` uses the same table**, keeping the SAD's AD ids,
  numbering decisions made during the build next in sequence, and giving the registered ADR
  number once there is one.
- **The Kiwi Cover Mutual example uses the table.** Its seven SAD decisions are AD01 to AD07; two
  carry `ADRYYY` (AD01 for enterprise reuse, AD02 for the precedent of exposing the mainframe as
  services) and five carry none. The as-built repeats them as built, with registered ADR numbers,
  and adds AD08 for the policy-lookup cache change made during the build. The SAD's Constraints
  and goals now cites "AD02" rather than "decision 2".
- **No field, template or Gate change.** Both fields stay `markdown`, so the table renders under
  "Design decisions" in the SAD and "Architecture decisions" in the as-built through the existing
  templates.

### Sourced figures, preferred terms, contractual names and path-led columns (#201)

Review items GF-006, GF-018, GF-022 and GF-023. These are conventions that Field guidance sets
and the example shows. Gantry does not check them.

- **Every figure has a source or is marked as an assumption (GF-022).** The guidance for every
  NFR Field, and for `architecture.architectural-risks`, `integration.hardware`,
  `integration.bandwidth` and `integration.san`, asks for each figure's source in brackets, e.g.
  `99.5% (hosting SLA §4.2)`, or the marker `(target assumption)`. Never invent a figure.
  Every figure in those Fields of the `kiwi-cover-mutual` example now has a source or the marker.
  Figures that only repeated a retention period already stated in the NFRs now point back to it.
- **The glossary holds the preferred terms (GF-006).** `glossary.terms-and-definitions` is now a
  Preferred term | Definition | Variants to avoid table. It names the solution itself and its
  platforms and products, each with the variants to avoid. The guidance for the Fields that name
  the solution's parts tells authors to use those terms in headings, tables, diagrams and prose:
  `solution-definition.high-level-solution-overview`, `architecture.solution-description`, the
  `integration` interface, network, licence and protocol Fields, and
  `support-and-operations.operational-accounts-and-licenses`. The example glossary names
  "claims handling modernisation" and eight other preferred terms, and the rest of the example
  avoids every variant it lists.
- **Architecture names by default, contracted names only where verified (GF-023).** The licence,
  account and platform Fields use the architecture name. They give the contracted product name
  only where it has been checked against the contract. The example's licences table has a
  "Contracted name" column: it gives one verified contracted name and marks the others "Not yet
  verified" rather than guessing. The payment gateway's account entry names its verified contract.
- **Columns say what the rows are (GF-018).** The rows of `integration.communication-and-network-protocols`
  are now paths: Path / Protocol / From / To / Port / Direction / Environment(s) / Comments.
  Environment no longer comes first. `integration.san` has one row per storage use, and
  `integration.software-and-licences` one row per product with its contracted name. The
  example's tables use these columns.
- **The MCP server instructions carry one authoring line.** Follow each field's guidance and the
  example's conventions, and never invent figures or names.

### Diagram captions (#195)

- **Diagrams are numbered and captioned in the Word document.** Every v3 Artefact sets
  `diagram-captions: true`, so each captioned diagram renders as `Diagram N. <title>` in italics
  directly under the figure, kept on the same page. Mermaid blocks and images share one numbering
  sequence per document. See ADR-0053.
- **How to caption.** A Mermaid block takes its caption on the opening fence,
  `` ```mermaid {caption="Security architecture"} ``. An image is captioned by its alt text,
  `![Security architecture](asset:<id>)`, when it stands on a line of its own. Type only the title:
  the "Diagram N." prefix is added for you. The caption doubles as the picture's alt text.
- **What doesn't change.** The exported `.md` keeps every fence and image exactly as written. An
  uncaptioned Mermaid block is still labelled "Diagram N", and an image with empty brackets gets
  no caption or number. The bundled examples' images already have names, so their v3 documents
  now show numbered captions. v1 and v2 don't set the key and render exactly as before.
- **The switch is on the Definitions page.** Each Artefact has a "Diagram captions" checkbox, so
  an organisation copying v3 can turn numbering off for a document without editing
  `definition.yaml`.

### Cover page, classification and titles without the slug (#196)

From review items GF-001, GF-002 and GF-005.

- **Every document opens with a cover page and a table of contents.** All six Artefacts set
  `cover-page: true` and `table-of-contents: true` (ADR-0052). Each document now reads: the cover
  (classification, title, document type, version, status, author, purpose), Document Control, the
  Table of Contents, then section 1. The author is the instance's Assignee. The cover never shows a
  diagram or section content.
- **A Classification field.** New Module `document-handling` (Document handling) holds one
  optional `select` Field, `classification`, with the New Zealand Protective Security Requirements
  markings `UNCLASSIFIED`, `IN-CONFIDENCE`, `SENSITIVE` and `RESTRICTED` (ADR-0044). Every
  Artefact names it as its `cover-classification` and lists it first in its `requires`, with `?`,
  so it gates nothing. The Module is mounted at every Stage, from Shape onward, after the content
  Modules, so a new instance has it from creation and it can change at any later Stage. A value
  not in the list is kept and warned about by `check`, as for any `select`. The guidance tells an
  organisation with a different scheme to replace the options with its own.
- **No slug in the title.** The templates no longer open with `# <instance-slug>: <Document
  title>`. The cover carries the title instead: the instance's display name (its name, or its slug
  title-cased) in the Title style, with the document type under it. No heading names the slug,
  and the first heading in every document is its first section.
- **The bundled examples have a classification.** `kiwi-cover-mutual` and `gantry` are both
  `IN-CONFIDENCE`, and every Artefact still renders from them and every Gate they passed still
  passes. v2 never reads the new `document-handling.md` files, so it still reads the examples as
  before.

### `gantry render` draws Mermaid diagrams (#198)

An engine change, not a change to v3's files: no Stage, Field, template or reference document
changed. It is recorded here because it completes v3's captions on the command line.

- **The CLI's Word document matches the browser's.** With the optional headless Chromium
  installed (`npx playwright install chromium`), `gantry render` draws each Mermaid block as a
  picture with its `Diagram N. <title>` caption, using the browser export's own code: same image,
  name, scale and caption. See ADR-0055.
- **Without it, nothing breaks.** The render succeeds, warns once with the install command, and
  leaves each diagram as source text, still numbered so the images after it keep their numbers.
  The server and its container image never include Chromium.

### Diagram pattern and current / interim / target state labels (#199)

Review items GF-009 to GF-012, GF-020 and GF-021. Like #201, these are conventions that Field
guidance sets and the example shows. No Field is added and Gantry checks none of them.

- **A short diagram pattern.** The guidance of every Field that carries a diagram gives the order
  in two sentences: one introductory sentence ("The following diagram presents…"), the diagram,
  its caption, a paragraph interpreting it ("The diagram shows how…"), then the detail. The
  Fields are `introduction.overview`, `solution-definition.process-flow` and
  `high-level-solution-overview`, `soap-full-details.sequencing`, `architecture.business-context`
  and `solution-description`, `integration.network-and-infrastructure`, `data.logical-data-model`,
  `security.security-architecture`, `support-and-operations.monitoring-and-alerting`, and
  `as-built-notes.design-overview` and `process-flows`.
- **Architecture state (GF-012).** The same guidance says a diagram or section that isn't the
  enduring design names its state in its caption and its opening sentence: `current`, `interim`,
  `target` or `enduring`, e.g. `Diagram 3. Publishing flow (interim)`.
- **Capability status (GF-021).** `architecture.logical-components` gives every component a
  Status straight after its name (`- <component> — Status: <status> — <description>`), and
  `integration.interfaces` has a Status column. The Status is `existing`, `implemented`,
  `in delivery`, `planned` or `future`, and the guidance says not to assume a capability exists.
  `logical-components` stays a `list` Field, so v1 and v2 still read the same file; its items
  carry the Status rather than a table column.
- **Interim ownership (GF-020).** `support-and-operations.stakeholders`, `risks.risk-register`,
  `risks.open-issues` and `design-basis.outcomes-and-deliverables` mark an owner who is not yet
  confirmed `(interim)`.
- **The Kiwi Cover Mutual example shows each one.** Its security architecture is now a Mermaid
  diagram captioned on the fence, `Security architecture (interim)`, laid out in the pattern: an
  opening sentence that names the interim state, the diagram, an interpretation that says which
  part is interim, then the goals and the layered controls as bullets. It is the SAD's last
  diagram. Every logical component and interface has a Status, and Records Management's contact
  is marked `(interim)` in the support contacts and as the owner of risk R4.

### Production Word styles (#197)

From review items GF-003, GF-004 and GF-014 to GF-017. All of it is in the reference Word
documents, so an organisation's own reference document can change any of it (ADR-0056). All seven
(`reference.docx` and the six `reference-<artefact>.docx`) share one set of styles and one
numbering definition; only their footers differ, as before.

- **Numbered headings.** Heading 1, 2 and 3 are numbered `1`, `1.1` and `1.1.1` by one multilevel
  list, and the table of contents shows the numbers. Heading 4 to 6 aren't numbered: Heading 5's
  old link to an unrelated legal-style list (`1)`) is gone.
- **Unnumbered front matter.** The cover's Title and Subtitle and the `TOC Heading` aren't
  numbered. v3 ships its own `templates/_documentControl.md.tmpl`, v1's partial with
  `## Document Control` and `## Review & sign-off` marked `{.unnumbered}`, which the render writes
  to Word with their numbering switched off. Numbering starts at section 1.
- **Keep with next** on Heading 1 to 6, Caption, Table Caption, Image Caption, Figure and Captioned
  Figure, so a heading or caption is never left at the foot of a page apart from what it belongs to.
- **One table style.** `Table`, which every table uses, has a dark grey (`404040`) header row with
  white bold text and a light grey grid. The table style and `Compact`, the table cells' paragraph
  style, both set 11pt, the body text's size, so every table, cell and short list matches.
- **Rows don't split; header rows repeat.** The `Table` style turns off "Allow row to break across
  pages", which every row of every table takes. Pandoc already marks each table's header row to
  repeat on every page.
- **The User Guide explains a house style.** Its new section "Word styles and your house style"
  covers downloading and replacing a reference document, which styles Gantry uses, and
  `{.unnumbered}`.

### Word budgets on every Field, and the examples condensed to Medium (#203)

The follow-up to review #191: the reviewed SAD came to about 14,000 words, more than reviewers
needed. v3 now tells authors, people and MCP agents alike, how much to write in each Field, and its
example shows the default amount.

- **Every Field that reaches a document has a word budget.** All 102 `markdown` and `list` Fields
  of v3 set `target-words` for Small, Medium and Large (#202, ADR-0054). Every one of them renders
  into at least one Artefact. The only other Field, `document-handling.classification`, is a
  `select` and has none. A new v3 instance works to Medium unless its owner picks another size.
- **How the budgets were set.** Large is today's level of detail: the longer of the two bundled
  examples' lengths for the Field, measured before condensing, rounded up to the next ten (and at
  least ten). Medium is about half of Large and Small about a fifth, rounded to the nearest five,
  with two adjustments:
  - A Field that is mostly a table (risks, interfaces, the glossary, the AD table, the controls)
    keeps about 60% at Medium and 30% at Small, because a table loses rows rather than words.
  - An inherently short Field (purpose, decision requested, next steps, the list of authors) keeps
    about 60% and 30%, and a one-line Field (the Full SOAP's dates, epic and lead) keeps a few
    words at every size: a date doesn't get shorter.

  Across v3, Medium adds up to 53% of Large and Small to 23%.
- **The examples are condensed to Medium.** Every Field of `kiwi-cover-mutual` and `gantry` is
  now within its Medium budget, so "Populate example text" shows the default amount. Kiwi Cover
  Mutual was cut to about half its previous length, not just to the budgets, so its SAD is now
  about 4,900 words, down from about 10,000. The conventions from #199, #200 and #201 survive the
  cut: diagram captions and state labels, the Status of every component and interface, the interim
  owner, the AD | Decision | ADR table, sourced or `(target assumption)` figures, the glossary's
  preferred terms and the path-led integration tables. Kiwi Cover Mutual's other diagrams now
  follow the #199 pattern too: an opening sentence, the diagram, then a paragraph interpreting it.
- **What doesn't change.** No Field, Template, Gate or reference document changed, only budgets
  and example text. A budget is a target, not a limit: an over-budget Field still saves, passes its
  Gate and renders in full. v1 and v2 declare no budgets, so their instances show no size.

Rendered length of each v3 document from its example, in words (the whole document, cover and
Document Control included, counted as the editor counts a Field):

| Document | Example | Before | After |
|---|---|---:|---:|
| `soap` | `kiwi-cover-mutual` | 1,668 | 854 |
| `soap-full` | `gantry` | 3,408 | 1,804 |
| `hld` | `kiwi-cover-mutual` | 3,351 | 1,696 |
| `sad` | `kiwi-cover-mutual` | 10,033 | 4,925 |
| `ssad` | `kiwi-cover-mutual` | 5,026 | 2,485 |
| `as-built` | `kiwi-cover-mutual` | 4,624 | 2,232 |

Each Field's pre-condense length in each example (— where the example doesn't fill the Field),
and the budgets derived from it:

| Field | Kiwi Cover Mutual | Gantry hosting | Large | Medium | Small |
|---|---:|---:|---:|---:|---:|
| `background.problem` | 254 | 132 | 260 | 130 | 50 |
| `background.affected-domains` | 45 | 5 | 50 | 30 | 15 |
| `background.opportunity` | 136 | 189 | 190 | 95 | 40 |
| `background.success-criteria` | 124 | — | 130 | 65 | 25 |
| `introduction.executive-summary` | 202 | — | 210 | 105 | 40 |
| `introduction.overview` | 73 | 188 | 190 | 95 | 40 |
| `introduction.purpose` | 79 | — | 80 | 50 | 25 |
| `introduction.in-scope` | 142 | 149 | 150 | 75 | 30 |
| `introduction.out-of-scope` | 93 | 110 | 110 | 55 | 20 |
| `introduction.content-standards` | 96 | — | 100 | 50 | 20 |
| `design-basis.constraints` | 150 | 359 | 360 | 180 | 70 |
| `design-basis.assumptions` | 125 | 266 | 270 | 135 | 55 |
| `design-basis.caveats` | 76 | — | 80 | 40 | 15 |
| `design-basis.design-principles` | 161 | — | 170 | 100 | 50 |
| `design-basis.outcomes-and-deliverables` | 113 | — | 120 | 70 | 35 |
| `solution-definition.high-level-requirements` | 279 | 128 | 280 | 170 | 85 |
| `solution-definition.process-flow` | 184 | 190 | 190 | 95 | 40 |
| `solution-definition.high-level-solution-overview` | 125 | 173 | 180 | 90 | 35 |
| `solution-definition.feature-breakdown` | 156 | 155 | 160 | 95 | 50 |
| `solution-definition.alternatives-sketch` | 97 | 234 | 240 | 120 | 50 |
| `team-and-estimates.teams-required` | 173 | 95 | 180 | 90 | 35 |
| `team-and-estimates.estimates` | 165 | 144 | 170 | 100 | 50 |
| `team-and-estimates.references` | 54 | 141 | 150 | 75 | 30 |
| `dependencies.dependencies-overview` | 147 | 239 | 240 | 120 | 50 |
| `dependencies.dependency-list` | 173 | — | 180 | 90 | 35 |
| `soap-full-details.epic-project` | 4 | 0 | 10 | 5 | 3 |
| `soap-full-details.requested-lead-by` | 12 | 7 | 20 | 10 | 5 |
| `soap-full-details.request-date` | 3 | 3 | 10 | 5 | 3 |
| `soap-full-details.draft-agreed-date` | 3 | 11 | 20 | 10 | 5 |
| `soap-full-details.delivered-date` | 3 | 10 | 10 | 5 | 3 |
| `soap-full-details.sequencing` | 163 | 147 | 170 | 100 | 50 |
| `soap-full-details.caveats` | 127 | 251 | 260 | 130 | 50 |
| `open-questions.questions` | 170 | 285 | 290 | 175 | 85 |
| `hld-submission.purpose-statement` | 36 | — | 40 | 25 | 10 |
| `hld-submission.authors-and-contributors` | 41 | — | 50 | 30 | 15 |
| `hld-submission.decision-requested` | 63 | — | 70 | 40 | 20 |
| `hld-submission.next-steps` | 60 | — | 60 | 35 | 20 |
| `hld-submission.consultation` | 141 | — | 150 | 75 | 30 |
| `hld-submission.attachments` | 34 | — | 40 | 25 | 10 |
| `proposed-solution.guardrails` | 116 | — | 120 | 60 | 25 |
| `proposed-solution.strategy-alignment` | 115 | — | 120 | 60 | 25 |
| `proposed-solution.implications` | 116 | — | 120 | 60 | 25 |
| `proposed-solution.trade-offs` | 123 | — | 130 | 65 | 25 |
| `proposed-solution.cost-benefit` | 137 | — | 140 | 70 | 30 |
| `proposed-solution.delivery-approach` | 140 | — | 140 | 85 | 40 |
| `alternatives-considered.alternatives` | 351 | — | 360 | 180 | 70 |
| `nfrs.scalability-and-capacity` | 143 | — | 150 | 75 | 30 |
| `nfrs.performance` | 124 | — | 130 | 65 | 25 |
| `nfrs.availability-and-continuity` | 116 | — | 120 | 60 | 25 |
| `nfrs.disaster-recovery-and-backup` | 178 | — | 180 | 90 | 35 |
| `nfrs.other-nfrs` | 141 | — | 150 | 75 | 30 |
| `nfrs.requirements-traceability` | 199 | — | 200 | 120 | 60 |
| `risks.risk-register` | 288 | — | 290 | 175 | 85 |
| `risks.open-issues` | 93 | — | 100 | 50 | 20 |
| `security.identity-and-access` | 194 | — | 200 | 100 | 40 |
| `security.security-architecture` | 347 | — | 350 | 175 | 70 |
| `security.regulations-and-standards` | 73 | — | 80 | 40 | 15 |
| `security.privacy-and-confidentiality` | 164 | — | 170 | 85 | 35 |
| `architecture.business-context` | 264 | — | 270 | 135 | 55 |
| `architecture.solution-users` | 107 | — | 110 | 55 | 20 |
| `architecture.design-decisions` | 309 | — | 310 | 185 | 95 |
| `architecture.architectural-risks` | 150 | — | 150 | 75 | 30 |
| `architecture.solution-description` | 391 | — | 400 | 200 | 80 |
| `architecture.constraints` | 110 | — | 110 | 55 | 20 |
| `architecture.standards` | 95 | — | 100 | 50 | 20 |
| `architecture.logical-components` | 204 | — | 210 | 105 | 40 |
| `integration.interfaces` | 229 | — | 230 | 140 | 70 |
| `integration.network-and-infrastructure` | 226 | — | 230 | 115 | 45 |
| `integration.software-and-licences` | 138 | — | 140 | 85 | 40 |
| `integration.hardware` | 101 | — | 110 | 55 | 20 |
| `integration.bandwidth` | 135 | — | 140 | 70 | 30 |
| `integration.network-devices` | 83 | — | 90 | 45 | 20 |
| `integration.communication-and-network-protocols` | 184 | — | 190 | 115 | 55 |
| `integration.san` | 151 | — | 160 | 95 | 50 |
| `data.logical-data-model` | 234 | — | 240 | 120 | 50 |
| `data.data-classification` | 128 | — | 130 | 65 | 25 |
| `data.data-replication` | 128 | — | 130 | 65 | 25 |
| `data.data-retention-and-archiving` | 148 | — | 150 | 75 | 30 |
| `data.data-migration` | 138 | — | 140 | 70 | 30 |
| `support-and-operations.stakeholders` | 191 | — | 200 | 100 | 40 |
| `support-and-operations.environments-and-domains` | 88 | — | 90 | 45 | 20 |
| `support-and-operations.operational-accounts-and-licenses` | 141 | — | 150 | 75 | 30 |
| `support-and-operations.monitoring-and-alerting` | 143 | — | 150 | 75 | 30 |
| `support-and-operations.release-procedures` | 137 | — | 140 | 70 | 30 |
| `support-and-operations.support-handover-readiness` | 107 | — | 110 | 55 | 20 |
| `support-and-operations.decommission` | 134 | — | 140 | 70 | 30 |
| `glossary.terms-and-definitions` | 451 | — | 460 | 275 | 140 |
| `recovery-plan.recovery-approach` | 260 | — | 260 | 130 | 50 |
| `recovery-plan.resiliency` | 101 | — | 110 | 55 | 20 |
| `recovery-plan.test-scenarios` | 124 | — | 130 | 80 | 40 |
| `recovery-plan.raci` | 129 | — | 130 | 80 | 40 |
| `data-security-controls.controls` | 368 | — | 370 | 220 | 110 |
| `data-security-controls.inheritance-and-dependencies` | 127 | — | 130 | 65 | 25 |
| `as-built-notes.design-overview` | 177 | — | 180 | 90 | 35 |
| `as-built-notes.architecture-decisions` | 185 | — | 190 | 115 | 55 |
| `as-built-notes.process-flows` | 327 | — | 330 | 165 | 65 |
| `as-built-notes.infrastructure-and-configuration` | 309 | — | 310 | 155 | 60 |
| `as-built-notes.appendix` | 144 | — | 150 | 90 | 45 |
| `as-built-notes.changes-from-design` | 125 | — | 130 | 65 | 25 |
| `as-built-notes.acceptance-criteria` | 219 | — | 220 | 110 | 45 |
| `as-built-notes.operational-notes` | 151 | — | 160 | 80 | 30 |
| `as-built-notes.handover-confirmation` | 105 | — | 110 | 55 | 20 |

## v2

Layout revision of v1. Every artefact's `requires` list re-sequenced to the reading
order of its reference document; reuse wired up where v1 declared it but never
connected it; two duplicate field pairs merged. No field `id` renamed. The
rest of this file gives the heading-by-heading mapping behind each move.

### Round five: TAC renamed to ARB (2026-09-19)

- **Gate id renamed**: `hld-tac-approved` → `hld-arb-approved`, everywhere it appears as `gate:` or in a module's `required-at` list. No other change to when the gate closes or what it requires.
- **"Technical Architecture Committee (TAC)" renamed to "Architecture Review Board (ARB)"** as this definition's own canonical name for the body that approves the HLD — CONTEXT.md's glossary, this definition's user-facing `purpose`/`guidance` text (`background`, `introduction`, `solution-definition`, `security`, `architecture`, `proposed-solution`), and the two bundled example instances all updated together. ARB was already the name some of the real source material (the SAD template) used for the same body; this makes it the one name gantry itself uses going forward, and drops a company-specific committee name in favour of a more generic, industry-recognisable one.
- **Not renamed**: citations of the actual external reference document — "the *2026 TAC Architecture High Level Solution Design Template*", "the TAC HLD reference template", "the TAC template" — wherever a comment or the user guide names that specific real source document rather than gantry's own governance vocabulary. That document's own real title still says TAC; this rename is about what gantry calls the committee, not about rewriting a citation.
- **Historical comments and this changelog's own earlier rounds are left as-is** — they're an accurate record of what was true when they were written, the same convention already applied to this repo's ADRs.

### Round four: the HLD trimmed to the TAC reference template's sections (WI #362)

The `hld` artefact listed **38** field references. The *2026 TAC Architecture High
Level Solution Design Template* has a cover block plus 19 headed body sections,
one concept each, and the WI #266 reconciliation concluded "no new fields needed,
no fields to remove". The count roughly doubled for three reasons — whole modules
expanded to every one of their fields when `requires` went field-level (`nfrs`,
`security`, `risks`, `dependencies`); backbone fields wired in for cross-document
reuse (`design-basis.*`, `background.affected-domains`,
`solution-definition.high-level-solution-overview`); and build-ready concerns
surfaced early (`dependencies.dependency-list`, three more `nfrs` fields).
Because the web editor filters visible fields by the selected artefact's
`requires`, the HLD form, the gate and the rendered document inflated together.

`hld.requires` is now **24 entries — one per reference section**, in render order,
using the field ids as consolidated since that template was written
(`problem-statement` → `background`; scope → `introduction.in-scope` /
`.out-of-scope`; questions → the shared `open-questions`).

- **14 field references dropped from the HLD** (38 → 24; the WI #362 ticket says
  "16", but its own list — reproduced here — names 14, and 38 − 24 = 14):
  `background.affected-domains`;
  `design-basis.assumptions?`, `design-basis.constraints?`,
  `design-basis.caveats?`; `solution-definition.high-level-solution-overview?`;
  `nfrs.scalability-and-capacity?`, `nfrs.disaster-recovery-and-backup?`,
  `nfrs.other-nfrs?`, `nfrs.requirements-traceability?`;
  `dependencies.dependency-list?`; `risks.open-issues?`;
  `security.security-architecture?`, `security.identity-and-access?`,
  `security.regulations-and-standards?`.
- **Design basis is removed from the HLD**, reversing WI #331's "every artefact"
  placement for this one document. The TAC template has no home for assumptions,
  constraints or caveats, and for a paper written to be read by TAC, fidelity to
  the reference outweighs cross-document consistency. The `# Design basis`
  section still renders in the Full SOAP, the SAD and the As-built, and the
  fields are still authored at Shape, Detailed Design and Handover. See
  `docs/adr/0032-hld-follows-the-tac-reference-template.md`.
- **Template**: `templates/hld.md.tmpl` drops `## Affected domains`, the whole
  `# Design basis` block, `## Solution overview`, `## Dependency list` and
  `## Open issues`. `## Non-functional requirements` and `## Security and
  privacy` collapse back to a single `##` heading each — the v1 layout —
  carrying `nfrs.performance` + `nfrs.availability-and-continuity` and
  `security.privacy-and-confidentiality` respectively.
- **Stage mounts**: `hld-define` drops `design-basis` and `solution-definition`
  from its `modules:` list. The trimmed artefact requires no field from either
  and `hld` is the stage's only artefact, so mounting them would put editor cards
  on the HLD screen that no HLD section renders. Both still mount at `shape` and
  `detailed-design`.
- **Kept gantry-only additions** (endorsed by WI #266): the headed `# Submission`
  block, `proposed-solution.guardrails` as the Proposed solution intro paragraph,
  and Attachments rendered last.
- **Gate**: no gate was loosened or tightened for the two fixture instances —
  `gantry` still fails `hld-tac-approved` and `kiwi-cover-mutual` still passes.
  At the field level, 12 of the 14 dropped references did not gate at
  `hld-tac-approved` at all. Two did: `background.affected-domains` (bare,
  `required: true`) and `solution-definition.high-level-solution-overview`
  (`required: true`, so its `?` suffix did not exempt it). Both remain mandatory
  at `business-case`, which every HLD is downstream of, and
  `high-level-solution-overview` was only ever demanded at this gate from v2
  onwards — so for that field this restores v1 behaviour. The three fields the
  reference does mandate — `nfrs.performance`,
  `nfrs.availability-and-continuity`, `security.privacy-and-confidentiality` —
  stay bare and keep their `required-at: hld-tac-approved`.
- **No data is lost.** Every dropped field lives in a shared module that still
  mounts at Shape or Detailed Design, so anything already written stays on disk
  and reappears at the stage that owns it.

### Round three: `introduction` split into "Overview" + "Design Basis" (WI #331)

`introduction.yaml`'s eleven fields spanned two functionally different
clusters sharing one module, one heading ("Introduction"), and one editor
mount position per stage: document-opening framing content (executive
summary, overview, purpose, in/out-of-scope, content standards) and ongoing
design conditions (constraints, assumptions, caveats, design principles,
outcomes/deliverables). The editor mount position was inconsistent across
stages (near the end at SOAP/HLD, mid-list at Detailed Design, near the
front at Handover), and the two clusters rendered inconsistently relative to
each other across artefacts — bundled together near the top in SAD/As-built,
but split apart in Full SOAP and HLD, where the conditions cluster was pushed
to just before References/Attachments.

- **`introduction` retitled "Overview"** (id unchanged — no data migration for
  these fields). Field set narrowed to the framing cluster:
  `executive-summary`, `overview`, `purpose`, `in-scope`, `out-of-scope`,
  `content-standards`.
- **New module `design-basis`** (title "Design Basis") holds the conditions
  cluster: `constraints`, `assumptions`, `caveats`, `design-principles`,
  `outcomes-and-deliverables`. Each field's own `id`, `type`, `required-at`
  and `guidance` is unchanged — only its owning module changed. ADR-0028's
  "entered once, refined at every later stage" reasoning for
  constraints/assumptions/caveats still applies, per module.
- **Stage mounts**: both modules mount at the same four stages `introduction`
  always did (`shape`, `hld-define`, `detailed-design`, `handover`), as an
  adjacent pair, near the front — immediately after the stage's own
  context-setting module (`background`, where one exists), ahead of
  solution-detail modules. `shape` and `hld-define` move the pair from
  6th-7th/10th-11th to 2nd-3rd/3rd-4th; `detailed-design` (no context module
  of its own) moves it from 10th to 1st-2nd, matching the SAD's own document
  layout; `handover` keeps `introduction`'s existing 2nd position and adds
  `design-basis` adjacent at 3rd.
- **Document position**: "Overview" and "Design Basis" render as adjacent
  headings, in that order, near the front of every artefact that carries them.
  `soap-full` and `hld` move the conditions cluster from just before
  References/Attachments (end of document) into a new "Design basis" section
  right after Out of scope / Problem Statement — a deliberate deviation from
  the JEDI/TAC reference documents' own literal section order, accepted
  because cross-document consistency for this backbone module outweighs
  fidelity to one legacy reference's placement of "Assumptions". `sad` and
  `as-built` split their existing single "Introduction" heading into
  "Overview" + "Design basis", both still adjacent and in the same position.
  `ssad` folds `executive-summary` (previously its own standalone 1st-section
  heading) into the same "Overview" block as purpose/scope/content-standards,
  still 4th overall; `ssad` renders no `design-basis` fields, so nothing else
  changes there. `soap` is unchanged — it renders no standalone heading for
  either module; `design-basis.assumptions` still folds into "Assumptions and
  considerations" mid-document.
- **Cross-references updated**: `architecture.constraints`'s guidance and
  `soap-full-details.caveats`'s guidance (both cross-reference a moved field)
  now point at `design-basis.*` instead of `introduction.*`.
- **Fixture instances updated**: `examples` and `atlas-reference-design`'s
  stored `modules/introduction.md` content split into `modules/introduction.md`
  (framing fields) and a new `modules/design-basis.md` (conditions fields) to
  match the new module structure. Live/end-user instance data migration is out
  of scope for this change (still pre-release).

### Round two: open questions closed

- **`introduction.executive-summary` added** (optional), wired into `sad` and `ssad`.
  The SAD and SSAD references both open with an Executive Summary that had no
  field. Kept separate from `introduction.overview`, which the SAD also carries.
- **`architecture.solution-users` added** (optional, list). The SAD's "Solution
  Users" (§5.2.1) asks for a User / Description table of the roles that use the
  system; no field carried it.
- **`integration.software-and-licences` added** (optional). The SAD's
  "Application Software View" (§13.1) asks for software, version, total count and
  licences per environment; no field carried it.
- **`support-and-operations.decommission` added** (optional), and decommissioning
  removed from `nfrs.other-nfrs` guidance. End of life is an operational
  lifecycle commitment, not a quality attribute.
- **`support-and-operations.operational-security-controls` removed.** Security
  had three homes for the same content at the same gate. The SSAD's own security
  sections ("developer access to the repositories is restricted to Somar staff
  only"; "API access to Healthpoint is handled by the ingest API and is the only
  component that calls it") are Access-management and Networking rows in the
  approved ATLAS design's control register. `ssad.requires` now lists
  `data-security-controls.controls` (bare, as the removed field was) and
  `.inheritance-and-dependencies?`. Security is now two modules layered by stage:
  `security` for the design-time posture, `data-security-controls` for the
  control set.
- **Disaster recovery split by role, targets pulled through to handover.**
  `nfrs.disaster-recovery-and-backup` owns RTO/RPO and the backup policy
  outright; `recovery-plan.recovery-approach` no longer restates them and
  describes only the mechanism. `nfrs` is mounted at the `handover` stage,
  `disaster-recovery-and-backup` declares `operational-handover`, and the
  `as-built` artefact renders it immediately before the recovery plan.
- **Scope removed from the lightweight SOAP.** `introduction.in-scope` /
  `.out-of-scope` are out of `soap.requires` and `business-case` is out of their
  `required-at`. The reference SOAP has no scope section. The Full SOAP still
  lists both bare, so producing one still forces scope at that gate. This is the
  one deliberate gate loosening in v2.
- **Confirmed as decisions, no change:** `background.problem` and
  `architecture.business-context` stay separate (TAC decision vs builder
  setting); `soap-full-details.caveats` and `introduction.caveats` stay separate
  (verified: the reference Full SOAP's eight caveats all qualify the estimate,
  while the ATLAS design's caveat states a fact about the solution); "Hosting &
  Sites" stays folded into `integration.network-and-infrastructure`.
- **Deliberately not modelled:** the SAD's Document Control, Approved By,
  Consulted, Distribution, Tables & Figures and Appendix, and the SSAD's Sign-Off.
  These stay with the tool and the repo.

### Sequencing

- **`hld`** moved from a whole-module `requires` to a field-level one so the TAC
  template's nesting can be expressed: scope and NFRs inside Problem Statement;
  dependencies, risks and security inside Proposed solution; `attachments` last
  instead of first. Editor scope preserved (every field of the former
  whole-module entries is listed, `?` where it was not mandatory).
- **`sad`**: `dependencies` moved early (reference §6); `risks.open-issues` to
  its own position after the architectural view (§8); `recovery-plan` +
  `nfrs.disaster-recovery-and-backup` before the Information View (§14); the
  `nfrs` performance/scalability/availability fields late, into Operating
  Considerations (§17). `architecture` and `data` field order re-sequenced to
  §7 and §15.
- **`ssad`**: `architecture.logical-components` and `.architectural-risks` moved
  to the front (the reference opens with Solution Products and puts
  Architectural Risks before the Introduction); `release-procedures` moved late.
- **`as-built`**: the governance fields (`changes-from-design`,
  `acceptance-criteria`, `operational-notes`, `handover-confirmation`) moved to
  the end, after the Appendix — v1's order contradicted its own comment.
- **`soap`**: `high-level-requirements` moved ahead of `process-flow`.
- Module field order re-sequenced in `architecture`, `data`, `hld-submission`,
  `integration`, `nfrs`, `proposed-solution`, `support-and-operations`.

### Merges (two field ids removed)

- **`soap-full-details.questions` → `open-questions.questions`.** Same concept as
  the HLD's "Open questions". `open-questions` is now mounted from `shape`;
  `soap-full` references it bare, so the `business-case` gate is unchanged.
- **`integration.environments` → `support-and-operations.environments-and-domains`.**
  The SAD's "Environments" and the SSAD's "Solution Domains" / "URL's, Domains and
  redirections" are one list. `sad` references the shared field bare; gate unchanged.

### Regression fixed

- **`introduction.assumptions?` restored to `soap`.** The reference SOAP carries an
  "Assumptions and considerations" section. WI #280 deleted
  `solution-definition.assumptions-and-considerations` and wired
  `introduction.assumptions` into `soap-full` and `hld` but not `soap`, so the
  lightweight SOAP had no home for it.

### Gate changes

- `nfrs.performance`, `nfrs.availability-and-continuity` and
  `security.privacy-and-confidentiality` now also `required-at: hld-tac-approved`.
  The TAC template makes its "Non-functional requirements" and "Security and
  privacy" sections mandatory ("do not delete sections"), but every field in both
  modules was `build-ready-checklist`-only, so the HLD gate enforced neither.
  Only the fields the template names directly are mandated.
- `introduction.in-scope` / `.out-of-scope` now declare
  `required-at: [business-case, hld-tac-approved, build-ready-checklist,
  operational-handover]` — truthfulness only, matching the bare field references
  that already forced them at the first two gates. No behaviour change.

### Reuse wired up (all optional, no gate change)

`introduction.overview` → `soap-full`; `solution-definition.high-level-solution-overview`
→ `hld`; `solution-definition.high-level-requirements` / `.process-flow`,
`support-and-operations.stakeholders` / `.operational-accounts-and-licenses` /
`.monitoring-and-alerting`, `integration.hardware` / `.bandwidth` /
`.network-devices` / `.communication-and-network-protocols` / `.san`,
`recovery-plan.resiliency` / `.test-scenarios` / `.raci`,
`data-security-controls.inheritance-and-dependencies` and
`team-and-estimates.references` → `sad`; `team-and-estimates.references` and
`introduction.content-standards` → `ssad`; `introduction.design-principles` /
`.outcomes-and-deliverables` → `as-built`. The five `integration` deployment
fields had existed since WI #227 with **no artefact rendering them at all**.

Stage mounts added: `solution-definition` at `hld-define`; `solution-definition`
and `team-and-estimates` at `detailed-design`; `open-questions` at `shape`.

### Correction

v1's `definition.yaml` claimed `SAD Template.docx` carries "a trailing Glossary".
It does not — the document has no Glossary or Terms & Definitions section.
`glossary.terms-and-definitions` is retained in `sad` on its merits (the SSAD and
as-built references both carry one), but the stated justification was wrong.

## v1

Initial published version of the Solution Design definition.

### Cross-stage reuse: `background` + `introduction` backbone (WI #280, in place — see docs/adr/0028)

A structural change to reduce SOAP↔HLD duplication and give scope and
assumptions a single home that carries from SOAP to handover. Applied to
`definitions/design/1/` in place (no `design/2`), with the `examples` and
`atlas-reference-design` fixtures migrated in lockstep. Every gate still
passes; `render:examples` loses no author content (headings move/rename and
scope splits into two sub-sections).

- **`context` module renamed to `background`** (`modules/context.yaml` →
  `modules/background.yaml`). `problem-statement` merged in and deleted.
  Final fields: `problem` (current state; from `context.driver` +
  `problem-statement.current-state`; required-at business-case + HLD),
  `affected-domains` (unchanged), `opportunity` (desired future state; from
  `context.opportunity` + `problem-statement.desired-future-state`;
  required-at HLD), `success-criteria` (from `problem-statement`; required-at
  HLD).
- **Scope backbone.** `introduction.scope` split into `introduction.in-scope`
  and `introduction.out-of-scope` (markdown). `introduction` is now mounted
  from the `shape` stage onward; the two scope fields are the canonical
  cross-stage scope statement, wired into `soap` / `soap-full` / `hld` /
  `sad` / `ssad` / `as-built` `requires`. `context.in-scope` /
  `context.out-of-scope` and `problem-statement.scope` are gone.
- **Assumptions backbone.** `solution-definition.assumptions-and-considerations`
  deleted; `introduction.assumptions` / `.constraints` / `.caveats` now carry
  from SOAP onward and are scoped into `soap-full` / `hld` (`?` optional).
  `architecture.constraints-and-assumptions` renamed to
  `architecture.constraints` ("Constraints and goals"), for
  architecture-specific constraints/goals only.
- **SOAP traceability.** `solution-definition.high-level-requirements` is now
  `required: true` and rendered by `soap.md.tmpl` (it is the agreed set
  `nfrs.requirements-traceability` maps back to). New optional
  `solution-definition.alternatives-sketch` seeds `alternatives-considered`
  for TAC.
- **`required-at` truthfulness.** `introduction.overview` / `.purpose` /
  `.in-scope` / `.out-of-scope`, `recovery-plan.recovery-approach` and
  `data-security-controls.controls` now declare
  `required-at: [build-ready-checklist, operational-handover]`, matching the
  `sad` artefact's field-level `requires` (no gate-behaviour change).
- **Guidance cross-references** added across `proposed-solution`,
  `architecture`, `solution-definition`, `nfrs`, `security`, `open-questions`
  and a reciprocal "HLD `background` vs SAD `introduction` framings are
  intentionally separate" note on `background.problem` and
  `introduction.overview`.
- Templates `soap` / `soap-full` / `hld` / `sad` / `ssad` / `as-built`
  updated for every moved/renamed/split/deleted field.

### `soap` artefact trimmed to a field-level `requires` list (WI #276, in place — see docs/adr/0027)

Now that the engine supports an optional field-ref suffix (`module.field?` —
a field that is in the artefact's scope but only blocks the gate when its own
`required` / `required-at` makes it mandatory), `soap.requires` moves from the
whole-module list `[context, solution-definition, team-and-estimates]` to the
exact fields `soap.md.tmpl` renders, in template section order:

```
context.driver, context.affected-domains, context.out-of-scope?,
solution-definition.process-flow, solution-definition.high-level-solution-overview,
solution-definition.assumptions-and-considerations?, solution-definition.feature-breakdown,
team-and-estimates.teams-required, team-and-estimates.estimates, team-and-estimates.references?
```

- The three never-rendered fields (`context.opportunity`, `context.in-scope`,
  `solution-definition.high-level-requirements`) are dropped — they are Full
  SOAP concepts.
- The three conditionally-rendered fields (`context.out-of-scope`,
  `solution-definition.assumptions-and-considerations`,
  `team-and-estimates.references` — all `required: false`) carry `?`, so the
  `business-case` gate is exactly as strict as under the whole-module list.
- `soap-full` is unchanged (its own `requires` list is independent).
- No instance data migration; rendered SOAP output is byte-identical. Both
  fixtures still pass `check --gate business-case`.

### Field id / title reconciliation round 2 (WI #274, in place — see docs/adr/0027)

**Part 1 — id contradictions.** Two field `id:` values renamed so the id no
longer contradicts its title. Ids are referenced by `id` from the templates
and the `soap-full` artefact's `module.field` `requires` list; those
references and every fixture/test reference were updated in lockstep. No
instance data migration (instance module files match sections by title, and
the titles are unchanged).

- `solution-definition`: the "High level solution overview" field's id is
  now `high-level-solution-overview` — previously a `…-solution-design`
  slug that contradicted the title.
- `team-and-estimates`: the "Teams required" field's id is now
  `teams-required` — previously a `teams-and-contact…` slug that
  contradicted the title.

**Part 2 — casing / wording nits** (display titles only; ids unchanged):

- `context.in-scope`: `In Scope` → `In scope`
- `context.out-of-scope`: `Out of Scope` → `Out of scope`
- `solution-definition.high-level-requirements`: `High Level Requirements` →
  `High-level requirements`
- `alternatives-considered` module: `Alternatives Considered` →
  `Alternatives considered`
- `soap-full.md.tmpl`: the hand-rolled `## Metadata` table heading was
  dropped (finding F12/F13 in
  docs/reconciliation/template-consistency.md) so the five metadata fields
  open the document as a bare table, like the rest of the template's
  sections.

Fixture instance module-file `##`/`#` headings for `examples` and
`atlas-reference-design` were updated to match the new titles.

**Part 3 — drop 3 dead `soap` fields: not implemented in WI #274; applied
later by WI #276** (see the section at the top of this file). The SOAP report's
recommendation to scope the `soap` artefact to a field-level `requires` list
(omitting the never-rendered `context.opportunity`, `context.in-scope`,
`solution-definition.high-level-requirements`) was **not applied**: gantry's
`requires` schema has no syntax to mark a field-level entry optional
(`lib/status.js` pushes every `module.field` entry into the gated set
regardless of the field's own `required:` flag; `splitArtefactRequirement`
is a plain string split). The list would therefore force
`context.out-of-scope`, `solution-definition.assumptions-and-considerations`
and `team-and-estimates.references` — currently optional — mandatory at the
`business-case` gate. `soap.requires` stays
`[context, solution-definition, team-and-estimates]`. See docs/adr/0027 for
the full findings.

### Title reconciliation (WI #268, in place — see docs/adr/0027)

Module and field `title:` values reconciled to the wording of the reference
SOAP, Full SOAP and HLD templates. All `id:` values unchanged; rendered
artefact output is unchanged except for the two intended `soap` heading
renames noted below.

- `context` module: `Context` → `Background and context`
- `context.driver`: `Business driver` → `Problem statement`
- `context.in-scope`: `In scope` → `In Scope` (reverted to `In scope` by WI #274)
- `context.out-of-scope`: `Explicitly out of scope` → `Out of Scope` (set to `Out of scope` by WI #274)
- `solution-definition.high-level-requirements`: `High-level requirements` → `High Level Requirements` (set to `High-level requirements` by WI #274)
- `solution-definition` "High level solution overview" field: `High-level solution design` → `High level solution overview` (field id renamed to match by WI #274)
- `solution-definition.assumptions-and-considerations`: `Assumptions and considerations` → `Assumptions`
- `team-and-estimates` module: `Team and Estimates` → `Teams, contact persons, and high-level estimates`
- `team-and-estimates` "Teams required" field: `Teams and contact persons` → `Teams required` (field id renamed to match by WI #274)
- `team-and-estimates.estimates`: `High-level estimates` → `Estimates`
- `dependencies.dependencies-overview`: `Dependencies overview` → `Dependencies`
- `problem-statement.scope`: `In and out of scope` → `In scope / out of scope`

`soap.md.tmpl` rendered headings updated to match: `# Context` →
`# Background and context`, `# Team and estimates` →
`# Teams, contact persons, and high-level estimates`.

The SOAP report's recommendation to drop the three dead fields
`context.opportunity`, `context.in-scope` and
`solution-definition.high-level-requirements` from the `soap` artefact is
**deferred to the design grill** — the in-place mechanism (a field-level
`requires`) would also narrow the lightweight-SOAP editor and tighten the
gate, neither of which is a title-only change. `soap` `requires` stays
`[context, solution-definition, team-and-estimates]` for now.

`soap-full-details.caveats` field added (defaulting to the JEDI Full SOAP
template's eight caveat bullets); `soap-full.md.tmpl` now renders that field
instead of hard-coding the bullets. `soap-full` artefact `requires` reordered
to follow the reference document's section order.
