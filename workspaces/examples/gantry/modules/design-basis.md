---
module: design-basis
status: draft
owner: c.barlow
---
# Design Basis

## Constraints

- **Both environments run in Contoso's own Azure tenancies** (`<contoso-uat-subscription>` and `<contoso-prod-subscription>`). No third-party hosting.
- **No built-in authentication; the network is the security boundary.** This is Gantry's documented stance: each user's Azure DevOps PAT authorises their own reads and writes, and the service assumes the network has already authenticated the caller. The Container Apps environment is therefore created internal-only, inside an Contoso virtual network, so it is reachable from the Contoso network and VPN and from nowhere else. Internal-only is set at environment creation and cannot be changed afterwards.
- **Azure DevOps workspaces only, in both environments.** Gantry can also keep "local instances" on its own instances directory, with file-based registries beside them. Several replicas mounting one share would write those registries concurrently with no locking, so local instances are not used in Production, and UAT mirrors Production so that behaviour is proven before it matters. The share carries only the workspace registry and configuration.
- **Always-on replicas.** Container Apps can scale to zero; this service does not. Minimum replicas is one in UAT and two in Production so there is never a cold start and Production always has a second replica to fail over to.

## Assumptions

- Users reach the service over the Contoso network or VPN and hold an Azure DevOps PAT with access to the workspace repository. No new identity work is needed.
- UAT and Production point at **different** Azure DevOps workspace repositories, so trials in UAT never touch Production artefacts.
- Usage is low: tens of concurrent users, not hundreds. Replicas are sized small (0.5 vCPU, 1 GiB) on that basis and revisited after UAT.
- The Cloud Platform team provisions the virtual network subnet, Container Apps environment, storage account and file share through their standard infrastructure-as-code. This repository holds no Terraform or Bicep for the environments.
- The container image is pulled from the registry the release pipeline already publishes to (`gantry:<version>`) using the container app's managed identity; nothing is built in the environment.
- Outbound HTTPS to `dev.azure.com` leaves the virtual network by Contoso's standard egress path; if that path inspects TLS, the corporate CA is mounted into the container as a secret volume and `NODE_EXTRA_CA_CERTS` points at it, as the README describes for the container generally.
- The Azure Files share is a classic SMB share in a storage account reachable from the environment's virtual network, mounted read-write as the container's instances directory.
