---
module: data-security-controls
status: agreed
owner: s.okafor
---
# Data Security Controls

## Controls

| Service / area | Concern | Controls |
| --- | --- | --- |
| Encryption in transit | Data readable on the network | Mutual TLS 1.3 between KCM components; TLS 1.2 to the mainframe by documented exception; signed requests to the BIBIT gateway |
| Encryption at rest | Data readable from disk or backup | Database volumes, backups and the document store encrypted, with keys in the enterprise key management service |
| Access management | Staff or services acting beyond their role | Active Directory roles; a service account per application; valuation and payment approval separated in Claims InfoServ; quarterly access reviews; privileged access through a recorded bastion |
| Application security | Injection, broken authorisation, vulnerable dependencies | Validated inputs; member-scoped web routes; pipeline scanning that blocks on high severity; annual penetration test |
| Networking | Lateral movement, unauthorised egress | Zone firewalls; the only internet egress is the Financial Application to the BIBIT gateway |
| Incident management | Data exposure or payment fraud | Security events to Information Security; payment holds for the Claims Payment Approver; runbook RB-SEC-CLM |
| Data handling | Sensitive details beyond need to know | Health and third-party details restricted to assigned handlers; every read logged; non-production data masked |
| Documentation | Controls drifting | Register reviewed at each increment gate and annual C&A renewal |

## Inheritance and dependencies

The solution inherits the data centre's physical controls, network zoning, the enterprise identity provider, key management, security monitoring and backup infrastructure, all accredited under KCM's existing C&A. It depends on the mainframe's own accreditation, the vendors' secure development practices, and the BIBIT gateway's PCI DSS certification. All member data except payment instructions stays in KCM's Wellington and Auckland facilities.
