---
module: dependencies
status: draft
owner: c.barlow
---
# Dependencies

## Dependencies

The environments cannot be built until the Cloud Platform team provisions resource groups in the Contoso UAT and Production subscriptions, and cannot be reached until the Network / security team publishes the internal DNS names and the rules that admit the Contoso network and VPN and allow outbound HTTPS to Azure DevOps and the container registry. The VMs must be able to pull from the registry the release pipeline already pushes to; if that registry sits behind a private endpoint, that endpoint must exist in both tenancies.

On the Azure DevOps side, an Azure DevOps project and repository must exist for the Production workspace (and a separate one for UAT) before any instance can be created there, and the users who will author in each must hold PATs with access to it.

Downstream, the Architecture Practice's own design work is the first consumer: the pilot in UAT is the practice authoring real initiatives, and Production go-live is the point at which the workspace repository becomes the system of record for design artefacts.
