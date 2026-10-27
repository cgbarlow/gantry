---
module: dependencies
status: agreed
owner: p.natarajan
---
# Dependencies

## Dependencies

Increment 1 can't be tested end to end until Mainframe Integration exposes the first two Policy Data Management transactions, across two monthly change windows. Treasury must complete the BIBIT contract variation for real-time claims payment, and Records Management must confirm retention rules before the document migration is designed.

Downstream, the Contact Centre's desktop refresh and the Digital Channels website plan to consume the shared customer and policy services.

## Dependency list

- Policy Data Management — policy lookup and claim ledger update; Mainframe Integration
- CRM System — registration and handler workflow; Claims Platform Team
- Financial Application — payment and receipting records; Finance Systems
- BIBIT gateway and the bank payment API — claims payment and premium collection; Treasury
- Document management system — claim documents; Records Management
- MQ — transport for Policy Data Management calls; Mainframe Integration
- Claims data mart — reporting feed; Data & Analytics
- Enterprise and member identity providers — staff and member sign-in; Information Security, Digital Channels
- Jenkins and Ansible pipeline, and monitoring — Platform Engineering, Technology Operations
