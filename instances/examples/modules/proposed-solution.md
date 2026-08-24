---
module: proposed-solution
status: draft
owner: c.barlow
---
# Proposed Solution

## Alignment with strategy

Directly supports Contoso's digital-first channel strategy by replacing a fax/post-based manual process with a self-service digital channel, and reduces National Office administrative burden.

## Trade-offs

Trades a small amount of provider friction (needing a reference code from the client) for a large reduction in manual processing risk; a fully open self-registration flow would remove that friction but was rejected as a materially larger identity-risk surface.

## Delivery approach and indicative timeline

Delivered by a single cross-functional team (Provider Portal + Intake API) over an estimated 2 quarters: quarter 1 for build and provider-authentication integration, quarter 2 for UAT and phased provider onboarding.

## Guardrails

Follows the Contoso API Gateway integration guardrail and the existing provider-authentication identity guardrail. No exemption is sought and no new guardrail is introduced.

## Cost-benefit analysis

Estimated build cost: ~380 person-days across 2 quarters. Estimated benefit: removal of ~15 person-hours/week of manual scanning and data-entry work in National Office, plus a multi-day reduction in certificate processing time that reduces follow-up contact volume.
