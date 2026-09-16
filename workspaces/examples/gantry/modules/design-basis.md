---
module: design-basis
status: draft
owner: c.barlow
---
# Design Basis

## Constraints

- **Both environments run in Contoso's own Azure tenancies** (`<contoso-uat-subscription>` and `<contoso-prod-subscription>`). No third-party hosting.
- **No built-in authentication; the network is the security boundary.** This is Gantry's documented stance: each user's Azure DevOps PAT authorises their own reads and writes, and the service assumes the network has already authenticated the caller. The Container Apps environment is therefore created internal-only, inside a Contoso virtual network, so it is reachable from the Contoso network and VPN and from nowhere else. Internal-only is set at environment creation and cannot be changed afterwards.
- **Azure DevOps workspaces only, in both environments.** Gantry can also keep "local instances" on its own instances directory, with file-based registries beside them. Several replicas mounting one share would write those registries concurrently with no locking, so local instances are not used in Production, and UAT mirrors Production so that behaviour is proven before it matters. The share carries only the workspace registry and configuration.
- **Always-on replicas.** Container Apps can scale to zero; this service does not. Minimum replicas is one in UAT and two in Production so there is never a cold start and Production always has a second replica to fail over to.
- **The only automated assurance on a Gantry release is the branch-protection build, and it checks behaviour rather than security.** `azure-pipelines.yml` runs as the build validation policy on `main`: it builds the image from `ContainerFile`, runs the unit, integration and Playwright suites, enforces coverage thresholds, renders every example artefact, and fails the pull request if any of that fails. It runs no static analysis, no dependency vulnerability scan and no container image scan. The step that would publish static-analysis findings as the `CodeAnalysisLogs` artefact — read by the SARIF Scans Tab extension and by Microsoft Defender for Azure DevOps — is written into the pipeline but commented out, waiting on linters that emit SARIF. What the image does carry is a smaller attack surface by construction: it installs production dependencies only (`npm ci --omit=dev`) and runs as a non-root user. Hosting does not change any of this; closing the gap is a change to the build pipeline, and whether it is required before Production is Q7 under Open questions.

## Assumptions

- Users reach the service over the Contoso network or VPN and hold an Azure DevOps PAT with access to the workspace repository. No new identity work is needed.
- UAT and Production point at **different** Azure DevOps workspace repositories, so trials in UAT never touch Production artefacts.
- Usage is low: tens of concurrent users, not hundreds. Replicas are sized small (0.5 vCPU, 1 GiB) on that basis and revisited after UAT.
- The Cloud Platform team provisions the virtual network subnet, Container Apps environment, storage account and file share through their standard infrastructure-as-code. This repository holds no Terraform or Bicep for the environments.
- The container image is pulled from the registry the release pipeline already publishes to (`gantry:<version>`) using the container app's managed identity; nothing is built in the environment.
- The Network / security team accepts the assurance the build pipeline provides today — peer-reviewed pull requests gated on a full test run, a production-dependencies-only image running as a non-root user, and no public endpoint — as sufficient for an internal-only service at this stage. If they require scanning gates first, that work is added to Gantry's build pipeline rather than to the hosting environment, and it would move the go-live dates.
- Outbound HTTPS to `dev.azure.com` leaves the virtual network by Contoso's standard egress path; if that path inspects TLS, the corporate CA is mounted into the container as a secret volume and `NODE_EXTRA_CA_CERTS` points at it, as the README describes for the container generally.
- The Azure Files share is a classic SMB share in a storage account reachable from the environment's virtual network, mounted read-write as the container's instances directory.
