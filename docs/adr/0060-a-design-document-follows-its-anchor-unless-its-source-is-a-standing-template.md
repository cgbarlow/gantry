# A design document follows its sibling anchor, unless its source is a standing template

#231, design v3. Generalises ADR-0057 (the SSAD follows the SAD, not its
reference instance) and keeps ADR-0032 (the HLD follows the TAC reference
template) as the one case that goes the other way.

Every design Artefact was first shaped after a reference document (ADR-0021,
ADR-0025): the SAD after the *SAD Template*, the HLD after the *2026 TAC
Architecture High Level Solution Design Template*, the SSAD after the *FV Help
Tool SSAD*, the As-built after *ATLAS – Migration Infrastructure Design –
Approved*, and the SOAP and Full SOAP after *SAMPLE SOAP – Mobile Phone
Assistance* and the *JEDI Full SOAP Template*. Reproducing each source's order
and headings kept each document faithful to its source, but put the same Field
in different places under different names in documents the same people read
side by side.

ADR-0057 settled this for the SSAD. The As-built had the same problem. It is
read at Operational Handover by the reviewers who read the SAD and SSAD at
build-ready, and it opened with "Terms & Definitions" where they close with
"Glossary". It listed Constraints before Assumptions, headed the recovery
chapter "Recovery plan" with the backup policy first, and gave the data
security controls a chapter of their own under different names. The shared
partial that renders those controls still recorded that the As-built kept its
names only because an earlier refactor (WI #273) could not change rendered
output.

## Decision

**When a design document's source is one filled instance, consistency with its
sibling documents wins over fidelity to that source. When the source is a
standing template that its readers hold the document to, fidelity wins.**

A filled instance, such as the FV Help Tool SSAD, the ATLAS design or a sample
SOAP, records how one document for one product was written. Its headings are
often that product's names, and no reader checks Gantry's output against its
structure. The document's closest readers are the readers of its siblings, so a
Field both documents render takes the sibling's heading, in the sibling's
order. The document's own chapters, the content that makes it the document it
is, stay together in their own place.

A standing template is a structure a reader publishes and reads every paper
against. The HLD's source, the TAC (now ARB) template, is the only such source
among the design documents. The HLD keeps the template's sections and nothing
else (ADR-0032), even where a sibling names the same Field differently.

Each group of sibling documents has one **anchor**, the document that holds
everything its siblings hold:

- **The SAD** for the build-stage documents: the SSAD (ADR-0057) and the
  As-built.
- **The Full SOAP** for the business-case pair: the SOAP follows it (#232).

The anchors were themselves shaped after blank templates, the *SAD Template*
and the *JEDI Full SOAP Template*. Neither is a structure a committee reads
every paper against, as the TAC template is for the HLD, so neither is a
standing template in this sense. The SAD and the Full SOAP keep their order
because they are the anchors, and a change to an anchor's order or headings
should carry through to the siblings that follow it.

### Applied to the As-built

- The Overview chapter opens with the optional Executive summary, as in the
  SAD and SSAD. `introduction.executive-summary?` joins the As-built's scope
  as optional. It is already mounted at Operational Handover, so no gate gets
  stricter.
- Design basis lists Assumptions before Constraints, then Caveats, Design
  principles and Outcomes and deliverables. The chapter and each section still
  appear only when filled.
- "Recovery plan" becomes the SAD's **Failure and recovery**: Recovery
  approach first, with Resiliency, Test scenarios and RACI when filled, then
  Backup and archiving policy.
- The data security controls sit in a **Security** chapter under the SAD's
  headings, "Security concerns" and "Security control inheritance and
  dependencies". The shared partial now owns those headings for every caller.
- "Terms & Definitions", the first chapter, becomes **Glossary**, the last.

The As-built's own chapters keep their order after the shared ones: As-built
design, Appendix, Changes from the agreed design, Acceptance criteria,
Operational notes and Handover confirmation. They are what makes the As-built
an as-built record, as Support and operations is for the SSAD. References stays
out, because rendering it would mean mounting Teams and estimates at
Operational Handover.

## Consequences

- Only design v3 changes. v1 and v2 are published and render exactly as before.
- No Field leaves the As-built, none changes between bare and `?`, and no
  Module is newly mounted, so `operational-handover` is exactly as strict as
  before.
- The User Guide's As-built reference-mapping table still maps every ATLAS
  heading; for version 3 it notes where each now lands.
- ADR-0025's statement that `as-built.md.tmpl` renders in "the ATLAS
  reference's exact order" describes v1 and v2. For v3 the order is this
  ADR's.
- A new design document, or a change to an existing one, starts by asking
  which kind of source it has. A filled instance means the anchor's headings
  and order. A standing template means the template's.

## Status

Accepted.
