---
module: as-built-notes
status: agreed
owner: m.walker
---
# As-Built Notes

## Design overview

The solution was built as designed: the Customer Information Service and the Claims Information Service run in the Wellington UNIX server farm as active-active pairs; the CRM System's workflow extension orchestrates Register, Accept, Valuate and Pay against them; Policy Data Management stays on the mainframe behind the four PDM exposures over the MQ bridge; the Home & Away Financial Application records every claims payment and instructs the BIBIT gateway; and claim documents are claim-indexed in the document management system with the scanning archive migrated and read-only. The layered view in the Solution Architecture Document remains an accurate picture of what runs today, with one change to the deployment described under Changes from the agreed design.

### As-built application usage

![Application usage viewpoint](asset:kcm-application-usage-viewpoint)

As built, the Register step uses the document (scanning) service and the customer administration service exactly as the design's application usage viewpoint shows, with one addition: Register also calls the claims administration service to reserve the claim number up front, so a document can be indexed before the claim is accepted. The other three steps use the services as designed.

## Architecture decisions

- Decision 1 (shared services) — implemented as designed; CIS and Claims InfoServ are the only consumers of the PDM exposures in production.
- Decision 2 (Policy Data Management retained, exposed as services) — implemented; PDM-01 to PDM-04 went live in the April and May 2026 windows as planned.
- Decision 3 (CRM orchestrates, Claims InfoServ owns state) — implemented; the acceptance suite's state-agreement checks run nightly and have found no drift.
- Decision 4 (payments via the Financial Application then the gateway) — implemented; changed in one respect: the gateway callback is received by the Financial Application's adapter rather than polled, after the vendor delivered callback support in adapter 9.1.2.
- Decision 5 (claim-indexed documents) — implemented; the archive migration completed on 21 August 2026 with a clean reconciliation.
- Decision 6 (switchable increments) — implemented; the manual fallback for each step is exercised in the quarterly test.
- Decision 7 (no new platform) — held; one temporary migration guest was used and released.
- New: the 15-minute policy-lookup cache in CIS was reduced to 5 minutes after UAT showed handlers accepting claims against a policy changed in the same quarter-hour.

## Data migration and process flows

### Handle Claim as built

A claim enters through the member web form or the CRM (telephone). Register: the workflow calls Claims InfoServ to reserve a claim number, CIS for the customer and policy summary (PDM-01 and PDM-02 behind it), stores any uploaded document in the document management system indexed by the reserved number, and creates the claim in Claims InfoServ, which writes the audit event. Accept: the handler reviews the policy terms and history in the CRM; on accept, Claims InfoServ records the state and posts the ledger entry to Policy Data Management through PDM-04; on decline, correspondence is generated and the claim closes. Valuate: the handler records the valuation; routing rules in Claims InfoServ send motor total-loss, contents over $25,000 and all liability claims to a senior handler queue; the valuation is written with the actor. Pay: a Claims Payment Approver (never the valuating handler) releases the payment; Claims InfoServ requests payment from the Financial Application, which posts the ledger entry and instructs the BIBIT gateway; the gateway callback updates the Financial Application and Claims InfoServ marks the claim paid. Every state change produces an audit event and, nightly, a data mart extract row.

### Take out insurance as built

A web request creates an insurance request in CIS and, on premium collection through the gateway, a policy in Policy Data Management through PDM-03; a telephone request is captured by the seller in the CRM against the same services. As built, the web flow requires the member to be logged in to the member identity service before quoting, a change from the design's quote-then-login order (see Changes).

### Document migration as built

The disposal pass removed 141,000 pages belonging to 34,200 claims past retention. Migration ran nightly from 3 June to 21 August 2026 in claim-ordered batches of 5,000 claims, with per-batch reconciliation of page counts and claim keys; 12 batches were re-run for transient document-management API timeouts. Final reconciliation: 968,400 pages across 226,100 claims migrated, zero unmatched.

## Infrastructure and configuration

### Wellington production (hall B)

