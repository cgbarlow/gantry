---
module: design-basis
status: draft
owner: c.barlow
---
# Design Basis

## Constraints

- **Both environments run in Contoso's own Azure tenancies** (`<contoso-uat-subscription>` and `<contoso-prod-subscription>`).
- **The network is the security boundary.** Gantry has no built-in login: each user's Azure DevOps PAT authorises their own reads and writes. The Container Apps environment is created internal-only, which can't be changed afterwards, so it is reachable only from the Contoso network and VPN.
- **Azure DevOps workspaces only.** Local instances keep file-based registries that several replicas would write without locking, so neither environment uses them. The share holds only the workspace registry and configuration.
- **Always-on replicas:** at least one in UAT and two in Production, never scaled to zero.
- **The release build checks behaviour, not security.** `azure-pipelines.yml` builds the image, runs every test suite and renders every example, but runs no static analysis, dependency scan or image scan. The image installs production dependencies only and runs as a non-root user. Whether scanning is needed before Production is Q7.

## Assumptions

- Users reach the service over the Contoso network or VPN and hold an Azure DevOps PAT for the workspace repository.
- UAT and Production use **different** workspace repositories, so UAT trials never touch Production artefacts.
- Usage is low, tens of concurrent users, so replicas start small and are revisited after UAT.
- The Cloud Platform team provisions the environments through their standard infrastructure-as-code.
- The image is pulled from the existing registry with the container app's managed identity.
- The Network / security team accepts today's build assurance for an internal-only service; if not, scanning is added to the build pipeline, moving go-live.
- If egress inspects TLS, the corporate CA is mounted and `NODE_EXTRA_CA_CERTS` points at it.
