---
module: glossary
status: agreed
owner: c.barlow
---
# Glossary

## Terms and definitions

| Term | Definition |
|------|------------|
| ALB | Application Load Balancer (AWS) |
| C&A | Certification and Accreditation |
| DOB | Date of birth |
| EOS | Eligibility and Obligations System — Contoso's system of record for benefit applications; the system this solution attaches certificates to |
| eos-sync | Existing scheduled job that copies reference codes from EOS into the Postgres `reference_codes` table every 5 minutes |
| IAM | Identity and Access Management (AWS) |
| KMS | Key Management Service (AWS) |
| Luhn | The Luhn mod-10 checksum algorithm used to derive the reference code's check digit |
| MIME sniffing | Determining a file's true type from its leading bytes rather than trusting the declared `Content-Type` |
| OIDC | OpenID Connect — the protocol the external provider-authentication service uses |
| RDS | Relational Database Service (AWS) |
| Reference code | An 8-character one-time code (`NNNN-NNNN`) that ties a certificate submission to an existing EOS application without exposing client identity |
| RPO | Recovery Point Objective — the maximum acceptable data loss, measured in time |
| RTO | Recovery Time Objective — the maximum acceptable time to restore service |
| SSE | Server-Side Encryption (AWS S3) |
| VPC | Virtual Private Cloud (AWS) |
