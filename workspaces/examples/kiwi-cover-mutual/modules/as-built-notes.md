---
module: as-built-notes
status: agreed
owner: m.walker
---
# As-Built Notes

## Design overview

Built as designed: CIS and Claims InfoServ run as active-active pairs on the UNIX server farm, the CRM System's workflow orchestrates the four Handle Claim steps, Policy Data Management sits behind PDM-01 to PDM-04, the Financial Application instructs the BIBIT gateway, and documents are claim-indexed in the document management system.

The following diagram presents the application usage viewpoint as built.

![Application usage viewpoint](asset:kcm-application-usage-viewpoint)

The diagram shows how each step uses its services as designed, with one addition: Register also reserves the claim number up front, so a document can be indexed before acceptance.

## Architecture decisions

| AD | Decision | ADR |
|----------|----------------------------------------------------------------------|------------|
| AD01 | **Shared services** — as designed. | ADR031 |
| AD02 | **Policy Data Management exposed as services** — PDM-01 to PDM-04 live in the April and May windows. | ADR032 |
| AD03 | **CRM System orchestrates, Claims InfoServ owns state** — nightly checks find no drift. | |
| AD04 | **Payments via the Financial Application** — the BIBIT gateway now calls back rather than being polled. | |
| AD05 | **Claim-indexed documents** — migration completed with a clean reconciliation. | |
| AD06 | **Switchable increments** — fallbacks exercised quarterly. | |
| AD07 | **No new platform** — held. | |
| AD08 | **New during the build: policy-lookup cache cut to 5 minutes**, after UAT showed claims accepted against a just-changed policy. | |

## Data migration and process flows

### Handle Claim as built

Register: the workflow reserves a claim number in Claims InfoServ, reads the customer and policy from CIS, stores any document under that number and creates the claim, writing an audit event. Accept: the handler reviews the policy in the CRM System; Claims InfoServ records the decision and posts the ledger entry through PDM-04. Valuate: routing rules send complex claims to a senior queue. Pay: a Claims Payment Approver, never the valuing handler, releases payment; the Financial Application instructs the BIBIT gateway and its callback marks the claim paid.

### Take out insurance as built

A web or telephone request creates an insurance request in CIS and, once the premium is collected, a policy through PDM-03. As built, members log in before quoting (see Changes).

### Document migration as built

A disposal pass removed documents past retention first. Migration then ran nightly in claim-ordered batches with per-batch reconciliation, finishing on 21 August 2026 with no unmatched documents.

## Infrastructure and configuration

### Wellington production

- CIS: `wlg-cis-01`, `wlg-cis-02` behind VIP `cis.svc.kcm.internal`, RHEL 9.4, Java 21
- Claims InfoServ: `wlg-clm-01`, `wlg-clm-02` behind VIP `claims.svc.kcm.internal`
- Database: PostgreSQL 16.3, `wlg-clmdb-01` (primary) and `wlg-clmdb-02` (standby); database `claims_platform`
- MQ bridge: channels `KCM.CIS.SVRCONN` and `KCM.CLM.SVRCONN` to `QMPROD1`, TLS 1.2
- Firewall rules: `FW-APP-MF-021`, `FW-APP-EGRESS-034`, `FW-DMZ-APP-055` (see Appendix)
- Data mart: SFTP to `dm-landing.kcm.internal` nightly at 02:30
- Monitoring: Grafana folder "Claims Platform"; PagerDuty service "Claims Platform (prod)"

### Auckland recovery site

- Standby database `akl-clmdb-01`; Ansible inventory `inventory/akl-recovery.yml` rebuilds the services on demand

### Roles and permissions

Active Directory groups `KCM-Claims-Handler`, `KCM-Claims-Senior`, `KCM-Claims-PayApprover`, `KCM-ContactCentre-Agent`, `KCM-Finance-Operator`, `KCM-Claims-SupportAdmin` and `KCM-Audit-ReadOnly`, mapped to CRM System profiles and Claims InfoServ authority limits. Host access is through `bastion.kcm.internal`.

## Appendix

### Firewall rule detail

| Rule | Source | Destination | Port |
| --- | --- | --- | --- |
| FW-APP-MF-021 | Service guests | MQ bridge | 1414/tcp |
| FW-APP-EGRESS-034 | Financial Application guests | api.bibit.com | 443/tcp |
| FW-DMZ-APP-055 | API gateway | Service VIPs | 8443/tcp |

### Test use case: site failover, 12 August 2026

Hall B isolated at 19:02; Auckland database promoted 19:14; services healthy 20:26; first claim registered 20:38. Within the RTO.

### Security risk assessment register

KCM-SRA-2026-014, all controls closed or accepted; C&A certificate issued 27 August 2026.

## Changes from the agreed design

- BIBIT gateway status arrives by callback, not polling, through an inbound listener behind the DMZ reverse proxy. Approved by the Design Authority as a minor change.
- Members log in before quoting, at the Privacy Office's request.
- The CIS policy-lookup cache is 5 minutes (AD08).
- Register reserves the claim number before storing documents.

## Acceptance criteria

- Registration is validated against Policy Data Management and rejects a lapsed policy or uncovered item. Increment 1 suite passed.
- Each step records actor and time; the valuing handler can't release the payment. Confirmed by Internal Audit.
- Approved claims reach the member's account within one working day; 96.8 percent did in the first four weeks.
- Registration met its NFR at five times peak in the 28 July 2026 performance test.
- Site failover met the RTO and RPO on 12 August 2026.
- Member web forms passed the WCAG 2.1 AA audit.

## Operational notes

- PDM-02 may not find an insured item added the same day until the 23:00 mainframe batch; handlers use the audited "item pending" override.
- The BIBIT gateway sandbox resets UAT credentials monthly; update the UAT adapter on the first working day.
- The document management API throttles under bulk load; the upload path keeps the migration's back-off.
- The Handle Claim funnel dashboard counts by state-change hour; use the data mart for cohorts.

## Handover confirmation

Technology Operations accepted handover of increments 1 to 3 on 8 September 2026 (Mereana Walker), after a warranty period with no open P1 or P2 defects, C&A sign-off and the recovery test. Hana Te Rangi confirmed business acceptance. The Claims Platform Team keeps this record current.
