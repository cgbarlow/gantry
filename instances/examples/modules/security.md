---
module: security
status: agreed
owner: c.barlow
---

## Identity and access management

Providers authenticate via the existing external provider-authentication service (OIDC); no new credential store. Internal Contoso staff have no direct access to the portal — support access is via the EOS case record only.

## Security architecture

The portal is stateless and holds certificates only transiently; it is not a long-term data store, which limits the blast radius of a portal-level compromise. All traffic terminates at the existing API Gateway, inheriting its WAF and rate-limiting.

## Regulations and standards

- Privacy Act 2020
- Health Information Privacy Code 2020
- Contoso Information Security Policy

## Privacy and confidentiality concerns

Certificates are health information under the Health Information Privacy Code. Access is limited to the automated EOS handoff; no Contoso staff view the raw upload through the portal itself. Providers see only their own submissions, scoped by their authenticated session.
