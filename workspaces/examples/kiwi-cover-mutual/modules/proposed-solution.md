---
module: proposed-solution
status: agreed
owner: p.natarajan
---
# Proposed Solution

## Guardrails

The solution follows KCM's architecture guardrails G1 (systems of record are not duplicated), G3 (integration through published services, not database sharing), G4 (member data stays in New Zealand), G6 (reuse an existing platform before introducing a new one) and G8 (every external interface is authenticated and encrypted). It introduces no new guardrail. It seeks one time-bound exemption from G7 (no new mainframe dependencies): four new CICS service exposures are added to Policy Data Management so that the applications stop keying into it directly. The exemption is requested because the alternative — migrating policy data first — would delay the member benefit by at least a year, and the exposures are the same ones a later migration would need.

## Alignment with strategy

The Member Experience Strategy 2025–2028 sets "claims settled in days, not weeks" as its first measurable commitment and names the claims cycle time as the board-level metric. This design delivers that commitment through the SOAP's shape — shared services around the existing systems — rather than a platform replacement, which is the approach the Technology Strategy asks for under its "modernise in place, retire on evidence" principle. The shared Customer Information and Claims Information services are the first two of the enterprise services the Technology Strategy's target state describes, so the work lays foundation the mainframe retirement and the digital channel roadmap both reuse. The payment gateway integration meets the Finance Strategy's straight-through-processing target for claims payments.

## Implications

- Claims handlers move from four application screens to one CRM workflow; a training and change programme runs alongside increment 1, owned by Claims Operations.
- Policy Data Management gains four service consumers; the mainframe capacity plan is updated and the monthly change windows for April and May are committed.
- The Finance month-end process changes: claims payments post to the Financial Application on the day of payment rather than in the weekly batch, so reconciliation moves to daily.
- Technology Operations takes on two new services in the UNIX server farm and the payment gateway integration; the on-call roster and monitoring are extended before increment 3.
- The scanning archive is decommissioned once migration completes; Records Management owns the disposal.

## Trade-offs

- Keeping Policy Data Management on the mainframe (rather than migrating it, alternative B) keeps the mainframe cost and skills risk for now. Accepted because it delivers the member benefit two increments earlier and the service exposures are reusable when migration does happen.
- Extending the CRM to orchestrate the process (rather than a dedicated claims-management product, alternative C) limits some workflow features to what the CRM vendor's extension framework supports. Accepted because the CRM already holds the customer relationship and the team knows it; a product would add a licence and a second integration surface.
- Daily rather than real-time reporting feed. Accepted with Finance and Actuarial.
- Manual valuation for complex claims stays. Accepted; automating it is a separate initiative with a different evidence base.

## Risks and mitigations

See the Risks module (rendered below); the risks that bear on this decision are the mainframe change-window capacity (R1) and the BIBIT contract variation (R2), both with owners and mitigations.

## Cost-benefit analysis

The SOAP estimate — one Large and five Medium workstreams plus two Smalls, roughly nine months — translates to an indicative delivery cost of $2.4M to $2.9M including vendor extension work and the BIBIT integration, plus about $180k a year in additional gateway transaction fees and service hosting. Against that, the Claims Service Review attributes roughly $1.1M a year of avoidable cost to re-keying, rework and the extra handlers needed to hold the current cycle time, and the ArchiSurance licence renewal trajectory adds a further $0.3M a year if usage growth continues unmanaged. Non-monetary benefits are the member cycle-time commitment (a board metric), a reduction in the audit findings related to manual payment requests (three open findings), and the reuse of the shared services by the digital channel roadmap. Payback is inside three years on the direct savings alone.

## Delivery approach and indicative timeline

Three increments, each independently switchable back to the manual step:

| Increment | Scope | Indicative timing |
| --- | --- | --- |
| 1 — Register and Accept | CIS, Claims InfoServ, first two Policy Data Management exposures, CRM workflow for Register and Accept, document management integration | Months 1–4 (mainframe exposures in the April and May windows) |
| 2 — Valuate and report | Valuation workflow and routing rules, remaining exposures, Financial Application integration, claims data mart feed, archive migration running in background | Months 4–7 |
| 3 — Pay and intake | BIBIT and bank integration for claims payment and premium collection, web and telephone policy intake | Months 7–9, gated on the contract variation and C&A sign-off |

Each increment ends with a gate: increment 1 requires the threat model and the first C&A checkpoint; increment 3 go-live requires full C&A sign-off. The timeline refines the SOAP's T-shirt sizes and assumes the Claims Platform Team is fully allocated.
