---
module: integration
status: agreed
owner: p.natarajan
---
# Integration

## Interfaces

| Interface | From → To | Protocol | Direction | What crosses |
| --- | --- | --- | --- | --- |
| CRM → CIS | CRM workflow → Customer Information Service | REST/JSON over mutual TLS | Bidirectional | Customer lookup and update, policy summary |
| CRM → Claims InfoServ | CRM workflow → Claims Information Service | REST/JSON over mutual TLS | Bidirectional | Claim create, state change, valuation, routing decision, audit event |
| Web forms → CIS / Claims InfoServ | Member web platform → services | REST/JSON over TLS through the API gateway | Bidirectional | Claim registration, policy request; member-scoped |
| CIS → PDM-01 / PDM-02 / PDM-03 | CIS → mainframe integration layer → CICS | MQ request/reply (JSON payload) | Bidirectional | Policy lookup, insured-item lookup, policy create |
| Claims InfoServ → PDM-04 | Claims InfoServ → mainframe integration layer → CICS | MQ request/reply | Unidirectional | Claim ledger update on accept, valuate and pay |
| Claims InfoServ → Financial Application | Claim payment request | REST/JSON over mutual TLS | Bidirectional | Payment request, payment reference and status |
| Financial Application → BIBIT gateway | Payment instruction | HTTPS (gateway API v4) with signed requests | Bidirectional | Member name, account, amount, reference; status callbacks |
| BIBIT gateway → Bank system | Settlement | Gateway-managed | Unidirectional | Payment to member account; premium collection from member account |
| CRM / Claims InfoServ → Document management | Document store and retrieve | REST over mutual TLS | Bidirectional | Claim-indexed documents and metadata |
| Claims InfoServ → Claims data mart | Nightly extract | SFTP file transfer | Unidirectional | Claim events since last extract |
| CRM → Correspondence (printing) service | Member letters and email | Existing internal API | Unidirectional | Templated correspondence |

## Network and infrastructure architecture

The solution runs in KCM's Wellington data centre with the secondary site in Auckland for recovery. Three network zones are involved: the DMZ (member web platform and API gateway), the application zone (UNIX server farm hosting the CRM, the Financial Application, CIS and Claims InfoServ; NAS file server; document management system) and the mainframe zone (Policy Data Management on the mainframe, reached only through the MQ integration layer). Firewalls separate the zones; the only path out of the application zone to the internet is the Financial Application's connection to the BIBIT payment gateway through the egress firewall.

### Deployment viewpoint

![Deployment viewpoint](asset:kcm-deployment-viewpoint)

The deployment viewpoint shows the payment path, which is the only new external path this design introduces. The Home & Away Financial Application runs as Financial Software on the UNIX server farm, attached to the LAN with the NAS file server for batch files. A firewall separates the LAN from the BIBIT gateway, and a second firewall on the gateway side separates it from the bank's LAN, where the BIBIT server realises the Bank System interface. The financial application and the bank system never connect directly; every instruction and status goes through the gateway.

Hosting and sites: production in Wellington (hall B), recovery in Auckland; non-production environments in Wellington hall A on the same server farm with separate network segments (see Support and Operations for the environment list).

## Software and licences

| Software | Contracted name | Version | Count | Licences per environment |
| --- | --- | --- | --- | --- |
| CRM System | Not yet verified | 12.3 with workflow extension pack | 1 production, 3 non-production | Existing enterprise licence covers the extension pack; 40 additional named handler seats |
| Financial Application | Home & Away Financials Enterprise (verified against the Finance Systems licence schedule) | 9.1 with payment gateway adapter | 1 production, 2 non-production | Adapter licensed per production instance; non-production included |
| CIS / Claims InfoServ | — (KCM-built) | Java 21 on the corporate runtime | 2 instances each in production, 1 each in non-production | No licence; open-source runtime |
| Document management system | Not yet verified | 7.4 | 1 production, 1 non-production | Additional 3 service-account API licences |
| MQ bridge (mainframe integration layer) | Not yet verified | MQ 9.3 | Existing | Existing capacity units; +2 for the new channels |
| Monitoring (Prometheus, Grafana, PagerDuty) | Not yet verified | Current platform versions | Existing | 6 additional PagerDuty seats for on-call |

## Hardware

