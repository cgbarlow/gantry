---
module: data-security-controls
status: agreed
owner: c.barlow
---
# Data Security Controls

## Controls

### Encryption

- **In transit** — all external traffic terminates TLS 1.2+ at the Contoso API
  Gateway; portal↔API and API↔Postgres traffic stays within the VPC and uses
  TLS. S3 access is HTTPS-only (`aws:SecureTransport` bucket-policy condition).
- **At rest** — the certificates bucket uses SSE with the Contoso-managed KMS key
  `alias/contoso-shared-docs`; the `intake` Postgres schema inherits the shared
  instance's storage encryption; ElastiCache Redis has encryption at rest and
  in transit enabled.

### Operational — incident management

- CloudWatch alarms on 5xx rate, API latency, and failed file validations
  route to the `#contoso-digital-support` on-call rotation.
- All certificate submissions write an audit line (submission ID, reference
  code, provider registration number, timestamp — no client identifiers) to a
  dedicated, non-expiring CloudWatch log group.
- Segregation of duties: the delivery team can deploy via pipeline but has no
  standing write access to the production S3 bucket or Postgres schema.

### Networking

- The Intake API has no public route; `sg-intake-api` accepts port 4000 only
  from `sg-provider-portal`.
- The certificates bucket denies every request that does not arrive via the
  VPC endpoint `vpce-0f1e2d3c`.
- Outbound internet access from the private subnet is limited to the AWS
  service endpoints the API needs.

### Access management

- Human access to AWS is via SSO with short-lived role assumption; no static
  IAM users.
- Database access is via IAM-authenticated RDS proxy — no stored credentials.
- Secrets (OIDC client secret, KMS key ARN) live in AWS Secrets Manager and
  are injected at task start; they are never committed.

### Documentation

- This as-built document, the runbook, and the Terraform in the
  `provider-portal-infra` repo are sufficient to rebuild the system from
  scratch.

## Inheritance and dependencies

The solution runs entirely within the existing Contoso AWS landing zone and
inherits its controls:

- **Platform** — Contoso AWS Organization guardrails (SCPs), centralised
  CloudTrail, GuardDuty, and Config rules.
- **Services used** — ECS Fargate, ALB, S3, RDS (Postgres), ElastiCache
  (Redis), Secrets Manager, KMS, API Gateway.
- **Data locality** — `ap-southeast-2` (Sydney) only.
- **Standards** — NZISM, the Contoso Cloud Security Standard, and OWASP ASVS L2
  for the portal.
- **Description of use** — client-identifying data stays in EOS; this system
  handles only a masked identity plus the certificate file itself.
