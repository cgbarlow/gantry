---
module: hld-submission
status: agreed
owner: p.natarajan
---
# HLD Submission

## Purpose statement

Proposes modernising KCM's claims handling as one orchestrated process on shared services, and asks the Committee to approve the high-level design.

## Authors and contributors

- Priya Natarajan — Solution Architect (author)
- Hana Te Rangi — Head of Claims (sponsor)
- Sam Okafor — Security Architect
- Derek Fong — Mainframe Team Lead
- Liam O'Connor — Finance Systems Manager

## Decision requested

Approve the high-level design: CIS and Claims InfoServ in the UNIX server farm, Policy Data Management exposed as services, the CRM System orchestrating Handle Claim, and the BIBIT gateway for same-day payment.

## Next steps

On approval, detailed design proceeds to the Design Authority, with the privacy impact assessment and threat model in parallel. The April and May mainframe windows are confirmed the following week.

## Consultation

- Claims Operations — endorsed; the handler workflow was walked through with senior handlers.
- Finance Systems and Treasury — endorsed, subject to the BIBIT contract variation.
- Mainframe Integration — endorsed; raised the change-window constraint (risk R1).
- Information Security — endorsed; needs the threat model before increment 1 go-live.
- Privacy Office — endorsed; existing consent covers the shared services.
- Internal Audit — no objection, provided the audit trail stays traceable.

## Attachments

- KCM-2026-014 Full Solution on a Page
- Claims Service Review 2025
- ArchiMate viewpoint diagrams export
- BIBIT contract variation draft