No new physical hardware. Production: two additional virtual guests on the UNIX server farm (VMware, RHEL 9, 64-bit), 4 vCPU and 16 GB each, for CIS and Claims InfoServ (sized from capacity test CT-03), plus the standby database host already in the farm's PostgreSQL cluster. Non-production: one guest per environment for the services, 2 vCPU and 8 GB (UNIX server farm standard small guest). The document migration runs on a temporary 8 vCPU / 32 GB guest for its duration, then is released (target assumption). No core-based licensing applies to the KCM-built services; the CRM System and Financial Application guests are unchanged.

## Bandwidth

The new flows are small: a claim registration is about 20 KB of service traffic plus documents, median 2 MB and up to 25 MB (claims volumes report FY2025). At the design peak of 3,000 registrations a day with documents (target assumption), that is under 100 GB a day on the data-centre LAN, well within the 10 Gbps fabric (network capacity report, March 2026). The mainframe MQ channels carry about 4 KB per transaction at 4 a second peak (capacity test CT-03). The BIBIT gateway path carries under 1 MB a day (target assumption). Log shipping to Auckland adds about 15 GB a day on the 1 Gbps inter-site link, currently at 30 percent utilisation (network capacity report, March 2026). The document migration transfers about 450 GB once, throttled to overnight windows (scanning archive inventory).

## Network Devices

- Egress firewall (application zone → internet): new rule set for the Financial Application to the BIBIT gateway endpoints only
- Application-zone / mainframe-zone firewall: new rules for the MQ bridge channels
- Load balancer (UNIX server farm): new virtual servers for CIS and Claims InfoServ with HTTP/1.1 health checks
- API gateway in the DMZ: new routes for the member web forms; IPv6 supported on the public listener
- Internal DNS: new records for the two services and the document management API endpoint
- No changes to switches or routers

## Communication & Network Protocols

| Path | Protocol | From | To | Port | Direction | Environment(s) | Comments |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CRM System to shared services | HTTPS (TLS 1.3, mutual) | CRM guests | CIS, Claims InfoServ VIPs | 8443 | Bidirectional | All | New |
| Web forms to shared services | HTTPS (TLS 1.3) | API gateway (DMZ) | CIS, Claims InfoServ VIPs | 8443 | Bidirectional | All | New; member-scoped routes only |
| Shared services to mainframe | MQ over TLS 1.2 | CIS, Claims InfoServ | MQ bridge | 1414 | Bidirectional | All | New channels; TLS 1.2 by exception |
| MQ bridge to Policy Data Management | MQ | MQ bridge | Mainframe queue manager | 1414 | Bidirectional | All | Existing channel, additional queues |
| Claim payment request | HTTPS (TLS 1.3, mutual) | Claims InfoServ | Financial Application | 8443 | Bidirectional | All | New |
| Payment instruction | HTTPS (TLS 1.3, signed) | Financial Application | BIBIT gateway | 443 | Bidirectional | Production, UAT | New; egress firewall rule; UAT uses the gateway sandbox |
| Document store and retrieve | HTTPS (TLS 1.3, mutual) | CRM System, Claims InfoServ | Document management API | 8443 | Bidirectional | All | New |
| Nightly claims extract | SFTP | Claims InfoServ | Data mart landing server | 22 | Unidirectional | All | New nightly transfer |
| Services database replication | PostgreSQL streaming replication over TLS | Primary DB host | Auckland standby | 5432 | Unidirectional | Production | New for the services' database |

## SAN (Database, Application Server, Backup, DR)

| Storage use | Environment(s) | Tier | Size | Notes |
| --- | --- | --- | --- | --- |
| Services database (PostgreSQL) | Production | Tier 1 SSD | 400 GB on 2 volumes (target assumption) | Transaction-log shipping to Auckland; backups on tier 3, retained as Non-Functional Requirements sets |
| Application servers | Production | Tier 2 | 100 GB per guest (UNIX server farm standard guest) | Logs shipped to the monitoring platform |
| Document store | Production | Tier 2, then tier 3 for closed claims (records retention schedule) | 450 GB migration (scanning archive inventory) plus 90 GB a year (records volumes report FY2025) | Nightly snapshot, retained as Non-Functional Requirements sets |
| Standby database and restored services | Auckland (DR) | Tier 1 SSD | Mirror of production | Cold application guests, warm database |
| Databases and application servers | Non-production | Tier 3 | 100 GB per environment (target assumption) | Refreshed from masked production quarterly |
| Full and log backups | Production | Tier 3 / offsite object storage | About 2 TB rolling (target assumption) | Monthly backups kept for claims records as Non-Functional Requirements sets |
