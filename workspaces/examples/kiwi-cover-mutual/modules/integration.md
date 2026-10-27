---
module: integration
status: agreed
owner: p.natarajan
---
# Integration

## Interfaces

| Interface | From → To | Protocol | What crosses | Status |
| --- | --- | --- | --- | --- |
| CRM System → CIS | CRM workflow → CIS | REST over mutual TLS | Customer lookup and update | in delivery |
| CRM System → Claims InfoServ | CRM workflow → Claims InfoServ | REST over mutual TLS | Claim state, valuation, audit events | in delivery |
| Web forms → shared services | API gateway → CIS, Claims InfoServ | REST over TLS | Member-scoped claims and requests | planned |
| Shared services → PDM-01 to PDM-04 | CIS, Claims InfoServ → MQ bridge → CICS | MQ request/reply | Policy lookup and create; claim ledger update | in delivery |
| Claims InfoServ → Financial Application | Payment request | REST over mutual TLS | Payment request and status | planned |
| Financial Application → BIBIT gateway | Payment instruction | Signed HTTPS | Name, account, amount, reference | planned |
| Shared services → document management system | Store and retrieve | REST over mutual TLS | Claim-indexed documents | in delivery |
| CRM System → correspondence service | Member letters | Existing internal API | Templated correspondence | existing |

## Network and infrastructure architecture

The solution runs in KCM's Wellington data centre, recovering to Auckland. Firewalls separate three zones: the DMZ (web platform and API gateway), the application zone (the UNIX server farm hosting the CRM System, the Financial Application, CIS and Claims InfoServ) and the mainframe zone, reached only through the MQ bridge.

The following diagram presents the deployment viewpoint for the payment path, the only new external path.

![Deployment viewpoint](asset:kcm-deployment-viewpoint)

The diagram shows how the Financial Application on the UNIX server farm reaches the bank only through the BIBIT gateway, with a firewall on each side. The Financial Application and the bank never connect directly.

## Software and licences

| Software | Contracted name | Version | Count |
| --- | --- | --- | --- |
| CRM System | Not yet verified | 12.3 with workflow extension pack | 1 production, 3 non-production |
| Financial Application | Home & Away Financials Enterprise (verified against the Finance Systems licence schedule) | 9.1 with gateway adapter | 1 production, 2 non-production |
| CIS and Claims InfoServ | — (KCM-built) | Java 21 | 2 production instances each |
| Document management system | Not yet verified | 7.4 | 3 more service-account API licences |
| MQ bridge | Not yet verified | MQ 9.3 | Existing, plus 2 capacity units |

## Hardware

No new physical hardware. Production adds two virtual guests on the UNIX server farm for CIS and Claims InfoServ, 4 vCPU and 16 GB each (capacity test CT-03). Non-production adds one guest per environment, 2 vCPU and 8 GB (UNIX server farm standard small guest).

## Bandwidth

A claim registration is about 20 KB of service traffic plus documents, median 2 MB (claims volumes report FY2025). At the design peak of 3,000 registrations a day (target assumption) that is under 100 GB a day, well within the 10 Gbps LAN (network capacity report, March 2026). Log shipping to Auckland adds about 15 GB a day (target assumption).

## Network Devices

- Egress firewall: the Financial Application to the BIBIT gateway only
- Application-to-mainframe firewall: the new MQ bridge channels
- Load balancer: virtual servers for CIS and Claims InfoServ
- API gateway: routes for the member web forms
- Internal DNS: records for the two services

## Communication & Network Protocols

| Path | Protocol | From | To | Port | Direction | Environment(s) | Comments |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CRM System to shared services | HTTPS (mutual TLS 1.3) | CRM guests | CIS, Claims InfoServ | 8443 | Bidirectional | All | New |
| Web forms to shared services | HTTPS (TLS 1.3) | API gateway | CIS, Claims InfoServ | 8443 | Bidirectional | All | Member routes |
| Shared services to mainframe | MQ over TLS 1.2 | CIS, Claims InfoServ | MQ bridge | 1414 | Bidirectional | All | By exception |
| Claim payment request | HTTPS (mutual TLS 1.3) | Claims InfoServ | Financial Application | 8443 | Bidirectional | All | New |
| Payment instruction | HTTPS (signed) | Financial Application | BIBIT gateway | 443 | Bidirectional | Production, UAT | Sandbox in UAT |
| Nightly claims extract | SFTP | Claims InfoServ | Data mart | 22 | Unidirectional | All | New |
| Database replication | PostgreSQL | Primary DB | Auckland standby | 5432 | Unidirectional | Production | New |

## SAN (Database, Application Server, Backup, DR)

| Storage use | Environment(s) | Tier | Size |
| --- | --- | --- | --- |
| Services database | Production | Tier 1 SSD | 400 GB (target assumption) |
| Application servers | Production | Tier 2 | 100 GB per guest (UNIX server farm standard guest) |
| Document store | Production | Tier 2, closed claims to tier 3 | 450 GB migrated (scanning archive inventory) plus 90 GB a year (records volumes report FY2025) |
| Standby database | Auckland (DR) | Tier 1 SSD | Mirror of production |
| Backups | Production | Tier 3 | About 2 TB rolling (target assumption) |
