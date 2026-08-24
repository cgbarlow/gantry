---
module: nfrs
status: agreed
owner: c.barlow
---
# Non-Functional Requirements

## Performance

95th percentile upload-to-confirmation time under 5 seconds for a 10MB certificate file, matching Contoso's standard portal SLA.

## Availability and continuity

99.5% availability during business hours, matching other Contoso public-facing portals. Brief outages are tolerable since providers can retry later; no 24/7 SLA required.

## Disaster recovery and backup

RTO 4 hours, RPO 1 hour, in line with EOS's existing DR posture since the portal holds no data of its own beyond a 24-hour transient window. Backups are EOS's existing nightly schedule; the portal itself needs no separate backup job.

## Scalability and capacity

Expected volume: ~200 submissions/day at launch, scaling to ~1,000/day within a year as awareness grows. Provider Portal auto-scales horizontally behind the API Gateway; no capacity concerns identified.

## Other non-functional requirements

Must meet WCAG 2.1 AA, consistent with other Contoso-facing portals.

## Requirements traceability

Every functional requirement in the HLD's proposed solution maps to a component here: certificate upload → Provider Portal + Intake API; application linkage → one-time reference code; provider identity → provider-authentication service integration. No agreed HLD requirement has been dropped.
