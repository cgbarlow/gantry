---
module: dependencies
status: draft
owner: c.barlow
---
# Dependencies

## Dependencies

The environments can't be built until the Cloud Platform team provisions, in each subscription, a subnet delegated to Container Apps, an internal-only environment, a file share and a Log Analytics workspace. They can't be reached until the Network / security team publishes internal DNS names and certificates and confirms the inbound rules and outbound HTTPS to Azure DevOps and the container registry. The container app's managed identity needs pull rights on the registry.

In Azure DevOps, each environment needs its own workspace repository, authors need PATs with access to it, and the pipeline needs a service connection that can update the container apps.

At Production go-live the workspace repository becomes the system of record for design artefacts.
