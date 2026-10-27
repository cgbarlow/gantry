---
module: introduction
status: agreed
owner: p.natarajan
---
# Overview

## Executive summary

Kiwi Cover Mutual's claims handling is slow because it runs across four systems never integrated after the ArchiSurance merger. This design replaces the manual hand-offs with a single Handle Claim process and shared services: the Customer Information Service (CIS), the Claims Information Service (Claims InfoServ) and payment through the BIBIT gateway. Policy Data Management stays on the mainframe as the policy system of record.

The Design Authority is asked to approve the design as build-ready. Delivery is three increments over nine months. The principal risks are mainframe integration capacity and the BIBIT contract, both with mitigations in hand.

## Overview

This document describes the target architecture for KCM's claims handling modernisation: the Handle Claim process, the services that support it, the data they share and the infrastructure they run on. It is an integration and process change first: the mainframe stays, but people stop keying into it.

## Purpose

The build-ready Solution Architecture Document for the claims handling modernisation, for the delivery teams, the Security and Privacy C&A reviewers, Technology Operations and the Design Authority that approves it.

## In scope

- One Handle Claim process (register, accept, valuate, pay) across the CRM System, Policy Data Management and the Financial Application.
- New shared services: CIS and Claims InfoServ, with registration, payment and customer services for the channels.
- The BIBIT gateway for claims payment and premium collection.
- Web and telephone policy intake on the same services.
- Claim documents moved into the document management system.
- The claims data mart feed.

## Out of scope

- Replacing Policy Data Management or retiring the mainframe, a separate roadmap item this design makes easier.
- Replacing the CRM System or the Financial Application; both are extended.
- Underwriting, pricing and product configuration.
- Fraud analytics beyond the existing referral rules.
- Broker, partner and mobile channels.

## Content standards

Diagrams use ArchiMate 3 notation: yellow for business, blue for application and green for technology elements. Each is reproduced from the enterprise architecture repository. "ArchiSurance" in a diagram means the inherited Policy Data Management platform. This SSAD covers what support needs; the SAD holds the full rationale.
