---
module: integration
status: agreed
owner: c.barlow
---

## Interfaces

Provider Portal → Intake API: REST/JSON, inbound from the public internet via API Gateway. Intake API → EOS: internal REST, one-way (create-application-document). Provider Portal → provider-authentication service: OIDC redirect for provider login.

## Network and infrastructure

Hosted in the existing Contoso AWS landing zone, public zone for the Provider Portal, private zone for the Intake API. No new hardware; existing API Gateway licensing covers the new API.

## Environments

- Production — provider-portal.contoso.com
- Staging — provider-portal.staging.contoso.com
- Development — provider-portal.dev.contoso.com
