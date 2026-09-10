---
module: team-and-estimates
status: draft
owner: c.barlow
---
# Teams, contact persons, and high-level estimates

## Teams required

- Architecture Practice — owner of Gantry and of this initiative; sets up the workspaces, runs the UAT pilot, owns the cutover; contact Chris Barlow
- Cloud Platform team — provisions the VMs, Azure Files shares, load balancer and resource groups in the UAT and Production tenancies through their standard infrastructure-as-code; contact <cloud-platform-lead>
- Network / security team — internal DNS names, network rules admitting the Contoso network and VPN, outbound rules to Azure DevOps and the registry, corporate proxy CA; contact <network-security-lead>

## Estimates

| Workstream | Size | Basis |
| --- | --- | --- |
| UAT environment | S | One VM, one share, one DNS name; standard patterns for the Cloud Platform team |
| Production environment | M | Two VMs, a shared share and a load balancer; the load balancer choice and its certificate add elapsed time |
| Container runtime, deployment path and monitoring | S | Docker and the published image are already proven locally; the open mechanism choices are all small once made |
| Workspaces, pilot and cutover | S | Repository creation and registration are quick; the pilot's length is set by how long the practice needs to trust it |

Overall: one Medium and three Smalls. Indicatively four to six weeks elapsed for UAT and a further four to six for Production, driven by team availability rather than effort. No dollar figures at SOAP level.

## References

- README.md, "Deploying to a server (UAT / production)": persistence, access control, health check and upgrade guidance for the container
- `azure-pipelines.release.yml` and `ContainerFile`: how the image is built and which tags are published
- docs/adr/0005, docs/adr/0010 and docs/adr/0029: why instance data lives in Azure DevOps workspace repositories, and what a local workspace is
- Azure DevOps work item #354 (this initiative) and #353 (Mermaid rendering, which these diagrams depend on)
