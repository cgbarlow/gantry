---
module: open-questions
status: draft
owner: c.barlow
---
# Open Questions

## Open questions

| # | Question | Who resolves | By when |
| --- | --- | --- | --- |
| Q1 | Mount the Azure Files share over SMB with a storage-account key, or over NFS locked to the virtual network? | Cloud Platform team | Before UAT provisioning (step 1) |
| Q2 | Consumption or a small Dedicated workload profile for Production? | Cloud Platform team with Architecture Practice | End of the UAT pilot |
| Q3 | Which Azure Monitor alerts form the phase-1 set, and who receives them? | Cloud Platform team | End of the UAT pilot |
| Q4 | What replica size does the pilot show is enough, and is two the right Production minimum? | Architecture Practice | End of the UAT pilot |
| Q5 | Does the container registry need a private endpoint in each virtual network? | Network / security team | Before UAT provisioning |
| Q6 | Can the pipeline deploy to Production behind an environment approval, or is a separate change process needed? | Architecture Practice with Cloud Platform team | Before Production provisioning (step 3) |
| Q7 | What security scanning must the build pipeline perform before Production go-live, and to what standard? | Network / security team with Architecture Practice | Before Production provisioning (step 3) |
