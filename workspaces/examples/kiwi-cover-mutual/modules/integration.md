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

| Software | Version | Count | Licences per environment |
| --- | --- | --- | --- |
| CRM System (vendor) | 12.3 with workflow extension pack | 1 production, 3 non-production | Existing enterprise licence covers the extension pack; 40 additional named handler seats |
| Home & Away Financial Application | 9.1 with payment gateway adapter | 1 production, 2 non-production | Adapter licensed per production instance; non-production included |
| Customer Information Service / Claims Information Service | KCM-built, Java 21 on the corporate runtime | 2 instances each in production, 1 each in non-production | No licence; open-source runtime |
| Document management system | 7.4 | 1 production, 1 non-production | Additional 3 service-account API licences |
| Mainframe integration layer (MQ bridge) | MQ 9.3 | Existing | Existing capacity units; +2 for the new channels |
| Monitoring (Prometheus, Grafana, PagerDuty) | Current platform versions | Existing | 6 additional PagerDuty seats for on-call |

## Hardware

No new physical hardware. Production: two additional virtual guests on the UNIX server farm (VMware, RHEL 9, 64-bit), 4 vCPU and 16 GB each, for CIS and Claims InfoServ, plus the standby database host already in the farm's PostgreSQL cluster. Non-production: one guest per environment for the services, 2 vCPU and 8 GB. The document migration runs on a temporary 8 vCPU / 32 GB guest for its duration, then is released. No core-based licensing applies to the KCM-built services; the CRM and Financial Application guests are unchanged.

## Bandwidth

The new flows are small: a claim registration is about 20 KB of service traffic plus documents (median 2 MB, up to 25 MB). At the design peak of 3,000 registrations a day with documents, that is under 100 GB a day on the data-centre LAN, well within the 10 Gbps fabric. The mainframe MQ channels carry about 4 KB per transaction at 4 a second peak. The BIBIT gateway path carries under 1 MB a day. Log shipping to Auckland adds about 15 GB a day on the inter-site link (1 Gbps), currently at 30 percent utilisation. The document migration transfers about 450 GB once, throttled to overnight windows.

## Network Devices

- Egress firewall (application zone → internet): new rule set for the Financial Application to the BIBIT gateway endpoints only
- Application-zone / mainframe-zone firewall: new rules for the MQ bridge channels
- Load balancer (UNIX server farm): new virtual servers for CIS and Claims InfoServ with HTTP/1.1 health checks
- API gateway in the DMZ: new routes for the member web forms; IPv6 supported on the public listener
- Internal DNS: new records for the two services and the document management API endpoint
- No changes to switches or routers

## Communication & Network Protocols

| Environment | Protocol | From | To | Port | Direction | Comments |
| --- | --- | --- | --- | --- | --- | --- |
| All | HTTPS (TLS 1.3, mutual) | CRM guests | CIS, Claims InfoServ VIPs | 8443 | Bidirectional | New |
| All | HTTPS (TLS 1.3) | API gateway (DMZ) | CIS, Claims InfoServ VIPs | 8443 | Bidirectional | New; member-scoped routes only |
| All | MQ over TLS 1.2 | CIS, Claims InfoServ | MQ bridge | 1414 | Bidirectional | New channels; TLS 1.2 by exception |
| All | MQ | MQ bridge | Mainframe queue manager | 1414 | Bidirectional | Existing channel, additional queues |
| All | HTTPS (TLS 1.3, mutual) | Claims InfoServ | Financial Application | 8443 | Bidirectional | New |
| Production, UAT | HTTPS (TLS 1.3, signed) | Financial Application | BIBIT gateway | 443 | Bidirectional | New; egress firewall rule; UAT uses the gateway sandbox |
| All | HTTPS (TLS 1.3, mutual) | CRM, Claims InfoServ | Document management API | 8443 | Bidirectional | New |
| All | SFTP | Claims InfoServ | Data mart landing server | 22 | Unidirectional | New nightly transfer |
| Production | PostgreSQL streaming replication over TLS | Primary DB host | Auckland standby | 5432 | Unidirectional | New for the services' database |

## SAN (Database, Application Server, Backup, DR)

| Environment | Use | Tier | Size | Notes |
| --- | --- | --- | --- | --- |
| Production | Services database (PostgreSQL) | Tier 1 SSD | 400 GB, 2 volumes | Transaction-log shipping to Auckland; 35-day backups on tier 3 |
| Production | Application servers | Tier 2 | 100 GB per guest | Logs shipped to the monitoring platform |
| Production | Document store growth | Tier 2 / tier 3 after 12 months | 450 GB migration + 90 GB a year | Nightly snapshot, 90-day retention |
| Auckland (DR) | Standby database and restored services | Tier 1 SSD | Mirror of production | Cold application guests, warm database |
| Non-production | Databases and application servers | Tier 3 | 100 GB per environment | Refreshed from masked production quarterly |
| Backup | Full and log backups | Tier 3 / offsite object storage | About 2 TB rolling | Monthly retained 7 years for claims records |
