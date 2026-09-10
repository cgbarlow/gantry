---
module: introduction
status: agreed
owner: p.natarajan
---
# Overview

## Executive summary

Kiwi Cover Mutual's claims handling is slow and fragmented because it runs across four systems that were never integrated after the ArchiSurance merger. This design replaces the manual hand-offs between them with a single Handle Claim process and a small set of shared application services — customer information, claims information, and premium and claims payment — while leaving Policy Data Management on the mainframe as the policy system of record for now.

The solution introduces a Claims Information Service (Claims InfoServ) and a Customer Information Service (CIS) in the UNIX server farm, extends the CRM System and the Home & Away Financial Application to consume them, integrates the BIBIT payment gateway for same-day claims payment and premium collection through the bank, and moves claim documents into a document management system every step can read. Policy intake over web and telephone reuses the same services so a request is captured once.

The Design Authority is asked to approve this design as build-ready. Delivery is planned in three increments over nine months; the first increment (registration and acceptance) is estimated at a Large, the remaining two at a Medium each. The principal risks are the mainframe integration capacity and the BIBIT contract, both with mitigations in hand.

## Overview

This document describes the target architecture for KCM's claims handling modernisation: a single end-to-end Handle Claim process, the application services that support it, the data those services share, and the infrastructure they run on. It also covers the web and telephone policy intake flow, which shares the same services. The change is an integration and process change first and a platform change second — the mainframe stays, but stops being something people key into.

## Purpose

This document is the build-ready Solution Architecture Document for the claims handling modernisation. It is written for the delivery teams that will build and integrate the solution, the Security and Privacy teams performing the certification and accreditation review, the Technology Operations team that will run it, and the Design Authority that approves it. The Solution Support Architecture Document derived from the same content is the support team's reference after go-live, and the As-built document records what was actually delivered.

## In scope

- A single Handle Claim business process — register, accept, valuate, pay — orchestrated across the CRM System, Policy Data Management and the Home & Away Financial Application.
- New shared application services: Customer Information Service (CIS), Claims Information Service (Claims InfoServ), and the customer data modification, insurance application, claim registration, claim payment and premium payment services exposed to the channels.
- Integration of the BIBIT payment gateway with the Home & Away Financial Application and the bank system for claims payment and premium collection.
- Web and telephone policy intake ("take out insurance") using the same customer and policy services, removing seller re-keying.
- Migration of claim documents from the scanning archive into the document management system, indexed by claim.
- Home, contents, motor and travel product lines; liability and legal-aid claims follow the same process with no product-specific change.
- The claims data mart feed used by Finance and Actuarial reporting.

## Out of scope

- Replacing Policy Data Management or retiring the mainframe. The mainframe remains the policy system of record; its retirement is a separate roadmap item that this design deliberately makes easier but does not deliver.
- Replacing the CRM System or the Home & Away Financial Application. Both are extended, not replaced.
- Underwriting rules, pricing and product configuration changes.
- Fraud analytics beyond the existing referral rules; the claims data mart feed is provided, the models are not.
- Broker and partner channels. Only KCM's own web and telephone channels are in scope for policy intake.
- Member-facing mobile applications.

## Content standards

Diagrams in this document use ArchiMate 3 notation: yellow for business layer elements, blue for application layer, green for technology layer. The viewpoint diagrams were produced in the enterprise architecture repository and are reproduced here as images; each image carries a source citation to the copy stored with this design. Where a diagram shows the legacy name "ArchiSurance" it refers to the inherited Policy Data Management platform and its supporting roles, not to a separate organisation. This SSAD covers what a support team needs and refers to the Solution Architecture Document for the full design rationale.
