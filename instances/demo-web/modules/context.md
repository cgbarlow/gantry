---
module: context
status: agreed
owner: c.barlow
---
# Context

## Business driver

Contoso currently requires clients applying for the Disability Allowance to submit a paper GP certificate by post or in person, which slows processing and disadvantages clients without easy access to a branch or postal service. This initiative lets an accredited GP or nurse practitioner submit the certificate directly through a secure online portal, linked to the client's application by a one-time reference code.

## Affected domains

- Application intake and workflow (EOS, S2P, BPM)
- Case management (CMS)
- Client-facing self-service (ContosoSelfService)
- Provider-facing services (new)

## Explicitly out of scope

Digitising other supporting-evidence types (e.g. specialist reports) is out of scope for this release; only the GP/nurse practitioner certificate for Disability Allowance is covered. Provider identity verification reuses an existing external provider-authentication service rather than building a new one.
