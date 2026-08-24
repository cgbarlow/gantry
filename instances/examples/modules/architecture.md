---
module: architecture
status: agreed
owner: c.barlow
---
# Architecture

## Business context

Accredited GPs and nurse practitioners currently have no digital channel to submit a Disability Allowance certificate on a client's behalf; this solution gives them a secure online portal to do so.

## Applicable standards

- Contoso API Gateway integration pattern
- WCAG 2.1 AA for the provider-facing portal

## Design decisions

A stateless web portal was chosen over embedding the flow inside ContosoSelfService, since providers are external users without ContosoSelfService credentials. A one-time reference code links a submission back to the client's application without requiring provider-side client lookup.

## Solution description

The Provider Portal is a new public-facing web application fronted by the API Gateway. It authenticates providers via an external provider-authentication service, accepts the certificate upload, and posts it to EOS via a new intake API. EOS remains the system of record for the application.

## Logical components

- Provider Portal (new)
- Intake API (new)
- EOS (existing)
- Provider-authentication service (existing, external)

## Architectural risks

The one-time reference code is the sole link between a submission and a client's application; if a provider mistypes it, the certificate could attach to the wrong case. Mitigated by a checksum digit and a confirmation step showing the client's masked name before submission.

## Goals, constraints and assumptions

Assumes providers already hold credentials with the external provider-authentication service. Constrained to certificate upload only in this release — no two-way messaging with providers.
