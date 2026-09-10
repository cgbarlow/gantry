---
module: data-security-controls
status: agreed
owner: s.okafor
---
# Data Security Controls

## Controls

| Service / area | Concern | Controls |
| --- | --- | --- |
| Encryption in transit | Member data and payment instructions readable on the network | TLS 1.3 with mutual authentication between all KCM components; TLS 1.2 on the mainframe MQ channels by documented exception; signed requests to the payment gateway; internal CA-issued certificates rotated annually |
| Encryption at rest | Data readable from disk or backup | PostgreSQL volumes and backups encrypted (AES-256, keys in the enterprise key management service); document store encrypted by the document management system; backup media encrypted before leaving the site |
| Access management | Staff or services acting beyond their role | Active Directory groups mapped to CRM and Financial Application profiles; per-application service accounts for the shared services with mutual TLS; separation of valuation and payment approval enforced in Claims InfoServ; quarterly access reviews by the Claims Product Owner; privileged access to hosts and databases through the bastion with session recording |
| Application security | Injection, broken authorisation, dependency vulnerabilities | OpenAPI-validated inputs; member-scoped authorisation on every web route; dependency and container scanning in the Jenkins pipeline blocking on high severity; annual penetration test of the member web forms and the services; CRM extension code reviewed by two engineers |
| Networking | Lateral movement, unauthorised egress | Zone firewalls with explicit rules (Integration module); the only internet egress from the application zone is the Financial Application to the gateway endpoints; no inbound access to the services except through the API gateway and the CRM; developer access to repositories restricted to the Claims Platform Team |
| Incident management | Suspected data exposure or payment fraud | Security events forwarded to the security monitoring platform; Information Security paged in parallel with Technology Operations for any authentication anomaly or unexpected payment pattern; payment holds available to the Claims Payment Approver; incident runbook RB-SEC-CLM |
| Availability | Denial of service against member forms | Rate limiting and bot protection at the API gateway; services sized at five times peak; process fallback keeps claims flowing |
| Data handling | Sensitive claim details visible beyond need to know | Health and third-party information on a claim restricted to the handler roles assigned to it; every read of a member record logged; non-production data masked |
| Documentation | Controls drift over time | This register reviewed at each increment gate and at the annual C&A renewal; control owners named in the RACI |

## Inheritance and dependencies

The solution inherits the data-centre physical and environmental controls, the network zoning and firewall management, the enterprise identity provider and its multi-factor authentication, the key management service, the security monitoring platform and the backup infrastructure, all of which are accredited under KCM's existing C&A and are not re-assessed here. It depends on the mainframe's own security accreditation for Policy Data Management, on the CRM and Financial Application vendors' secure development practices under their support agreements, and on the BIBIT gateway's PCI DSS certification and its data-processing terms (payment data processed in Australia and New Zealand). Data locality: all member data other than payment instructions stays in KCM's Wellington and Auckland facilities. The regulations and standards the control set is held to are listed in the Security module.
