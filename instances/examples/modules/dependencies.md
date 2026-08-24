---
module: dependencies
status: agreed
owner: c.barlow
---
# Dependencies

## Dependencies overview

Depends on the existing external provider-authentication service being able to onboard GP/nurse practitioner accounts in time for launch, and on EOS's intake API team having capacity to build the new create-application-document endpoint this quarter.

## Dependency list

- Provider-authentication service — provider identity and login; owned by an external vendor
- EOS — system of record for applications; owned by the EOS platform team
- API Gateway — public ingress and WAF; owned by Contoso Platform Engineering
- ContosoSelfService — reference code generation reused from the existing client-facing flow; owned by the ContosoSelfService team
