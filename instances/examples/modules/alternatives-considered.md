---
module: alternatives-considered
status: draft
owner: c.barlow
---
# Alternatives Considered

## Alternatives

1. **Do nothing** — retain the fax/post process. Rejected: processing delays and misattribution risk continue to grow with volume.
2. **Embed the flow inside ContosoSelfService** — rejected because providers are external users without ContosoSelfService credentials; would require building a new provider identity system inside ContosoSelfService itself, a much larger scope.
3. **Provider self-registration with no reference code** — rejected as a higher identity-risk surface than a one-time reference code tied to an existing application.
