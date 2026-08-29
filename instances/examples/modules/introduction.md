---
module: introduction
status: agreed
owner: c.barlow
---
# Introduction

## Overview

The Provider Portal lets registered health providers submit a Disability
Allowance medical certificate for an existing Contoso client without needing an
Contoso login for the client or exposing the client's identity to the provider
beyond a masked name and month/year of birth. The certificate is attached to
the client's existing application in EOS, Contoso's system of record.

## Purpose

This document describes the solution as built, in enough detail for a support
engineer or a future delivery team — unfamiliar with this system — to operate
it, change it safely, or rebuild it. It is also the evidence base for the
Certification and Accreditation (C&A) sign-off obtained before go-live.

## Scope

### In scope

- A public web portal for provider-authenticated certificate submission.
- An internal Intake API that validates the one-time reference code, validates
  the uploaded file, stores it, and attaches it to the EOS application.
- The `reference_codes` table and the extension of the existing `eos-sync`
  job that populates it.
- AWS infrastructure for the portal, the API, the session store and the
  certificates bucket, all in the existing Contoso landing zone.

### Out of scope

- Provider registration and provider identity — handled entirely by the
  external provider-authentication service.
- Any change to EOS beyond calling its existing `create-application-document`
  endpoint.
- Reference-code generation — EOS already generates these; this solution only
  consumes them.
- Provider-facing status tracking after submission.

## Constraints

- Must run in the existing Contoso AWS landing zone (`contoso-prod-govt`,
  `ap-southeast-2`) and reuse the existing Contoso API Gateway and `*.contoso.com`
  wildcard certificate — no new public IP or domain.
- Must not hold any client-identifying data at rest beyond what EOS already
  holds; the portal may only ever show a masked name and month/year of birth.
- All infrastructure is defined in Terraform and deploys via pipeline.

## Assumptions

- The external provider-authentication service is available and returns a
  provider registration number in its `id_token`.
- EOS reference codes are created at application time and are available in the
  `reference_codes` table within the `eos-sync` interval (nominally 5 minutes).
- The existing shared Postgres instance has capacity for the additional
  `intake` schema.

## Caveats

- The Redis session store is single-node; a restart mid-session forces the
  provider to start the submission again. Accepted for launch.
- `eos-sync` can lag up to 10 minutes under EOS's end-of-day batch load, so a
  freshly created reference code may briefly 404.

## Design principles

| Ref | Principle | How it is achieved |
|-----|-----------|--------------------|
| DP1 | Least client data | The portal only ever handles a masked name and month/year of birth; nothing client-identifying is stored or logged. |
| DP2 | Reuse before build | Existing API Gateway, wildcard cert, Postgres instance, KMS key and `eos-sync` job are reused rather than replaced. |
| DP3 | Fail closed | An unrecognised or bad-checksum reference code, or a file that fails magic-byte validation, is rejected before any state is written. |
| DP4 | No ambient authority | The Intake API has no public route; it is reachable only from the portal's security group. |

## Outcomes and deliverables

| Phase | Deliverable | Ownership |
|-------|-------------|-----------|
| Design | Solution architecture (SAD/SSAD), C&A evidence pack | Architecture |
| Build | `provider-portal` and `intake-api` services, `007_reference_codes.sql` migration, `eos-sync` extension, Terraform | Provider Portal delivery team |
| Handover | This as-built document, runbook links, operational handover to Contoso Digital Support | Delivery lead + Architecture |

## Content standards

This SSAD is the support-oriented view of the same design dataset as the SAD;
where a topic is covered in full by the SAD, this document summarises it and
points there rather than repeating it. Component and sequence diagrams use the
C4 model; infrastructure diagrams are generated from the Terraform plan and so
follow AWS's own iconography. Diagrams contributed by the provider-authentication
vendor keep their original house style.