- CIS: guests `wlg-cis-01` (10.42.8.11) and `wlg-cis-02` (10.42.8.12), RHEL 9.4, 4 vCPU / 16 GB, service on 8443 behind VIP `cis.svc.kcm.internal` (10.42.8.10); Java 21.0.4 on the corporate runtime image 2026.06
- Claims InfoServ: `wlg-clm-01` (10.42.8.21), `wlg-clm-02` (10.42.8.22), same build, VIP `claims.svc.kcm.internal` (10.42.8.20)
- Services database: PostgreSQL 16.3 cluster `wlg-clmdb-01` (primary, 10.42.9.11) and `wlg-clmdb-02` (synchronous standby, 10.42.9.12), 400 GB tier-1; database `claims_platform`, roles `cis_app`, `claims_app`, `claims_ro` (reporting), `claims_dba`
- MQ bridge: channels `KCM.CIS.SVRCONN` and `KCM.CLM.SVRCONN` to queue manager `QMPROD1`, TLS 1.2 with cipher `TLS_RSA_WITH_AES_256_CBC_SHA256`; queues `PDM.01.REQ/RESP` to `PDM.04.REQ/RESP`
- Load balancer virtual servers `vs-cis-8443`, `vs-claims-8443`, HTTP/1.1 health check on `/health` every 10 s
- Firewall rules: `FW-APP-MF-021` (services → MQ bridge 1414), `FW-APP-EGRESS-034` (Financial Application guests → `api.bibit.com` 443 and `callback.bibit.com` inbound to the adapter listener 8444 via the DMZ reverse proxy), `FW-DMZ-APP-055` (API gateway → service VIPs 8443)
- API gateway routes: `/claims/*` and `/quote/*` on `www.kiwicover.co.nz` to the member web platform; `/api/member/claims/*` and `/api/member/requests/*` to Claims InfoServ and CIS with member-scope enforcement
- Document management API: `docs.kcm.internal:8443`, service accounts `svc-crm-docs`, `svc-claims-docs`, `svc-migration-docs` (disabled after migration)
- Data mart landing: SFTP `dm-landing.kcm.internal`, account `svc-claims-extract`, nightly at 02:30, file `claim_events_YYYYMMDD.csv`
- Monitoring: Prometheus scrape of `/metrics` on both services; Grafana folder "Claims Platform"; PagerDuty service "Claims Platform (prod)"

### Auckland recovery site

- Standby database `akl-clmdb-01` (10.52.9.11) streaming from the Wellington primary; measured replication lag under 30 s
- Ansible inventory `inventory/akl-recovery.yml` builds `akl-cis-01/02` and `akl-clm-01/02` on demand; last full rebuild test 12 August 2026, 84 minutes to service

### Non-production

- UAT: `uat-cis-01`, `uat-clm-01`, `uat-clmdb-01`; BIBIT sandbox merchant `KCM-UAT`; Policy Data Management test LPAR `QMUAT1`
- SIT: `sit-cis-01`, `sit-clm-01`, `sit-clmdb-01`; gateway stub; test LPAR
- Development namespaces on the shared dev cluster with stubbed mainframe and gateway

### Roles and permissions

Active Directory groups `KCM-Claims-Handler`, `KCM-Claims-Senior`, `KCM-Claims-PayApprover`, `KCM-ContactCentre-Agent`, `KCM-Finance-Operator`, `KCM-Claims-SupportAdmin`, `KCM-Audit-ReadOnly` mapped to CRM profiles of the same name and to Claims InfoServ authority limits (Handler $25,000; Senior unlimited). Host access through bastion `bastion.kcm.internal` with group `KCM-Ops-ClaimsPlatform`.

## Appendix

### Firewall rule detail

| Rule | Source | Destination | Port | Notes |
| --- | --- | --- | --- | --- |
| FW-APP-MF-021 | 10.42.8.0/24 | 10.42.30.5 (MQ bridge) | 1414/tcp | TLS 1.2 |
| FW-APP-EGRESS-034 | 10.42.7.31, 10.42.7.32 (Financial Application) | api.bibit.com | 443/tcp | Egress; FQDN object refreshed hourly |
| FW-DMZ-APP-055 | 10.42.1.20 (API gateway) | 10.42.8.10, 10.42.8.20 | 8443/tcp | Member routes only |
| FW-APP-DOCS-056 | 10.42.8.0/24, 10.42.7.0/24 | 10.42.11.8 (document management) | 8443/tcp | |
| FW-APP-DM-057 | 10.42.8.21, 10.42.8.22 | 10.42.12.4 (data mart landing) | 22/tcp | Nightly window only |

