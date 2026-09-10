---
module: design-basis
status: draft
owner: c.barlow
---
# Design Basis

## Constraints

- **Both environments run in Contoso's own Azure tenancies** (`<contoso-uat-subscription>` and `<contoso-prod-subscription>`). No third-party hosting.
- **No built-in authentication; the network is the security boundary.** This is Gantry's documented stance: each user's Azure DevOps PAT authorises their own reads and writes, and the service assumes the network has already authenticated the caller. Reachability is therefore restricted to the Contoso network and VPN.
- **Azure DevOps workspaces only, in both environments.** Gantry can also keep "local instances" on the server's own instances directory, with file-based registries beside them. Two Production servers mounting one share would write those registries concurrently with no locking, so local instances are not used in Production, and UAT mirrors Production so that behaviour is proven before it matters. The share carries only the workspace registry and configuration.

## Assumptions

- Users reach the service over the Contoso network or VPN and hold an Azure DevOps PAT with access to the workspace repository. No new identity work is needed.
- UAT and Production point at **different** Azure DevOps workspace repositories, so trials in UAT never touch Production artefacts.
- Usage is low: tens of concurrent users, not hundreds. The VMs are sized small on that basis and revisited after UAT.
- The Cloud Platform team provisions the VMs, share, load balancer and DNS through their standard infrastructure-as-code. This repository holds no Terraform or Bicep for the environments.
- The container image is pulled from the registry the release pipeline already publishes to (`gantry:<version>`); nothing is built on the servers.
- Outbound HTTPS to `dev.azure.com` passes through the corporate proxy; if that proxy inspects TLS, the corporate CA is mounted into the container as the README describes.
