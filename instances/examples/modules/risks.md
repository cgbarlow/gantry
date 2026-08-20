---
module: risks
status: agreed
owner: c.barlow
---

## Risks and mitigations

1. **Reference-code mistyping** (owner: delivery lead; likelihood medium, impact medium) — mitigated by a checksum digit and a client-name confirmation step; current rating Medium, projected Low once mitigation lands.
2. **Provider-authentication service outage** (owner: integration lead; likelihood low, impact high) — no mitigation yet beyond the service's own SLA; current rating Medium.

## Open issues

Whether providers without an existing provider-authentication account should be able to self-register through this portal, or must be onboarded by Contoso first, is still under discussion with the provider-authentication service owner.
