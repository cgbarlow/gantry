# Claims design workshop - notes

16 March 2026, Wellington. Notes by Priya Natarajan. (Fictitious example document, written for the Gantry example.)

Present: Priya Natarajan (Solution Architect), Hana Te Rangi (Claims Operations), Derek Fong (Mainframe Integration), Anaru Pihema (Treasury), Karen Doyle (Records Management), Elena Rossi (Privacy Office).

## Decisions

1. **Shared services, not point-to-point.** Customer and claim data is served by two new shared services, the Customer Information Service (CIS) and the Claims Information Service (Claims InfoServ). Every application calls them; none copies the data.
2. **Policy Data Management stays the system of record.** The mainframe exposes four CICS transactions (PDM-01 to PDM-04) as services. Nothing moves off the mainframe in this work.
3. **Two exposures a window.** Derek’s team can expose two CICS services in each monthly change window, so the first two transactions are ready for increment 1.
4. **Payments go through the Financial Application.** The Financial Application instructs the BIBIT gateway; the CRM System never calls the gateway.
5. **Delivery in three increments over about nine months,** each one switchable back to the manual step.

## Open questions

- **BIBIT pricing.** Does the contract variation keep current transaction pricing for claims payment? Anaru Pihema, before increment 3.
- **Mainframe windows.** Can both the April and May windows be used, given the Finance year-end freeze? Derek Fong, before increment 1.
- **Liability claims.** Are they routed to senior handlers by default, or only above a threshold? Hana Te Rangi, during increment 2 design.
- **Closed claims.** Are documents for claims closed beyond their retention period migrated or disposed of? Karen Doyle, before migration design.
- **Data mart.** Does the claims data mart feed need its own privacy impact assessment? Elena Rossi, by the HLD submission.

## Actions

| Action | Owner | By |
| --- | --- | --- |
| Draft the BIBIT contract variation | Anaru Pihema | 30 April 2026 |
| Book the April and May mainframe windows | Derek Fong | 27 March 2026 |
| Confirm the retention rules | Karen Doyle | 15 May 2026 |