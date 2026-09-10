---
module: architecture
status: agreed
owner: p.natarajan
---
# Architecture

## Business context

Kiwi Cover Mutual sells and services general insurance to about 310,000 members through its own web and telephone channels. Two business processes are affected: taking out insurance (request received, processed, premium collected) and handling a claim (register, accept, valuate, pay). The problem and opportunity were approved at SOAP and HLD; for builders the setting is this: the CRM System is where staff work, Policy Data Management on the mainframe holds the policies and the claims ledger, the Home & Away Financial Application holds the money, and the document management system holds the paperwork. The regulatory setting — the Privacy Act, the Fair Insurance Code's timeframes, and the prudential record-keeping rules — is listed in Security; what it means for the build is that every claim state change is audited and that member data does not leave the KCM network except as a payment instruction.

### Business concept view

![Business concept view](asset:kcm-business-concept-view)

The concept view shows the boundary the design works within. Inside the boundary, a business user (a claims handler or an insurance seller) works with the solution and its data store; outside it, the client (the member) interacts through the web and telephone channels, and the solution interacts with an external party — the payment gateway and bank. Everything the design adds sits inside that boundary except the payment instruction.

### Wider context

KCM's Technology Strategy names shared enterprise services as its target state and "modernise in place, retire on evidence" as the route to it. This design delivers the first two shared services (customer information, claims information) and the service exposures on the mainframe that a later policy-platform migration would reuse.

## Solution users

- Member — registers claims and requests policies on the web; receives payments and correspondence
- Contact Centre Agent — registers claims and policy requests on the member's behalf by telephone
- Claims Handler — accepts, valuates and progresses claims within an authority limit
- Senior Claims Handler — handles complex and high-value claims; approves valuations above the limit
- Claims Payment Approver — releases approved claim payments (separated from valuation)
- Insurance Seller — processes telephone policy requests through to binding
- Finance Operator — reconciles claims payments and premium receipts in the Financial Application
- Claims Support Administrator — maintains routing rules, reference data and templates
- Actuarial / Finance Analyst — consumes the claims data mart
- Internal Auditor — reads claims and audit records

## Design decisions

