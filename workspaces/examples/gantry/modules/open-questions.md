---
module: open-questions
status: draft
owner: c.barlow
---
# Open Questions

## Open questions

| # | Question | Who resolves | By when |
| --- | --- | --- | --- |
| Q1 | Azure Files mount protocol: SMB with the storage-account key held as a Container Apps secret, or NFS from a storage account locked to the virtual network (which needs ports 445/2049 open on the subnet and no encryption-in-transit requirement)? | Cloud Platform team | Before UAT provisioning (step 1) |
| Q2 | Workload profile for Production: Consumption (pay per replica, platform may move replicas) or a small Dedicated profile (fixed capacity, predictable placement)? | Cloud Platform team with Architecture Practice | End of the UAT pilot |
| Q3 | Which Azure Monitor alerts are the phase-1 set: replica restarts, failed revision provisioning, and HTTP 5xx rate from the ingress logs are the proposed three. Who receives them? | Cloud Platform team | End of the UAT pilot |
| Q4 | What replica size (vCPU, memory) does the UAT pilot show is enough, and is two the right Production minimum? | Architecture Practice | End of the UAT pilot |
| Q5 | Does the container registry need a private endpoint in each virtual network, or is it reachable over the existing egress path? | Network / security team | Before UAT provisioning |
| Q6 | Is the release pipeline's service connection allowed to update Production container apps directly behind an environment approval, or does Production deployment go through a separate change process? | Architecture Practice with Cloud Platform team | Before Production provisioning (step 3) |
| Q7 | What security scanning, if any, must Gantry's build pipeline perform before Production go-live — static analysis, dependency vulnerabilities, container image — and to what standard? Today the pipeline gates on tests, coverage and a successful render only; it publishes no static-analysis results, and the SARIF publish step that Defender for Azure DevOps would read is written but commented out. | Network / security team with Architecture Practice | Before Production provisioning (step 3) |
