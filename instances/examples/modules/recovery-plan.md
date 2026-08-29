---
module: recovery-plan
status: agreed
owner: c.barlow
---
# Recovery Plan

## Recovery approach

### Platform

Both services run as ECS Fargate services with 2 tasks each across two
availability zones behind internal ALBs. Loss of a single task or AZ is
handled automatically by ECS and the ALB health checks with no operator
action. The model is **active-active** within the region; there is no
cross-region standby.

- **Required availability:** business hours (Mon–Fri 07:00–19:00 NZ),
  target 99.5% over a rolling month.
- **RTO:** 1 hour (redeploy from Terraform + last image).
- **RPO:** 0 for submitted certificates (written to S3 with versioning
  before the success screen is shown); up to 5 minutes for reference codes
  (re-derivable from EOS via `eos-sync`).

## Resiliency

- **Certificates S3 bucket** — versioning enabled, cross-AZ by default,
  server-side encrypted with `alias/contoso-shared-docs`. A deleted or
  overwritten object is recoverable from a prior version.
- **Postgres (`intake` schema)** — inherits the shared instance's automated
  daily snapshot and 7-day point-in-time recovery.
- **Redis session store** — single node, no replica. Session loss forces
  re-authentication only; no durable data is held there, so it is
  deliberately not made highly available.
- **Container images** — retained in ECR with immutable tags; the last 10
  builds are always redeployable.

## Test scenarios

| Scenario | Type | Expected behaviour |
|----------|------|--------------------|
| Single ECS task killed | Component | ALB drains the task, ECS starts a replacement; no failed requests observed. |
| One AZ withdrawn | Zone | Traffic serves entirely from the remaining AZ; latency unchanged. |
| Redis node restart | Component | In-flight submissions must restart from the reference-code screen; new sessions succeed once the node is back. |
| Full environment rebuild | Region-local DR | `terraform apply` from a clean state + redeploy last image restores service within the 1-hour RTO; certificates bucket and Postgres data are untouched. |
| Accidental S3 object deletion | Data | Object restored from a prior version within minutes. |

## RACI

| Task | R | A | C | I |
|------|---|---|---|---|
| ECS / ALB incident response | Contoso Digital Support | Delivery lead | Architecture | EOS platform team |
| Terraform rebuild | Contoso Digital Support | Delivery lead | Architecture | — |
| Postgres point-in-time restore | EOS platform team | EOS platform lead | Contoso Digital Support | Delivery lead |
| S3 object-version restore | Contoso Digital Support | Delivery lead | — | Architecture |
| Declaring a DR event | Delivery lead | Contoso Service Management | Architecture, EOS platform team | Product owner |
