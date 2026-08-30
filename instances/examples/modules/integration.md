---
module: integration
status: agreed
owner: c.barlow
---
# Integration

## Interfaces

Provider Portal → Intake API: REST/JSON, inbound from the public internet via API Gateway. Intake API → EOS: internal REST, one-way (create-application-document). Provider Portal → provider-authentication service: OIDC redirect for provider login.

## Network and infrastructure architecture

Hosted in the existing Contoso AWS landing zone. Provider Portal sits in the public zone behind the shared API Gateway; the Intake API runs in the private zone. No new sites or virtual networks are provisioned beyond the existing landing zone VPCs and their public/private subnets.

## Hardware

No new hardware. Existing API Gateway and ALB capacity covers the new API. No additional servers are provisioned; the solution runs on the landing zone's managed compute.

## Bandwidth

No additional bandwidth beyond the existing AWS Direct Connect and landing-zone transit. Anticipated Provider Portal traffic is within current VPC and Direct Connect limits; intake payloads are small JSON documents with no bulk transfer.

## Network Devices

No new network devices. Traffic uses the existing API Gateway, ALB and WAF in the landing zone. Existing DNS and reverse-proxy configuration is reused; no IPv6 changes required.

## Communication & Network Protocols

| Environment | Protocol | From | To | Port | Path |
| --- | --- | --- | --- | --- | --- |
| All | HTTPS/TLS 1.2 (REST/JSON) | Provider Portal | Intake API (via API Gateway) | 443 | Public → private |
| All | HTTPS/TLS 1.2 (REST) | Intake API | EOS | 443 | One-way internal |
| All | OIDC redirect (HTTPS) | Provider Portal | provider-authentication service | 443 | Public redirect |

No new protocols beyond HTTPS/REST and OIDC are introduced; existing TLS termination at the Gateway is reused.

## SAN (Database, Application Server, Backup, DR)

No dedicated SAN required. Persistent data resides in the existing EOS service stores. No new database or file storage is provisioned at this stage; backup and DR continue to use the landing zone's existing schedules.

## Environments

- Production — provider-portal.contoso.com
- Staging — provider-portal.staging.contoso.com
- Development — provider-portal.dev.contoso.com
