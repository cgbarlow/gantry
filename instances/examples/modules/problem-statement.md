---
module: problem-statement
status: draft
owner: c.barlow
---
# Problem Statement

## Current state

Providers currently submit Disability Allowance certificates by fax or post to a National Office processing team, who manually scan and attach each certificate to the client's EOS application. This creates multi-day processing delays and a manual data-entry step prone to misattribution when a certificate arrives without a clear client reference.

## Desired future state

Providers submit a certificate directly through a self-service portal, referencing the client's application via a one-time reference code; the certificate attaches to the correct EOS application automatically, with no manual scanning or attribution step.

## In scope / out of scope

In scope: a new provider-facing submission portal, one-time reference code issuance and validation, automated attachment to the client's existing EOS application.

Out of scope: any change to how Disability Allowance applications are created or assessed; any provider self-registration capability (providers must already hold provider-authentication service credentials).

## Success criteria

At least 80% of new Disability Allowance certificates arrive via the portal (not fax/post) within 3 months of launch; median certificate-to-EOS-attachment time drops from more than 2 days to under 5 minutes.
