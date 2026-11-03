// #310 (map #238): the Source document pack of the bundled `kiwi-cover-mutual` example, made here so it can be made again.
// Every name, figure and date in it is fictitious. The documents are checked in under
// workspaces/examples/kiwi-cover-mutual/sources/; run `node scripts/example-evidence/build.mjs` to remake them.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spreadsheet, textPdf } from '../../tests/helpers/sourceFixtures.js'

/** The client brief, as a three-page PDF with a text layer. */
export function clientBriefPdf() {
  return textPdf([
    [
      'Kiwi Cover Mutual (KCM) - Claims handling modernisation',
      'Client brief',
      '',
      'Prepared by Hana Te Rangi, Head of Claims. 9 March 2026.',
      '(Fictitious example document, written for the Gantry example.)',
      '',
      '1. Why now',
      '',
      'A member who makes a straightforward home or motor claim waits a median of 12.4 working days',
      'from notification to payment. Members expect five.',
      '',
      'Every claim touches four separately operated systems: Policy Data Management on the',
      'mainframe, the CRM System, the Home & Away Financial Application and the document',
      'management system. A handler keys the claim into each of them.',
      '',
      'Around 18 percent of claims are re-keyed at least once.',
      'Only two contractors still hold mainframe skills, so the risk grows every year.',
      '',
      'The platform was inherited from the 2014 ArchiSurance merger and was never integrated.',
    ],
    [
      '2. What good looks like',
      '',
      '- Median notification-to-payment time for standard claims at or below five working days,',
      '  within two quarters of go-live.',
      '- Claim re-key rate below three percent.',
      '- Ninety-five percent of approved claims paid within one working day.',
      '- No increase in the fraud referral rate, and no loss of audit trail, checked at the first',
      '  post-go-live audit.',
      '',
      '3. Boundaries',
      '',
      '- Policy Data Management stays the system of record for policies and the claims ledger.',
      '- Claims data stays in New Zealand. Everything runs in the Wellington data centre; no cloud',
      '  landing zone is approved for member data yet.',
      '- The CRM System and the Financial Application are extended, not replaced.',
      '- Out of scope: underwriting, pricing and product configuration; broker, partner and mobile',
      '  channels; fraud analytics beyond the existing referral rules.',
    ],
    [
      '4. Timing and money',
      '',
      '- Three increments over about nine months: Register and Accept, then Valuate, then Pay.',
      '- The BIBIT payment gateway must go live within its current contract term.',
      '- Delivery is funded from the 2026 operating budget; there is no contingency for a',
      '  separate platform purchase.',
      '',
      '5. People',
      '',
      '- Sponsor and process owner: Hana Te Rangi, Head of Claims.',
      '- Delivery lead: Priya Natarajan, Solution Architect.',
      '- Treasury (BIBIT contract): Anaru Pihema.',
      '- Records Management (retention rules): Karen Doyle.',
      '- Privacy Office (member consent and PIA): Elena Rossi.',
      '',
      '6. What we are asking of the design',
      '',
      'One Handle Claim process on shared customer, policy and claim data, so a member reports a',
      'claim once and is paid the day it is approved.',
    ],
  ])
}

/** The requirements register, as a two-sheet workbook. */
export function requirementsRegisterXlsx() {
  return spreadsheet([
    {
      name: 'Requirements',
      rows: [
        ['ID', 'Requirement', 'Priority', 'Raised by'],
        ['R01', 'Register a claim once - on the web or by telephone', 'Must', 'Hana Te Rangi'],
        ['R02', 'Accept or decline a claim with the policy terms and member history visible', 'Must', 'Hana Te Rangi'],
        ['R03', 'Record a valuation and route complex claims to a senior handler', 'Must', 'Hana Te Rangi'],
        ['R04', 'Pay an approved claim within one working day', 'Must', 'Anaru Pihema'],
        ['R05', 'Show every claim document from the claim', 'Should', 'Karen Doyle'],
        ['R06', 'Take out insurance without re-keying', 'Should', 'Sophie Marsh'],
        ['R07', 'Record who changed a claim and when - kept for seven years', 'Must', 'Elena Rossi'],
      ],
    },
    {
      name: 'Volumes and targets',
      rows: [
        ['Measure', 'Value', 'Basis'],
        ['Claims a year', '38000', 'Claims volumes report FY2025'],
        ['Peak claims a day after a major weather event', '600', 'Claims volumes report FY2025'],
        ['Document growth a year', '90 GB', 'Records volumes report FY2025'],
        ['Registration response time at the 95th percentile', '3 seconds', 'Target assumption'],
        ['Availability of claim registration (service hours 07:00-21:00)', '99.9 percent', 'Target assumption'],
        ['Recovery time objective for the shared services', '4 hours', 'Target assumption'],
        ['Recovery point objective for claim data', '15 minutes', 'Target assumption'],
      ],
    },
  ])
}

