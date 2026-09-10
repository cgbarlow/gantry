---
module: dependencies
status: draft
owner: c.barlow
---
# Dependencies

## Dependencies

The environments cannot be built until the Cloud Platform team provisions resource groups in the Contoso UAT and Production subscriptions and, in each, a virtual network subnet delegated to Container Apps, an internal-only Container Apps environment, a storage account with a file share, and a Log Analytics workspace. They cannot be reached until the Network / security team publishes the internal DNS names pointing at each environment's internal load balancer address, issues certificates for them, and confirms the rules that admit the Contoso network and VPN to the subnet and allow the environment outbound HTTPS to Azure DevOps and the container registry. The container app pulls from the registry the release pipeline already pushes to, using a managed identity that must be granted pull rights; if that registry sits behind a private endpoint, the endpoint must be reachable from each environment's virtual network.

On the Azure DevOps side, an Azure DevOps project and repository must exist for the Production workspace (and a separate one for UAT) before any instance can be created there, the users who will author in each must hold PATs with access to it, and the pipeline needs a service connection able to update the container apps.

Downstream, the Architecture Practice's own design work is the first consumer: the pilot in UAT is the practice authoring real initiatives, and Production go-live is the point at which the workspace repository becomes the system of record for design artefacts.
