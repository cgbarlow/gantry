---
module: alternatives-considered
status: agreed
owner: p.natarajan
---
# Alternatives considered

## Alternatives

### Alternative A — Do nothing

Keep the four systems and the manual hand-offs, and meet the cycle-time commitment by adding claims handlers. Rejected: the Claims Service Review shows the re-key error rate is structural, not a staffing problem, so extra handlers hold the cycle time only while volumes are flat. The recurring cost exceeds the modernisation cost within three years and none of the audit findings on manual payment requests are addressed.

### Alternative B — Migrate Policy Data Management off the mainframe first

Replace the inherited ArchiSurance policy platform with a modern policy administration product, then integrate claims handling against it. Rejected for this initiative: the migration is the largest and least certain piece of work in the technology roadmap (data cleansing alone is estimated at a year), and sequencing the claims benefit behind it defers the board commitment by at least eighteen months. The shared services this design builds are exactly what a later migration needs, so nothing is lost by doing them first.

### Alternative C — Adopt a dedicated claims-management product

License a claims-management platform to own the whole Handle Claim process, integrating it to Policy Data Management, the CRM and the Financial Application. Deferred: it would still need the same three integrations plus a fourth to the CRM for customer contact, add an annual licence comparable to the ArchiSurance renewal, and extend the timeline by an estimated two quarters for product selection and configuration. Worth revisiting if the CRM vendor's workflow extension proves limiting in increment 2.

### Alternative D — Point-to-point integration without shared services

Wire the CRM directly to Policy Data Management and the Financial Application without introducing the Customer Information and Claims Information services. Rejected: it removes the re-keying but leaves each application with its own copy of customer and claim data, so the disagreement problem persists, and the web and telephone intake flow would need its own integrations rather than reusing the services.

The proposed solution (shared services around the existing systems, CRM orchestrating the process, payment gateway for settlement) is the one that delivers the member commitment earliest while leaving every larger decision — mainframe retirement, CRM replacement — open.