### Test use case: site failover, 12 August 2026

Wellington hall B isolated at 19:02; Auckland database promoted 19:14; services deployed and healthy 20:26; DNS cut over 20:31; first claim registered on the recovered environment 20:38; hall B restored and replication re-established 22:10. Within the 4-hour RTO; RPO measured at 25 s.

### Security risk assessment register

The SRA register (KCM-SRA-2026-014, 31 controls, all closed or accepted) is held in the Information Security repository; the C&A certificate was issued on 27 August 2026 and is valid to 27 August 2027.

## Changes from the agreed design

- Gateway status is received by callback rather than polled (adapter 9.1.2 delivered callback support during increment 3); an inbound listener on the adapter, reached through the DMZ reverse proxy, was added with rule FW-APP-EGRESS-034's inbound counterpart. Approved by the Design Authority as a minor change on 4 August 2026.
- The web policy-intake flow requires member login before quoting rather than after, at the Privacy Office's request, so no quote data is held for an unidentified visitor.
- The CIS policy-lookup cache is 5 minutes, not 15 (see Architecture decisions).
- The Register step reserves the claim number before documents are stored (see Design overview).
- No other deviations; the Policy Data Management exposures, the routing rules, the payment separation of duties and the data model are as designed.

## Acceptance criteria

- A claim registered on the web or in the CRM is validated against Policy Data Management at the time of entry; registration against a lapsed policy or an uncovered item is rejected with a clear message. Verified by the increment 1 acceptance suite (42 cases, all passed).
- Accept, Valuate and Pay each record the actor and timestamp in Claims InfoServ; the valuating handler cannot release payment on the same claim. Verified by the separation-of-duties tests and Internal Audit's review of 8 September 2026.
- An approved claim's payment instruction reaches the gateway within 5 seconds and the member's account within one working day; measured at 96.8 percent within one day over the first four weeks.
- Every document received for a claim is retrievable from the claim in the CRM within 2 seconds for documents under 10 MB. Verified.
- Registration completes within 3 seconds at the 95th percentile at five times daily peak. Performance test of 28 July 2026: 2.4 seconds at the 95th percentile, 4.1 at the 99th.
- Site failover within 4 hours with data loss under 15 minutes. Verified 12 August 2026.
- Claim events appear in the data mart the next working day. Verified for 20 consecutive days.
- WCAG 2.1 AA for the member web forms. Verified by the accessibility audit of 30 July 2026, two minor findings closed.

## Operational notes

- The MQ bridge occasionally reports a `2033 MQRC_NO_MSG_AVAILABLE` on PDM-02 for insured items added the same day; the mainframe batch that indexes new items runs at 23:00, so a same-day item may not be found until the next morning. Handlers use the "item pending" override; the override is audited.
- The BIBIT sandbox in UAT resets credentials monthly; the UAT adapter configuration must be updated on the first working day of each month or payment tests fail.
- The document management API returns HTTP 429 under bulk load; the migration job's back-off is retained in the CRM document upload path in case of a large event-driven surge.
- Grafana's "Handle Claim funnel" dashboard counts claims by the hour they changed state, not the hour they were registered; use the data mart for cohort analysis.
- The legacy `claims.archisurance.co.nz` redirect depends on a certificate that expires in March 2027; Digital Channels owns its renewal or retirement.

## Handover confirmation

Handover of the Claims Handling Modernisation solution (increments 1 to 3) to Technology Operations was accepted by Mereana Walker, Platform Engineering Lead, on 8 September 2026, following the four-week warranty period ending 5 September 2026 with no open P1 or P2 defects, the completed C&A sign-off of 27 August 2026, and the recovery test of 12 August 2026. Business acceptance was confirmed by Hana Te Rangi, Head of Claims, on the same date. Handover of this document does not transfer responsibility for keeping it current: the Claims Platform Team remains responsible for updating the as-built record with each change, and Technology Operations for the runbooks.
