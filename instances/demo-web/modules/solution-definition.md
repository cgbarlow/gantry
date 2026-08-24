---
module: solution-definition
status: agreed
owner: c.barlow
---
# Solution Definition

## Process flow

A client starts a Disability Allowance application in ContosoSelfService and generates a one-time reference code for their GP. The client gives the code to their GP or nurse practitioner, who logs into the provider portal, enters the code, and uploads the completed certificate. The portal validates the code against the open application in EOS, attaches the certificate to the case file, and notifies the client's case manager that evidence has arrived — no paper handling required.

## High-level solution design

Three components: (1) a reference-code generator surfaced in ContosoSelfService's existing application flow, (2) a new provider-facing portal (reusing the existing external provider-authentication service) for certificate upload, and (3) an EOS integration that attaches the uploaded certificate to the correct case and raises a case-manager notification.

## Assumptions and considerations



## Feature breakdown and involved teams

- Reference-code generation and display in ContosoSelfService — Digital Channels team
- Provider portal (auth, upload, code validation) — Provider Services team
- EOS case-attachment and case-manager notification — Case Management Platform team
