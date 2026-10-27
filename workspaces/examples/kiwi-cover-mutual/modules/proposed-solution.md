---
module: proposed-solution
status: agreed
owner: p.natarajan
---
# Proposed Solution

## Guardrails

The solution follows guardrails G1 (no duplicated systems of record), G3 (integration through published services), G4 (member data stays in New Zealand), G6 (reuse before new platforms) and G8 (authenticated, encrypted external interfaces). It seeks one time-bound exemption from G7 (no new mainframe dependencies) for four CICS service exposures, which a later migration would need anyway.

## Alignment with strategy

The Member Experience Strategy's first commitment is "claims settled in days, not weeks". This design meets it by modernising in place, as the Technology Strategy asks, and CIS and Claims InfoServ are the first of that strategy's target enterprise services. Payment through the BIBIT gateway meets Finance's straight-through-processing target.

## Implications

- Claims handlers move from four screens to one CRM System workflow, with training owned by Claims Operations.
- Policy Data Management gains four service consumers and committed April and May change windows.
- Claims payments post daily, so Finance reconciles daily.
- Technology Operations runs two new services and the BIBIT gateway integration.

## Trade-offs

- Policy Data Management stays on the mainframe (not alternative B): mainframe cost and skills risk remain, but members benefit two increments sooner.
- The CRM System orchestrates the process (not alternative C): workflow is limited to the vendor's extension framework, but no new licence.
- Reporting is daily, not real time, as Finance and Actuarial accept.

## Risks and mitigations

See the Risks module: mainframe change-window capacity (R1) and the BIBIT contract variation (R2).

## Cost-benefit analysis

The SOAP estimate gives an indicative delivery cost of $2.4M to $2.9M, plus about $180k a year in gateway fees and hosting. The Claims Service Review attributes about $1.1M a year of avoidable cost to re-keying and rework, so payback is inside three years on direct savings alone. It also closes three audit findings on manual payment requests.

## Delivery approach and indicative timeline

Three increments, each switchable back to the manual step:

| Increment | Scope | Indicative timing |
| --- | --- | --- |
| 1 — Register and Accept | CIS, Claims InfoServ, first two exposures, CRM System workflow, document management integration | Months 1–4 |
| 2 — Valuate and report | Valuation and routing, Financial Application integration, data mart feed | Months 4–7 |
| 3 — Pay and intake | BIBIT gateway payment and collection; web and telephone intake | Months 7–9, after C&A sign-off |