1. **Shared services rather than point-to-point integration.** Customer and claim data are served by CIS and Claims InfoServ; applications consume them rather than holding copies. Alternative D (point-to-point) was rejected at HLD because it leaves the data disagreement in place.
2. **Policy Data Management stays the policy system of record, exposed as services.** Four CICS transactions (policy lookup, insured-item lookup, policy create, claim ledger update) are exposed over MQ through the integration layer. Migration (alternative B) is deferred; the exposures are what migration would need anyway.
3. **The CRM orchestrates Handle Claim; Claims InfoServ owns the claim state.** The workflow runs in the CRM's extension framework, but the claim's state, valuation and audit trail are held in Claims InfoServ so the process can move to another orchestrator without losing data. Routing rules also live in Claims InfoServ (risk R3).
4. **Payments go through the Financial Application, then the gateway.** A claim payment is recorded in the Home & Away Financial Application first (so Finance's ledger is authoritative) and the Financial Application instructs the BIBIT gateway; the CRM never talks to the gateway directly. Premium collection follows the same path in reverse.
5. **Documents are claim-indexed in the document management system.** Every document is stored once, keyed by claim number, and linked from the CRM; the scanning archive is migrated and retired.
6. **Each increment is switchable.** A configuration flag per process step falls back to the previous manual step (design principle P5), so go-live is reversible per step.
7. **No new platform.** New components run in the existing UNIX server farm under existing deployment and monitoring tooling; the only new external party is the payment gateway, which is contracted through Treasury.

## Architectural risks

- The mainframe MQ integration layer is a single path for all policy reads and writes; if its throughput assumptions (20 transactions a second tested, 4 a second design peak) are wrong, every process step slows. Mitigated by the capacity test and by caching policy lookups in CIS for 15 minutes.
- Holding claim state in Claims InfoServ while the CRM runs the workflow creates two places a claim's status could be read; the design makes Claims InfoServ authoritative and the CRM a view, and the acceptance tests assert they agree.
- The Financial Application's extension for gateway payment is vendor-delivered on the vendor's release cycle; a slip there delays increment 3 (tracked with R2).
- The document migration is the largest data movement in the initiative and the only one that cannot be switched back; it is run in background with a claim-level reconciliation report.

## Solution description

The solution is best read as four layers — business, application, technology and the services between them — which the layered viewpoint shows in one picture.

### Layered viewpoint

![Layered viewpoint](asset:kcm-layered-viewpoint)

At the top, the external roles and actors: the insurant (the member) and the client relationship. The external business services they use — claim registration, customer information and claim payment — are realised by the Handle Claim business process (Register, Accept, Valuate, Pay), performed by the insurer role within KCM (labelled with the inherited ArchiSurance name in the diagram). Those process steps use the external application services — insurance application, customer data modification and premium payment — which are realised by the application components: the CRM System, Policy Data Management and the Financial Application, with the Customer Information Service (CIS) and Claims Information Service (Claims InfoServ) between them. The application components use two infrastructure services, claim files and customer files, realised by the mainframe (CICS, DBMS, message queuing), the UNIX server farm and the NAS file server.

### Product viewpoint

![Product viewpoint](asset:kcm-product-viewpoint)

The product viewpoint shows what the member buys and the services attached to it. The Insurance product aggregates the services this design exposes — insurance application, premium payment, customer information, customer data modification, claim registration and claim payment — under a single insurance policy contract. Car (motor) insurance specialises it and adds a damage assessment service, which is why the Valuate step has product-specific routing rules for motor claims.

### Application usage viewpoint

![Application usage viewpoint](asset:kcm-application-usage-viewpoint)

This viewpoint shows which application service supports each step of Handle Claim. Register uses the scanning (document) service and the customer administration service; Accept uses customer administration; Valuate uses the claims administration service; Pay uses the printing (correspondence) service and the payment service. Those services are realised by the document management system, the CRM System, the Home & Away Financial Application and the Home & Away Policy Administration (Policy Data Management) respectively. Every arrow in this diagram corresponds to an interface in the Integration module.

### Service realisation viewpoint

![Service realisation viewpoint](asset:kcm-service-realisation-viewpoint)

The service realisation viewpoint closes the loop between what the customer sees and what KCM does: the insurance application service is realised by the Close Contract process (take out insurance), the claim registration and claims payment services by Handle Claim, the customer information service by Inform Customer, and the premium payment service by Collect Premium. This is the view the Contact Centre and Claims Operations signed off, because it names the processes they own.

## Constraints and goals

Architecture-specific constraints: the mainframe MQ channels support TLS 1.2 only (the integration layer re-encrypts); the CRM extension framework runs with the CRM's privileges, so anything that must be authoritative or auditable lives in Claims InfoServ, not in the CRM; the UNIX server farm's load balancer supports only HTTP/1.1 health checks, which shaped the service health endpoints. Architecture goals: one authoritative home for each kind of data (principle P3), services that a future policy platform can sit behind unchanged (decision 2), and a latency budget of 500 ms per shared-service call so the 3-second registration target holds with two calls and a document write. Solution-wide assumptions are in the Design Basis module.

## Applicable standards

- ArchiMate 3.2 for architecture views; C4 for the deployment detail in the Integration module
- KCM Integration Standard IS-04 (REST/JSON over mutual TLS for services; MQ for mainframe transactions)
- KCM Data Standard DS-02 (customer and claim canonical models)
- OpenAPI 3.1 for service contracts; contract tests generated from the specification
- NZISM control baseline; PCI DSS v4.0 for the payment gateway scope
- KCM UI Standard for the CRM workflow screens; WCAG 2.1 AA for member-facing web forms
- Departure: the mainframe integration uses TLS 1.2 rather than the standard's TLS 1.3, by documented exception until the mainframe MQ upgrade

## Logical components

- Customer Information Service (CIS) — new; canonical customer, policy summary and contact data for all channels
- Claims Information Service (Claims InfoServ) — new; claim state, valuation, routing rules and audit trail
- Handle Claim workflow (CRM extension) — new; orchestrates Register, Accept, Valuate, Pay
- Take out insurance workflow (CRM extension and web form) — new; policy intake for telephone and web
- Policy Data Management service exposures (PDM-01 policy lookup, PDM-02 insured-item lookup, PDM-03 policy create, PDM-04 claim ledger update) — new; CICS transactions over MQ
- Mainframe integration layer (MQ bridge with TLS termination) — existing, extended
- CRM System — existing, extended
- Home & Away Policy Administration / Policy Data Management — existing, unchanged internally
- Home & Away Financial Application — existing, extended for gateway payments and daily posting
- Document management system — existing, extended with claim indexing; scanning archive migrated in and retired
- BIBIT payment gateway integration — new; claims payment and premium collection to the bank system
- Claims data mart extract — existing, extended with claim events
- Member web forms (claim, policy request) — new; on the existing member web platform
- Monitoring and alerting configuration — existing platform, new dashboards and alerts
