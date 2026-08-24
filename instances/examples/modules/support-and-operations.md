---
module: support-and-operations
status: agreed
owner: c.barlow
---
# Support and Operations

## Stakeholders and support contacts

- Product owner: Disability Allowance product team — first point of contact for scope/priority questions
- Level 1 support: Contoso Service Desk — triages provider-reported issues, escalates to Level 2 if not a known FAQ
- Level 2 support: Provider Portal delivery team — application-level incidents
- Level 3 support: EOS platform team — for intake-API or EOS-side failures

## Environments, URLs and domains

- Production — provider-portal.contoso.com
- Staging — provider-portal.staging.contoso.com
- Development — provider-portal.dev.contoso.com

## Release procedures

Standard Contoso blue/green release via the existing CI/CD pipeline; releases require Level 2 support sign-off and are scheduled outside business hours to minimise provider disruption.

## Support handover readiness

Handover requires: runbook covering the three most common provider-reported issues (login failure, upload failure, wrong reference code), access to the EOS intake-API dashboard, and a tested rollback procedure. All three are in progress and expected complete before Operational Handover.

## Operational accounts and licenses

- Provider-authentication service — production tenant, held by Contoso Platform Engineering
- API Gateway — existing Contoso-wide subscription, no new license required

## Operational security controls

Level 1/2 support have no direct database access — all troubleshooting goes through the EOS case view. Provider Portal admin access is restricted to the delivery team during the initial hypercare period only.

## Monitoring and alerting

Dashboards track submission volume, upload failure rate, and 4xx/5xx rates on the Intake API. Alerts trigger to the delivery team's on-call if the upload failure rate exceeds 5% over a 15-minute window.
