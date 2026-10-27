---
module: recovery-plan
status: agreed
owner: m.walker
---
# Recovery Plan

## Recovery approach

The recovery targets are set in the NFRs; this section describes how the solution meets them.

### Platform

The shared services run active-active in Wellington, with a warm database standby in Auckland. The mainframe and the Financial Application keep their existing arrangements. Failover redeploys with the release playbooks, so recovery matches production.

### Workloads

- Shared services: on loss of the Wellington hall, the Auckland database is promoted and the services deployed from the playbooks.
- CRM workflow: recovered with the CRM System's own vendor-supported failover.
- Documents: the nightly snapshot is restored, and later documents re-uploaded from the CRM System's pending queue.
- Payments: in-flight instructions are reconciled with the BIBIT gateway before any are re-sent.
- Each Handle Claim step can also switch to its manual fallback while a service recovers.

## Resiliency

Every new component is redundant within Wellington: two instances per service, a two-node database cluster, paired load balancers and dual MQ bridge channels. CIS's policy lookup cache keeps registration working through a short mainframe outage. Auckland provides database and rebuild resiliency, not active-active, because the mainframe isn't.

## Test scenarios

| Scenario | Failover type | Frequency | Runbook |
| --- | --- | --- | --- |
| Loss of a service instance | Automatic (load balancer) | Monthly | RB-CLM-01 |
| Loss of the primary database host | Automatic promotion | Quarterly | RB-CLM-02 |
| Loss of the Wellington hall | Manual site failover | Annually, and before increment 3 | RB-CLM-03 |
| Mainframe MQ path unavailable | Cache, then process fallback | Quarterly | RB-CLM-04 |
| BIBIT gateway unavailable | Queue, then batch payment file | Twice a year with Treasury | RB-CLM-05 |

## RACI

| Task | Responsible | Accountable | Consulted | Informed |
| --- | --- | --- | --- | --- |
| Invoke site failover | Technology Operations | Platform Engineering Lead | Claims Platform Team | Head of Claims |
| Switch a step to manual fallback | Claims Support Administrator | Claims Product Owner | Technology Operations | Claims handlers |
| Reconcile in-flight payments | Finance Systems | Finance Systems Manager | Treasury | Head of Claims |
| Run recovery tests | Technology Operations | Platform Engineering Lead | Information Security | Design Authority |
