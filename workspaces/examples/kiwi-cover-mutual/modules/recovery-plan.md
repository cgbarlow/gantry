---
module: recovery-plan
status: agreed
owner: m.walker
---
# Recovery Plan

## Recovery approach

The recovery targets (4-hour RTO and 15-minute RPO for the shared services and CRM workflow; 24 hours for documents) are set in the NFRs; this section describes how the solution meets them.

### Platform

The UNIX server farm in Wellington runs the shared services as an active-active pair behind the load balancer; the services' PostgreSQL database runs as a primary in Wellington with a warm standby in Auckland fed by streaming replication. The mainframe and the Financial Application keep their existing recovery arrangements (8-hour RTO, Auckland standby LPAR and cold guests). Redeployment on failover is by the same Ansible playbooks used for release, run against the Auckland inventory, so the recovered environment is built from the same definition as production.

### Workloads

- Shared services (CIS, Claims InfoServ): active-active within Wellington; on loss of the Wellington hall, the Auckland standby database is promoted and the service guests are deployed from the playbooks (about 90 minutes end to end in the last test).
- CRM workflow: the CRM's own DR arrangement (vendor-supported active-passive to Auckland); the workflow extension is part of the CRM deployment package.
- Document management: nightly snapshot restored in Auckland; documents added since the snapshot are re-uploaded from the CRM's pending queue.
- Payment path: the Financial Application's DR instance in Auckland re-registers with the BIBIT gateway; in-flight payment instructions are reconciled from the gateway's status API before any are re-sent.
- Process fallback: independently of platform recovery, each Handle Claim step can be switched to its manual fallback by configuration, so claims can still be registered and accepted while a service is being recovered.

## Resiliency

Within Wellington, every new component is redundant: two service instances per service across two hosts, a two-node PostgreSQL cluster with synchronous replication for the local standby, dual load-balancer units, and dual MQ bridge channels to the mainframe. The application zone has two independent network paths to the mainframe zone and two egress firewalls in active-passive for the gateway path. The 15-minute cache of policy lookups in CIS keeps registration working through a short mainframe outage. Auckland provides site resiliency for the database (asynchronous) and the capability to rebuild the services; it is not active-active across sites because the mainframe is not.

## Test scenarios

| Scenario | Failover type | Frequency | Runbook |
| --- | --- | --- | --- |
| Loss of one service instance | Automatic (load balancer) | Continuous via chaos test in UAT, monthly in production off-peak | RB-CLM-01 |
| Loss of the primary database host | Automatic promotion of the local synchronous standby | Quarterly | RB-CLM-02 |
| Loss of the Wellington hall | Manual: promote Auckland standby, deploy services, redirect DNS | Annually, and before increment 3 go-live | RB-CLM-03 |
| Mainframe MQ path unavailable | Cache serves lookups; process fallback for writes after 15 minutes | Quarterly (simulated) | RB-CLM-04 |
| Payment gateway unavailable | Payment requests queue in the Financial Application; batch payment file fallback after 4 hours | Semi-annually with Treasury | RB-CLM-05 |
| Document management unavailable | Documents queue in the CRM pending store; replay on recovery | Quarterly | RB-CLM-06 |

Runbooks are held in the Technology Operations knowledge base under Claims Platform.

## RACI

| Task | Responsible | Accountable | Consulted | Informed |
| --- | --- | --- | --- | --- |
| Declare a disaster and invoke site failover | Technology Operations on-call | Platform Engineering Lead (M. Walker) | Claims Platform Team, Mainframe Integration | Head of Claims, Product Owner |
| Promote the Auckland database and deploy services | Technology Operations | Platform Engineering Lead | Claims Platform Team | Service Desk |
| Switch a process step to manual fallback | Claims Support Administrator | Claims Product Owner (T. Whitaker) | Technology Operations | Claims handlers, Service Desk |
| Reconcile in-flight payments after failover | Finance Systems | Finance Systems Manager (L. O'Connor) | Treasury, Technology Operations | Head of Claims |
| Replay queued documents | Technology Operations | Platform Engineering Lead | Records Management | Claims Product Owner |
| Run and report recovery tests | Technology Operations | Platform Engineering Lead | Claims Platform Team, Information Security | Design Authority |
| Maintain runbooks | Claims Platform Team | Solution Architect (P. Natarajan) | Technology Operations | Service Desk |
