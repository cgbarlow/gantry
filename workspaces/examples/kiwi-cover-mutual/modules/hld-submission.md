---
module: hld-submission
status: agreed
owner: p.natarajan
---
# HLD Submission

## Purpose statement

This paper proposes modernising Kiwi Cover Mutual's claims handling as a single orchestrated process on shared customer and claims services, and asks the Technical Architecture Committee to approve the high-level design so detailed design can begin.

## Authors and contributors

- Priya Natarajan — Solution Architect (author)
- Hana Te Rangi — Head of Claims (sponsor)
- Sam Okafor — Security Architect (security and privacy sections)
- Derek Fong — Mainframe Team Lead (Policy Data Management integration)
- Liam O'Connor — Finance Systems Manager (payments)
- Mereana Walker — Platform Engineering Lead (infrastructure)

## Decision requested

Approve. The Committee is asked to approve the high-level design — shared Customer Information and Claims Information services in the UNIX server farm, Policy Data Management retained on the mainframe and exposed as services, the CRM System extended to orchestrate the Handle Claim process, and the BIBIT payment gateway integrated for same-day claims payment — and to endorse proceeding to detailed design on that basis.

## Next steps

On approval the design proceeds to detailed design against the build-ready checklist, with the Solution Architecture Document and the Solution Support Architecture Document submitted to the Design Authority. The privacy impact assessment and the security threat model run in parallel. The mainframe change-window bookings for April and May are confirmed with the Mainframe Integration team the week after this Committee.

## Consultation

- Claims Operations (Hana Te Rangi, Claims Team Leads) — endorsed; the handler workflow was walked through with two senior handlers.
- Finance Systems and Treasury (Liam O'Connor, Anaru Pihema) — endorsed, subject to the BIBIT contract variation and reconciliation design in increment 2.
- Mainframe Integration (Derek Fong) — endorsed the service-exposure approach; raised the change-window constraint recorded as risk R1.
- Information Security (Sam Okafor) — endorsed the two-layer security model; requires the threat model before increment 1 go-live.
- Privacy Office (Elena Rossi) — endorsed; confirmed existing member consent covers the shared services, with a PIA for the data mart feed.
- Contact Centre and Digital Channels (Grace Ioane, Sophie Marsh) — endorsed the shared-services approach to policy intake; asked that telephone intake keep the seller in the loop, which the design does.
- Internal Audit (Marcus Bell) — no objection; requires the audit trail requirement to be traceable through detailed design.

## Attachments

- KCM-2026-014 Full Solution on a Page (approved 13 March 2026)
- Claims Service Review 2025 — cycle time and re-key analysis
- ArchiMate viewpoint diagrams — enterprise architecture repository export, KCM-2026-014
- BIBIT contract variation draft — Treasury, April 2026