/** The workshop notes, as a Word document. */
export function workshopNotesDocx() {
  const markdown = `# Claims design workshop - notes

16 March 2026, Wellington. Notes by Priya Natarajan. (Fictitious example document, written for the Gantry example.)

Present: Priya Natarajan (Solution Architect), Hana Te Rangi (Claims Operations), Derek Fong (Mainframe Integration), Anaru Pihema (Treasury), Karen Doyle (Records Management), Elena Rossi (Privacy Office).

## Decisions

1. **Shared services, not point-to-point.** Customer and claim data is served by two new shared services, the Customer Information Service (CIS) and the Claims Information Service (Claims InfoServ). Every application calls them; none copies the data.
2. **Policy Data Management stays the system of record.** The mainframe exposes four CICS transactions (PDM-01 to PDM-04) as services. Nothing moves off the mainframe in this work.
3. **Two exposures a window.** Derek's team can expose two CICS services in each monthly change window, so the first two transactions are ready for increment 1.
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
`
  const dir = mkdtempSync(join(tmpdir(), 'gantry-example-pack-'))
  try {
    writeFileSync(join(dir, 'notes.md'), markdown)
    execFileSync('pandoc', [join(dir, 'notes.md'), '-o', join(dir, 'notes.docx')], { stdio: ['ignore', 'ignore', 'ignore'] })
    return new Uint8Array(readFileSync(join(dir, 'notes.docx')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const SCREEN_HTML = `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; background: #1b1f1b; font-family: "DejaVu Sans Mono", Menlo, Consolas, monospace; color: #7dff8a; }
  .screen { width: 880px; padding: 22px 28px 26px; box-sizing: border-box; }
  .bar { background: #7dff8a; color: #0b130c; padding: 4px 10px; font-weight: bold; letter-spacing: .04em; }
  .row { display: flex; gap: 16px; margin: 7px 0; font-size: 15px; }
  .row label { width: 250px; color: #4fc75b; }
  .row span { border-bottom: 1px solid #3a8a42; min-width: 300px; padding: 0 4px; }
  .note { margin-top: 18px; font-size: 13px; color: #c9ffd0; border: 1px dashed #4fc75b; padding: 8px 10px; }
  .foot { margin-top: 14px; font-size: 12px; color: #4fc75b; }
</style>
<div class="screen">
  <div class="bar">PDM-CLM  POLICY DATA MANAGEMENT - CLAIM ENTRY (1 OF 4 SCREENS)</div>
  <div class="row"><label>POLICY NUMBER</label><span>HA-0000417</span></div>
  <div class="row"><label>POLICYHOLDER</label><span>SAMPLE MEMBER (TEST DATA)</span></div>
  <div class="row"><label>DATE OF LOSS</label><span>2026-02-11</span></div>
  <div class="row"><label>LOSS TYPE</label><span>HOME - STORM DAMAGE</span></div>
  <div class="row"><label>CONTACT PHONE</label><span>021 555 0100</span></div>
  <div class="row"><label>CLAIM REFERENCE</label><span>(ASSIGNED ON SAVE)</span></div>
  <div class="note">Handler note: customer details above are keyed again in the CRM System, the Financial Application and the document management system.</div>
  <div class="foot">PF3=EXIT  PF5=NEXT SCREEN  PF12=CANCEL &nbsp;&nbsp; Fictitious mock-up made for the Gantry example. No real member data.</div>
</div>`

/** A fictitious screenshot of the current claim registration screen, drawn in a headless browser. */
export async function claimScreenPng() {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 880, height: 320 } })
    await page.setContent(SCREEN_HTML)
    return new Uint8Array(await page.screenshot({ clip: { x: 0, y: 0, width: 880, height: 320 } }))
  } finally {
    await browser.close()
  }
}
