---
module: background
status: agreed
owner: p.natarajan
---
# Background and context

## Problem statement

Kiwi Cover Mutual (KCM) cannot settle a straightforward home or motor claim in under twelve working days, and every claim touches at least four separately operated systems.

KCM is a member-owned general insurer writing home, contents, motor, travel, liability and legal-aid cover for around 310,000 New Zealand members. Its claims handling still runs on the platform inherited from the 2014 merger with ArchiSurance: policy data and the claims ledger live in the ArchiSurance Policy Data Management application on the mainframe, customer contact is handled in a separate CRM System, payments are keyed by hand into the Home & Away Financial Application, and supporting documents are scanned into a document management system that none of the other three can read. A claims handler registers a claim in the CRM, re-keys the policy number into Policy Data Management to accept it, valuates it from a spreadsheet, and then raises a manual payment request that Finance settles in a weekly batch.

The consequences are measurable. Median time from first notification to payment is 12.4 working days against a member expectation of five. Around 18 percent of claims are re-keyed at least once because the CRM and the policy ledger disagree on the policy or the insured item. The mainframe skills pool is down to two contractors, and the annual ArchiSurance licence and support cost rose 22 percent at the last renewal. Web and telephone intake for new policies has the same shape: a request captured in one channel is re-entered by the insurance seller into the policy system.

## Affected domains

- Claims handling (register, accept, valuate, pay)
- Policy administration and premium collection
- Customer contact and CRM (web and telephone channels)
- Finance and payments (claims payment, premium receipting, bank settlement)
- Document management and correspondence
- Reporting and actuarial data
- Technology operations (mainframe, UNIX server farm, network and security)

## Opportunity

A member reports a claim once, through the channel of their choice, and KCM handles it end to end as one process: registration, acceptance, valuation and payment flow through a single Handle Claim process backed by shared customer, policy and claim data, with the payment released to the member's bank account the day the claim is approved.

The same shared services let a member take out a policy on the web or by telephone without an insurance seller re-keying the request, and give the actuarial and finance teams one consistent view of exposure and settled claims. Policy Data Management remains the system of record for policies during the transition, exposed through services rather than through green-screen re-keying, so the mainframe can be retired on its own timetable rather than as a precondition of better claims service.

## Success criteria

- Median first-notification-to-payment time for standard home and motor claims at or below five working days within two quarters of go-live, measured from the claims data mart.
- Claim re-key rate (a claim whose policy or item details are corrected after registration) below three percent.
- Ninety percent of new home and motor policies requested on the web or by telephone bound without seller re-keying.
- Claims payments released to the member's bank account within one working day of approval for ninety-five percent of approved claims.
- No increase in the fraud referral rate and no reduction in the audit trail available to Internal Audit, verified at the first post-go-live audit.
- Member satisfaction with the claims experience (post-settlement survey) improved from 6.1 to at least 7.5 out of 10.
