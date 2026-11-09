---
module: team-and-estimates
status: draft
owner: c.barlow
---
# Teams, contact persons, and high-level estimates

## Teams required

- Architecture Practice — owns Gantry and this initiative: workspaces, UAT pilot, deployment stage and cutover; contact Chris Barlow
- Cloud Platform team — provisions the subnets, Container Apps environments, file shares and Log Analytics workspaces through standard infrastructure-as-code; contact <cloud-platform-lead>
- Network / security team — DNS names, certificates, network and egress rules, corporate proxy CA; contact <network-security-lead>

## Estimates

| Workstream | Size | Basis |
| --- | --- | --- |
| UAT environment | S | A standard Container Apps pattern for the Cloud Platform team |
| Production environment | S | The same infrastructure-as-code with Production parameters |
| Container app, pipeline stage and alerts | S | The image is proven; one `update` call per environment |
| Workspaces, pilot and cutover | S | The pilot's length is set by the practice's confidence |

Four Smalls: indicatively three to five weeks for UAT and three to four more for Production, driven by team availability. No dollar figures at SOAP level.
