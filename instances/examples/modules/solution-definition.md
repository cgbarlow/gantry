---
module: solution-definition
status: agreed
owner: p.natarajan
---
# Solution Definition

## High-level requirements

| Section | Requirement |
| --- | --- |
| Claims registration | A member or contact-centre agent can register a claim once, against the member's existing policy, from the web or by telephone. |
| Claims registration | Registration validates the policy and insured item against Policy Data Management at the time of entry, so a claim cannot be registered against a lapsed policy or an item that is not covered. |
| Claims acceptance | A claims handler can accept or decline a registered claim in the CRM with the policy terms and the member's history visible without re-keying. |
| Claims valuation | A claims handler records the valuation (assessor report, quotes, excess) against the claim; complex claims are routed to a senior handler by configurable rules. |
| Claims payment | An approved claim is paid to the member's nominated bank account through the payment gateway within one working day, with the payment recorded in the Financial Application. |
| Documents | Every document received for a claim is stored in the document management system and visible from the claim in the CRM. |
| Customer information | A single customer information service provides the member's contact details, policies and claims to every channel and handler. |
| Policy intake | A member can request home or motor cover on the web or by telephone and have the policy bound without the request being re-keyed. |
| Premium collection | Premium payments are collected through the payment gateway and receipted in the Financial Application. |
| Reporting | Claim events (registered, accepted, valuated, paid, declined) are available in the claims data mart the next working day. |
| Audit | Every state change on a claim records who made it and when, and is retained for seven years. |
| Non-functional | Availability, performance, security and privacy targets as set out in the NFR and Security sections. |

## Process flow

The initiative changes two business processes: taking out insurance (policy intake) and handling a claim.

### Take out insurance

![Take out insurance process](asset:kcm-take-out-insurance-process)

A member requests insurance through the web or by telephone. Today the insurance seller re-keys that request into the policy system. In the target process the request is received once — in the CRM for telephone, directly from the web form for online — and the same Take out insurance process runs: receive the request, process it (validate the member and the risk against the shared services and the policy rules), and collect the premium through the payment gateway. Both channels are realised by the same process; only the interface differs.

### Handle claim

The claim process has four steps, each supported by an application service: Register (claim registration service), Accept (customer information and policy services), Valuate (claims information service) and Pay (claims payment service through the Financial Application and the payment gateway). The steps are described in detail in the Solution Architecture Document; at SOAP level the important change is that the four steps become one orchestrated process with shared data, rather than four applications with manual hand-offs.

## High level solution overview

![Claims handling introductory view](asset:kcm-claims-introductory-view)

The introductory view shows the shape of the solution. The member (the client) interacts with three business services — claim registration, customer information and claims payment — which are realised by the damage claiming process steps Register, Accept, Valuate and Pay. Those steps are supported by the CRM application, the Policy administration application (Policy Data Management, the inherited ArchiSurance platform) and the Financial application, running on the UNIX servers and the mainframe connected over the data-centre network.

What is new is the layer between the process steps and the applications: the customer information and claims information services that let each step read and write shared data instead of each application holding its own copy. The mainframe and the three applications stay; the manual hand-offs between them go.

## Feature breakdown and involved teams

| Feature / workstream | What it delivers | Teams involved |
| --- | --- | --- |
| Shared information services | Customer Information Service (CIS) and Claims Information Service (Claims InfoServ) in the UNIX server farm, with the Policy Data Management service exposures on the mainframe | Claims Platform Team, Mainframe Integration, Platform Engineering |
| Handle Claim orchestration | The Register, Accept, Valuate and Pay steps configured in the CRM workflow against the shared services; routing rules for complex claims | Claims Platform Team, Claims Operations |
| Documents | Document management system integration and migration of the scanning archive | Claims Platform Team, Records Management |
| Payments | BIBIT gateway integration with the Financial Application and the bank for claims payment and premium collection | Finance Systems, Claims Platform Team, Treasury |
| Policy intake | Web and telephone Take out insurance flow on the shared services | Digital Channels, Contact Centre, Claims Platform Team |
| Data and reporting | Claims data mart feed and audit trail | Data & Analytics, Internal Audit |
| Security and privacy | Threat model, control register, C&A | Information Security, Privacy Office |

## Alternatives sketch

- Do nothing: keep the four systems and the manual hand-offs; add handlers to meet the service target. Rejected at SOAP because the cost is recurring and the re-key error rate does not improve.
- Replace the CRM with a claims-management product that owns the whole process. Deferred: it would still need the same integration to Policy Data Management and the Financial Application, at higher licence cost and a longer timeline.
- Migrate Policy Data Management off the mainframe first, then integrate. Rejected for this initiative: it sequences the member benefit behind the hardest and least certain piece of work.
