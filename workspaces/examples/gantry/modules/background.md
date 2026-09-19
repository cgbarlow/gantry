---
module: background
status: draft
owner: c.barlow
---
# Background and context

## Problem statement

Gantry has nowhere to be hosted.

Gantry is the Architecture Practice's tool for authoring staged, gated design artefacts (Solution on a Page, High Level Design, Solution Architecture Documents, operational handover) from a single set of module data held in an Azure DevOps repository. The application exists, the design definition exists, and the container image is built and published by the release pipeline on every merge to `main`. What does not exist is a server running it: there is no URL an architect, reviewer or sponsor can open, no shared workspace that every initiative's artefacts land in, and no environment in which a change can be tried before it reaches the people who depend on it.

Until a hosted instance exists, the process Gantry encodes cannot be the process the practice actually follows.

## Affected domains

- Architecture Practice
- Cloud Platform team

## Opportunity

A hosted Gantry turns the design process from a document convention into a shared service:

- **One shared workspace for every design initiative.** Every SOAP, HLD and handover lives in the same Azure DevOps workspace repository, authored against the same definition and gated the same way, instead of in whichever document each architect started from.
- **Consistent stage gates and sign-off.** Business Case Approved, HLD approved by the ARB and Build Readiness Confirmed are checked by the tool against the fields each artefact actually requires, so a gate means the same thing for every initiative.
- **Agent-assisted authoring.** With a hosted instance and a workspace in Azure DevOps, agents can draft, check and render artefacts against the definition rather than against a template someone has to interpret.
- **Onboarding other teams.** A URL is the precondition for any other Contoso team adopting the design definition; without one there is nothing to point them at.
- **Definitions beyond design.** Gantry's engine is definition-driven. Once hosted, other staged and gated processes (for example a procurement or an assurance process) can be authored as definitions and run on the same service, with no change to the platform.
