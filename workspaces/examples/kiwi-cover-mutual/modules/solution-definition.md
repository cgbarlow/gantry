---
module: solution-definition
status: agreed
owner: p.natarajan
---
# Solution Definition

## High-level requirements

| Section | Requirement |
| --- | --- |
| Claims registration | A member or agent registers a claim once, on the web or by telephone, validated against the policy and insured item in Policy Data Management. |
| Claims acceptance | A handler accepts or declines a claim in the CRM System with the policy terms and member history visible. |
| Claims valuation | A handler records the valuation against the claim; rules route complex claims to a senior handler. |
| Claims payment | An approved claim is paid to the member's bank account through the BIBIT gateway within one working day and recorded in the Financial Application. |
| Documents | Every claim document is stored in the document management system and visible from the claim. |
| Policy intake | A member requests cover on the web or by telephone and the policy is bound without re-keying. |
| Reporting and audit | Claim events reach the claims data mart the next working day; every state change records who made it and when. |

## Process flow

The initiative changes two business processes: taking out insurance and handling a claim.

### Take out insurance

The following diagram presents the target Take out insurance process.

![Take out insurance process](asset:kcm-take-out-insurance-process)

The diagram shows how a request from either channel is captured once, then processed and paid for through the same steps.

### Handle claim

Register, Accept, Valuate and Pay become one orchestrated process on shared data instead of four applications with manual hand-offs.

## High level solution overview

The following diagram presents the claims handling introductory view.

![Claims handling introductory view](asset:kcm-claims-introductory-view)

The diagram shows how the member's three business services are realised by the Register, Accept, Valuate and Pay steps, supported by the CRM System, Policy Data Management and the Financial Application. What is new is the layer between steps and applications: CIS and Claims InfoServ, which let each step share data rather than re-key it.

## Feature breakdown and involved teams

| Feature / workstream | What it delivers | Teams involved |
| --- | --- | --- |
| Shared services | CIS, Claims InfoServ and the Policy Data Management service exposures | Claims Platform Team, Mainframe Integration |
| Handle Claim | The four steps in the CRM System workflow, with routing rules | Claims Platform Team, Claims Operations |
| Documents and payments | Document management system integration; BIBIT gateway integration | Claims Platform Team, Finance Systems |
| Policy intake | Web and telephone intake on the shared services | Digital Channels, Contact Centre |
| Security and data | Control register, C&A, data mart feed | Information Security, Data & Analytics |

## Alternatives sketch

- Do nothing and add handlers. Rejected: recurring cost, and re-keying errors stay.
- Replace the CRM System with a claims product. Deferred: same integration, higher cost.
- Move Policy Data Management off the mainframe first. Rejected: puts the member benefit behind the hardest work.
