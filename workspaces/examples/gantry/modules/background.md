---
module: background
status: draft
owner: c.barlow
---
# Background and context

## Problem statement

Gantry has nowhere to be hosted.

Gantry is the Architecture Practice's tool for authoring staged, gated design artefacts (Solution on a Page, High Level Design, Solution Architecture Documents, operational handover) from module data held in an Azure DevOps repository. The application, the design definition and the published container image all exist. What does not exist is a server running it: no URL an architect, reviewer or sponsor can open, no shared workspace for every initiative's artefacts, and nowhere to try a change before it reaches the people who depend on it.

Until a hosted instance exists, the process Gantry encodes cannot be the process the practice actually follows.

## Affected domains

- Architecture Practice
- Cloud Platform team

## Opportunity

A hosted Gantry turns the design process from a document convention into a shared service:

- **One shared workspace** for every SOAP, HLD and handover, authored against the same definition.
- **Consistent stage gates**, checked by the tool against the fields each artefact requires.
- **Agent-assisted authoring** against the definition rather than a template someone has to interpret.
- **Onboarding other teams**, who need a URL to adopt the definition.
- **Definitions beyond design**, such as procurement or assurance, on the same service.
