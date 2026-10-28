# The SSAD follows the SAD's order and headings, not its reference instance's

#213, design v3. Follows ADR-0021 (the SAD and SSAD are two renderings of one
set of detailed design data) and is the counterpart to ADR-0032 (the HLD
follows the TAC reference template).

Since v2 (WI #318), the `ssad` artefact rendered in the reading order of the
*FV Help Tool SSAD*: Solution Products (the logical components), Architectural
Risks and Risks first, then the Introduction, then one Solution Overview chapter
holding everything else — fifteen sub-sections of stakeholders, environments,
dependencies, interfaces, NFRs, security, accounts, monitoring, release and
handover. The SAD, rendered at the same Gate from the same fields, opens with
its Overview and follows its own template's chapters.

A reader moving between the two documents — the same reader, often, reviewing
both for `build-ready-checklist` — found the same content in different places
under different names: "Logical components" in one, "Logical components view"
in the other; "Disaster recovery and backup" against "Backup and archiving
policy"; Open issues as a chapter in one and a sub-section of Risks in the
other.

## Decision

**The SSAD follows the SAD's reading order and heading names.** Every chapter
up to Technology architecture is the SAD's, in the SAD's order, holding only the
fields the SSAD renders:

1. Overview
2. Business architecture (Stakeholders and support contacts)
3. Solution overview (Solution description, Dependency list, Architectural risks)
4. Open issues
5. Risks (Risk register)
6. Logical components view
7. Technology architecture (Interfaces)
8. **Support and operations**
9. Glossary
10. References

The support-team material — environments, data classification, backup,
scalability, availability, security, accounts and licences, monitoring, release
procedures and handover readiness — stays together in one Support and
operations chapter rather than spreading across the SAD's Failure and recovery,
Information view, Security and Operating considerations chapters. That chapter
is what makes the SSAD a support document rather than a shorter SAD.

A field both documents render takes the SAD's heading, with one exception:
"Stakeholders and support contacts" keeps its name, because to a support team
the contacts and escalation path are the point.

No field enters or leaves the SSAD, and no entry changes between bare and `?`,
so `build-ready-checklist` is exactly as strict as before. `stakeholders`,
`monitoring-and-alerting` and `operational-accounts-and-licenses` stay
mandatory in the SSAD though the SAD treats them as optional.

### Why consistency wins here when fidelity won for the HLD

ADR-0032 kept the HLD faithful to its reference because the HLD is a submission
to a standing committee that publishes the paper's structure and reads every
paper against it. A section the template doesn't have is a section that reader
isn't looking for.

The SSAD's reference is nothing like that. It is **one filled instance for one
product family**, not a template (ADR-0021 already notes this): most of its
headings are product names, and its order reflects how that one document was
written, not a structure any reader holds Gantry's output to. Its closest
reader is the SAD's reader. Where fidelity to the reference and consistency
with the SAD collide, consistency wins for the SSAD.

## Consequences

- Only design v3 changes. v1 and v2 are published and render exactly as before.
- The User Guide's SSAD reference-mapping table still maps every FV Help Tool
  SSAD heading; for version 3 it notes where each now lands.
- ADR-0021's statement that "the SSAD list follows … FV Help Tool SSAD.docx"
  describes v1 and v2. For v3 the order is this ADR's.
- #233 applied the heading rule to the one section #213 missed: the SSAD's
  "Support handover readiness" is now the SAD's "Operational readiness". No
  new exception was needed.

## Status

Accepted.
