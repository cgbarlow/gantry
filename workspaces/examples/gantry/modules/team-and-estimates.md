---
module: team-and-estimates
status: draft
owner: c.barlow
---
# Teams, contact persons, and high-level estimates

## Teams required

- Architecture Practice — owner of Gantry and of this initiative; sets up the workspaces, runs the UAT pilot, owns the deployment pipeline stage and the cutover; contact Chris Barlow
- Cloud Platform team — provisions the virtual network subnets, Container Apps environments, container apps, storage accounts and file shares, and Log Analytics workspaces in the UAT and Production tenancies through their standard infrastructure-as-code; contact <cloud-platform-lead>
- Network / security team — internal DNS names and certificates, network rules admitting the Contoso network and VPN to the environment subnets, egress rules to Azure DevOps and the registry, corporate proxy CA; contact <network-security-lead>

## Estimates

| Workstream | Size | Basis |
| --- | --- | --- |
| UAT environment | S | One Container Apps environment, one share, one DNS name; a standard pattern for the Cloud Platform team |
| Production environment | S | The same infrastructure-as-code with Production parameters; no load balancer to design, and the certificate is the only extra |
| Container app, deployment pipeline stage and alerts | S | The image is already proven; the pipeline stage is one `update` call per environment; alerts are built-in metrics |
| Workspaces, pilot and cutover | S | Repository creation and registration are quick; the pilot's length is set by how long the practice needs to trust it |

Overall: four Smalls. Indicatively three to five weeks elapsed for UAT and a further three to four for Production, driven by team availability rather than effort. Moving from virtual machines to Container Apps took the Production workstream from a Medium to a Small. No dollar figures at SOAP level.

## References

- README.md, "Deploying to a server (UAT / production)": persistence, access control, health check and upgrade guidance for the container
- `azure-pipelines.release.yml` and `ContainerFile`: how the image is built and which tags are published
- docs/adr/0005, docs/adr/0010 and docs/adr/0029: why instance data lives in Azure DevOps workspace repositories, and what a local workspace is
- Azure Container Apps documentation: ingress (internal environments, TLS, load-balancing, 240-second request timeout), storage mounts (Azure Files shared across replicas), scaling (minimum replicas), revisions (zero-downtime update and rollback), health probes, and Log Analytics monitoring
- Azure DevOps work item #354 (this initiative) and #353 (Mermaid rendering, which these diagrams depend on)
