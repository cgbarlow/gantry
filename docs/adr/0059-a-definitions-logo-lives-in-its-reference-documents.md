# A Definition's logo lives in its reference documents

Ticket #222. Follows ADR-0056 (Word formatting lives in the reference
document, never post-processed), ADR-0035 and ADR-0036 (each organisation
keeps its own copy of a Definition).

The logo in design v3's page header, the Contoso logo, is a picture inside
each Artefact's reference document: seven identical copies in v3. The only
way to change it was to download each reference document, swap the picture
in Word and upload it again under **Reference docx**, seven times. Any
document missed still showed Contoso.

## Decision

1. **The logo stays a picture in the reference documents.** There is no
   separate logo setting and no render-time step. A render takes its headers
   from the reference document, as for everything else about a document's
   look, so ADR-0056 holds unchanged on every render path.

2. **One upload on the Definitions page writes it into all of them.** The
   **Logo** control on a draft Definition replaces the header picture in every
   reference document of that version, the shared `reference.docx` and each
   `reference-<artefact>.docx`, when the image is uploaded. It accepts a PNG
   or JPEG, judged by its bytes. A Local Workspace's Definition editor has the
   same control over its own `templates/` folder (`web/lib/definitionLogo.js`
   serves both).

3. **The logo is found by where it is.** Every picture in a header part is the
   logo, whatever it is called. A reference document whose header has no
   picture is left as it is, and the control names it.

4. **The new logo keeps its proportions in the old one's space.** It is scaled
   to fit, without stretching, inside the box the old picture took up in the
   header. That box is recorded beside the picture (an ignorable `a:extLst`
   extension on its `wp:docPr`), so replacing the logo again fits the next one
   to the original space, not to the previous logo's shape. Its alt text
   becomes "Organisation logo". Nothing else in the package changes.

5. **A reference document uploaded later wins.** The logo is applied once, at
   upload. A reference document uploaded afterwards under **Reference docx**
   keeps whatever logo it carries, and nothing reapplies the Logo control's
   image over it.

6. **Contoso stays as design v3's default logo.** No placeholder image is
   shipped.

## Alternatives rejected

- **A logo per Instance.** Every render path would need a render-time step:
  handing Pandoc a copy of the reference document with that Instance's logo in
  it, and storing the image with each Instance. That is real work for a
  multi-client case nobody has. A Definition is already per organisation: each
  organisation keeps its own copy (ADR-0035, ADR-0036), so one logo per
  Definition is one logo per organisation.
- **A deployment-wide logo.** The same commit would render differently
  depending on which server rendered it, and a Definition promoted to a library
  repo would lose its logo on the way.

## Consequences

- Changing the logo is one upload per draft. A published version shows it with
  Download only, like its reference documents.
- The logo travels with the reference documents through new draft, clone,
  promote and the Library cache, because they copy those files.
- A render of a Local Workspace's own Definition now sends an Artefact
  without its own reference document the shared `reference.docx`, as a
  render on disk already uses it. Before, it got Pandoc's default, so a logo
  replaced in the shared document would never have shown.
- A reference document with a picture in its header for some other reason
  (a watermark, say) has that picture replaced too. A picture inside a group
  or shape is not the logo and is left alone.
- The replacement works on one reference document's bytes and returns new
  ones (`replaceHeaderLogo` in `web/lib/definitionLogo.js`), so if a
  per-Instance logo is ever wanted it can be applied to a copy at render time
  without writing to the Definition.
