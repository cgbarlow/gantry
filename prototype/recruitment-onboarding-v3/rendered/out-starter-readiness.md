# Platform Engineer: Starter Readiness

## Document Control

| Field | Value |
|---|---|
| Version | recruitment-onboarding v3 · Provisioning |
| Date | 2026-09-23 |
| Commit | `abc1234` |
| Status | Draft |

## Review & sign-off

| Name | Role / Title | Date | Review process | Status | Reference |
|---|---|---|---|---|---|
|  |  |  |  | Pending |  |

# The starter

## Starter

Marama Clarke

## Role

Platform Engineer, Platform Engineering team, Technology.

The role builds and maintains the container platform and deployment pipelines that Contoso's product teams deploy onto. It is the third engineer on a team of two that currently supports eleven product teams, and its focus is the self-service half of the platform: making the paths product teams take most often safe, documented and unattended.

## Team and reporting line

Platform Engineering, within Technology. Reports to Tomas Berg, Platform Engineering Lead, who is the hiring manager for this requisition.

The team is Tomas plus two engineers. It sits alongside Cloud Operations and Information Security, and has a standing dependency on both for anything that changes the deployment path.

## Start date

20 April 2026

# Identity

## User ID

mclarke

## Account

User ID `mclarke` created 13 April 2026 in the identity governance platform by Cloud Operations, on the provisioning request raised automatically when onboarding was approved on 10 April.

Three days between onboarding approval and account creation, of which two were a weekend. The request itself sat for under a day.

## Propagation

Propagated to the corporate directory service on 13 April 2026, within an hour of creation. The service management platform picked the record up on its next sync the same evening, and the source control and container platform group memberships followed automatically on 14 April.

One system did not provision automatically: the observability platform, which has no directory integration and was created by hand by Mereana Walker on 16 April. This is the case for every starter, not something specific to this hire.

## Credential issue

Emailed by Tomas Berg (hiring manager) to Marama Clarke's personal email address on 16 April 2026, four days before her start date. User ID and initial password in the same message. She confirmed receipt the same day and changed the password on first sign-in on 20 April.

This is the process working as it is currently defined, and it is a weakness. The credentials for a new account travelled by email to a personal mailbox, where the message remains unless the recipient deletes it; nothing in the process asks them to. The hiring manager has no better option available — there is no other mechanism defined.

Recorded plainly rather than glossed, because the argument for replacing this step is made from a run of entries like this one.

# Device

## Standard or non-standard

Non-standard

## Specification

Non-standard.

The standard Technology issue is a 16GB laptop. This role builds and runs container images locally as a matter of course, and both incumbent Platform Engineers run 32GB machines that were themselves approved as exceptions. A 32GB machine was specified, otherwise identical to standard issue.

Requested 13 April 2026 by automatic request when the directory record appeared. Ordered the same day; delivered 16 April. Built and configured 17 April by the service desk. Ready 17 April, three days before the start date.

Five days from request to ready against the three the process assumes, the difference being the two-day order recorded below; the build itself took a single day.

## Non-standard hardware decision

Approved 13 April 2026 by Tomas Berg (Platform Engineering Lead), on the same basis as the two existing exceptions in the team.

What it changed: the machine was not in stock and was ordered rather than drawn from the pool, which added two days. Nothing else about the build differed.

There is no defined path for this. The process asks whether non-standard hardware is required but does not say who decides, what basis they decide on, or what happens differently once they have. In practice the hiring manager decided, on precedent, and told the service desk — which worked, and would not have worked if the manager had been new or the precedent absent. The two days it cost were not budgeted anywhere.

Third exception in the same team on the same grounds. At some point the standard for this role should change rather than each hire being an exception to it.

## Build status

Built

**Warning:** the device is not Ready and is not listed under "Not in place by the start date". This stage should not be signed off.

## Build notes

Requested 13 April 2026; ready 17 April. Five days against three.

# Access

## Entitlements

- Building access card — Wellington office, standard hours
- Source control — Platform Engineering organisation, write
- Container platform — administrator, non-production; read, production
- Deployment pipeline — approver on the Platform Engineering pipelines
- Observability platform — standard engineer access
- Service management platform — agent, Platform Engineering queue
- Email groups: platform-engineering, technology-all, oncall-platform
- Shared drive — Technology, Platform Engineering folder
- On-call paging tool — added to the platform rotation from 11 May

## Setup

Set up by Mereana Walker on 16 April 2026, in one pass, from the entitlement list agreed with Tomas Berg on 13 April.

Production container platform access was deliberately granted read-only at setup. The team's convention is that production write access follows the first completed on-call shadow, which is also why the paging tool entry carries a later date than the rest.

# Open questions

- Should the 32GB machine become the standard for Platform Engineer roles rather than the third consecutive exception? Raised by Tomas Berg, 13 April 2026. Owed by Mereana Walker as the team's asset owner, for the next Technology planning round.
- Does the internal vacancies list produce anything? Three consecutive Technology vacancies have drawn no applications through it. Raised by Hana Te Rangi, 6 March 2026. Owed by HR.
- Can building access cards be requested at onboarding approval rather than during the provisioning run, so a Monday start no longer misses the Tuesday batch? Raised by Mereana Walker, 21 April 2026. Owed by Facilities.

