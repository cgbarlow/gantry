---
module: open-questions
status: draft
owner: c.barlow
---
# Open Questions

## Open questions

| # | Question | Who resolves | By when |
| --- | --- | --- | --- |
| Q1 | Which load balancer fronts the two Production servers: internal Azure Load Balancer (layer 4, TLS on the servers) or internal Application Gateway (layer 7, TLS at the gateway)? | Cloud Platform team with Architecture Practice | Before Production provisioning (step 3) |
| Q2 | How does a published image tag reach the VMs: an Azure Pipelines release stage with approval, automatic pull on the VM, or a manual runbook? | Architecture Practice with Cloud Platform team | End of the UAT pilot |
| Q3 | What is the phase-1 monitoring: Azure Monitor on container health and VM metrics with alerting, or the load balancer probe alone? | Cloud Platform team | End of the UAT pilot |
| Q4 | What VM size does the UAT pilot show is enough, and is the same size right for Production with two servers? | Architecture Practice | End of the UAT pilot |
| Q5 | Does the container registry need a private endpoint in each tenancy, or is it reachable over the existing network path? | Network / security team | Before UAT provisioning |
