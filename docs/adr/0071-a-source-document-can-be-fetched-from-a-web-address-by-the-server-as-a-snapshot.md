# A Source document can be fetched from a web address, by the server, as a snapshot

Ticket #318. Builds on the Source document decisions from #245 (storage,
lifecycle, citing), #297 (Replaced and Out of date) and ADR-0067 (outside
agents held to the in-app rules). Grilled with the product owner on
2026-11-03.

v0.13.0 made Source documents files the architect uploads, and the user guide
promised that nothing is fetched from the internet: the browser reads every
document itself. Evidence often lives on a web page instead (a vendor's API
guide, a public standard, a requirements wiki), and saving it as a PDF by hand
loses where it came from. This changes that promise.

**Still a Source document, with an origin.** A page added by address is not a
new kind of thing. It is stored, listed, cited, renamed, removed, replaced and
flagged Out of date exactly like an upload. Its manifest entry also records its
**origin**: the address the architect gave, the final address after redirects,
and when it was fetched. The Sources appendix prints the title, the address and
"retrieved <date>" in place of the original filename and upload date.

**The Gantry server fetches; the browser still reads.** Browsers refuse most
cross-site fetches, so a browser-only fetch would fail on most pages. The
server fetches the bytes and hands them back, and the text is read in the
browser as for uploads. An HTML page is kept as its HTML and read to Markdown
with the Pandoc WASM build Gantry already ships. Images and scripts on the page
are not captured. The same 25 MB limit and file types apply, plus HTML. A local
workspace running with the server unreachable can't add by address.

**Private addresses are refused at every hop.** The server refuses private,
loopback and cloud-metadata addresses with the check the AI relay already uses,
lifted into one shared helper. Every redirect hop is checked, so a public page
can't bounce the server into its own network. An operator can allow private
addresses for Source documents with a setting of their own, separate from the
AI relay's `GANTRY_AI_ALLOW_PRIVATE_URLS`. Allowing an intranet wiki then never
opens the AI relay to the internal network, and allowing the relay never opens
Source documents. Pages behind a sign-in, a paywall or a VPN the server can't
reach are not supported. The fetch fails with a message saying to save the
page as a PDF and upload it. Gantry never takes an architect's cookies or
passwords for other sites.

**A snapshot, never a live link.** A citation must point at what the architect
actually read, so the fetched bytes are stored. **Fetch again** is a manual
action. If the bytes differ, it adds a new document that replaces the old one
(the existing Replaced rule), and the Fields that drew on it are flagged Out of
date. If they are identical, nothing is added or flagged, and the panel says
"unchanged since <date>". Nothing refetches on its own.

**On by default, and an operator can switch it off.** Add by address is
offered unless the operator turns it off with an environment variable, for a
locked-down deployment that must not make outbound requests on an architect's
behalf. Uploads are unaffected: they still never leave the machine to be read.

**Outside agents get the same.** Following ADR-0067, an MCP agent can add a
Source document by address under the same check, limits, off switch and Fetch
again behaviour.

## Considered options

- **Browser-only fetch:** no server involvement, but CORS blocks most sites.
- **A live link fetched on every read:** always current, but a citation could
  point at text that has since changed, and Out of date could never fire.
- **A PDF print of the page:** looks as it did, but needs a headless Chromium
  on every server.
- **Reusing the AI relay's private-address override:** one setting, but it
  would couple two unrelated exposures of the internal network.
