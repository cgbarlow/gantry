---
module: architecture
status: agreed
owner: p.natarajan
---
# Architecture

## Business context

KCM sells and services general insurance to its members through its own web and telephone channels. Two business processes change: taking out insurance and handling a claim. For builders, the setting is this: staff work in the CRM System, Policy Data Management holds policies and the claims ledger, the Financial Application holds the money, and the document management system holds the paperwork. Every claim state change is audited, and member data leaves KCM's network only as a payment instruction.

The following diagram presents the business concept view.

![Business concept view](asset:kcm-business-concept-view)

The diagram shows how business users and the solution sit inside the boundary, with the member and the BIBIT gateway outside it. Everything the design adds is inside that boundary except the payment instruction.

## Solution users

- Member — registers claims and requests policies on the web
- Contact Centre Agent — registers claims and requests by telephone
- Claims Handler and Senior Claims Handler — accept and valuate claims
- Claims Payment Approver — releases payments
- Finance Operator — reconciles payments and receipts
- Claims Support Administrator — maintains routing rules
- Internal Auditor — reads claims and audit records

## Architectural risks

- The MQ integration layer is the single path to policies, tested at 20 transactions a second against a design peak of 4 a second (capacity test CT-03); CIS caches policy lookups for 15 minutes (target assumption).
- Claim status shows in Claims InfoServ and the CRM System; Claims InfoServ is authoritative.
- The Financial Application's gateway extension depends on the vendor's release cycle (R2).
- The document migration is the only step that can't be switched back.

## Solution description

The following diagram presents the layered viewpoint.

![Layered viewpoint](asset:kcm-layered-viewpoint)

The diagram shows how the member's business services are realised by Handle Claim, which uses application services realised by the CRM System, Policy Data Management and the Financial Application, with CIS and Claims InfoServ between them, running on the mainframe and the UNIX server farm.

The following diagram presents the product viewpoint.

![Product viewpoint](asset:kcm-product-viewpoint)

The diagram shows how the insurance product aggregates the services this design exposes. Motor insurance adds damage assessment, which is why motor claims have their own routing rules.

The following diagram presents the application usage viewpoint.

![Application usage viewpoint](asset:kcm-application-usage-viewpoint)

The diagram shows how each Handle Claim step uses an application service. Every arrow is an interface in the Integration module.

The following diagram presents the service realisation viewpoint.

![Service realisation viewpoint](asset:kcm-service-realisation-viewpoint)

The diagram shows how each member-facing service is realised by a process Claims Operations or the Contact Centre owns.

## Constraints and goals

Constraints: the mainframe MQ channels support TLS 1.2 only, and the CRM System's extensions run with its own privileges, so anything authoritative lives in Claims InfoServ. Goals: one home for each kind of data (P3), services a future policy platform can sit behind (AD02), and per-call latency that keeps registration within its NFR.

## Applicable standards

- ArchiMate 3.2 for architecture views
- KCM Integration Standard IS-04 (REST over mutual TLS; MQ for the mainframe)
- KCM Data Standard DS-02 (canonical models)
- OpenAPI 3.1 service contracts
- NZISM; PCI DSS v4.0 for the BIBIT gateway scope
- Departure: TLS 1.2 to the mainframe until the MQ upgrade

## Logical components

- Customer Information Service (CIS) — Status: in delivery — customer and policy summary data
- Claims Information Service (Claims InfoServ) — Status: in delivery — claim state, routing rules and audit trail
- Handle Claim workflow — Status: in delivery — CRM System extension orchestrating the four steps
- Take out insurance workflow — Status: planned — web and telephone intake
- Policy Data Management exposures PDM-01 to PDM-04 — Status: in delivery — CICS transactions over MQ
- MQ bridge — Status: existing — extended with new channels
- CRM System, Financial Application and document management system — Status: existing — extended
- BIBIT gateway integration — Status: planned — claims payment and premium collection
- Claims data mart extract — Status: existing — extended with claim events
