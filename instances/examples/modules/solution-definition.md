---
module: solution-definition
status: agreed
owner: c.barlow
---
# Solution Definition

## High Level Requirements

| Section | Requirement |
| --- | --- |
| Application | Clients can apply for Mobile Phone Assistance through ContosoSelfService. |
| Review | Staff can assess and approve or decline an application in CMS. |
| Provisioning | An approved application provisions the phone plan and triggers payment. |
| Review cycle | The benefit can be reviewed annually and stopped when it is no longer needed. |

## Process flow

A client browses available phones and plans through a carrier-hosted
catalogue linked from ContosoSelfService, then submits a Mobile Phone Assistance
application through an online form. The form response and any supporting
attachments are passed to CMS, which validates the application and creates
a review task for staff. Once a staff member approves the application in
CMS, CMS calls the carrier's API to provision the subscription, notifies
downstream systems of the new device and plan, and triggers payment for the
device and the first month's subscription. CMS schedules an annual review
task so a staff member can confirm the benefit is still needed twelve months
later; if it isn't, CMS notifies payments to stop and calls the carrier's
API to end or downgrade the subscription.

## High level solution overview

The solution links ContosoSelfService to a carrier-hosted device and plan catalogue,
routes applications through the existing intake and workflow tooling (the
online form, case management, and task/workflow systems already used for
other hardship applications), and integrates with the carrier via API for
provisioning and termination. Payment obligations are handled by the
existing payments system rather than a new one. No new case management or
workflow product is introduced — MPA is a new application type layered onto
tooling that already exists.

## Assumptions

The carrier will provide a portal that can be linked from ContosoSelfService to browse
available phones and plans, and an API for provisioning and terminating a
subscription once an application is approved. The carrier is assumed to
handle physical delivery of the device through its own existing channels
(courier or in-branch pickup) — Contoso does not take on any device logistics.

## Feature breakdown and involved teams

- **Present available phones and plans**: link from ContosoSelfService to the carrier's
  catalogue. Teams: ContosoSelfService.
- **Submit an MPA application**: client fills in an application form,
  redirected from ContosoSelfService; form responses and attachments are collected and
  passed to case management. Teams: ContosoSelfService, application intake, case
  management, integration.
- **Review and approve an application**: staff review the application in
  case management and approve or decline it. Teams: case management,
  workflow.
- **Provision the device and plan**: on approval, case management calls the
  carrier's API to create the subscription and notifies payments and
  reporting systems. Teams: case management, integration, payments,
  reporting.
- **Annual review**: a scheduled task prompts staff to confirm the benefit
  is still needed; if not, the subscription is ended and payments stopped.
  Teams: case management, workflow, payments.
