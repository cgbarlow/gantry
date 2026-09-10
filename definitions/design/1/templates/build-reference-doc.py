#!/usr/bin/env python3
"""
Regenerates reference.docx from the real HLD template plus pandoc's own
default reference doc.

Pandoc's docx writer emits paragraphs styled by name (e.g. "Compact" for
tight list items) without embedding a definition for them — normally
that's fine because pandoc's *default* reference.docx already defines
those styles. Swapping in a real, hand-authored Word template as
--reference-doc drops any of pandoc's auxiliary styles the template
never had a reason to define. The visible symptom: bulleted lists render
with no bullet or indent at all, because (at least in LibreOffice) an
unresolvable w:pStyle reference suppresses the paragraph's direct-
formatted numbering too, not just the style-level formatting.

Fix: keep the HLD template's own styles (fonts, headings, margins) as
the base, and copy over only the styles pandoc defines that the HLD
template doesn't already have one named the same.

Usage:
    python3 build-reference-doc.py <source-hld.docx> <output-reference.docx>

Post-WI153: the `design` definition no longer shares one `reference.docx`
across all five artefacts. The render pipeline (lib/render.js) resolves
the reference doc by artefact first (`reference-<artefact>.docx`) with a
fallback to `reference.docx`. `reference-hld.docx` retains the original
TAC footer ("Technical Architecture Committee – High Level Solution
Design") — correct for HLD. `reference-soap.docx` and
`reference-as-built.docx` have that committee line removed (no committee
footer — SOAP is Business Case, as-built is "for noting"). `reference-sad.docx`
and `reference-ssad.docx` are also stripped of the HLD footer but kept
as distinct files with a placeholder comment pending the ARB/TAC vs
Design Authority decision — so that decision can land as a docx-only
edit without further code changes.

Post-WI363: `reference-soap-full.docx` is a byte copy of
`reference-soap.docx` — the Full SOAP is the same document family as the
SOAP, so it gets the same neutral footer. It exists as its own file
because the fallback is not a safe default: before it existed, the Full
SOAP fell through to `reference.docx` and inherited the TAC footer. The
definition-level `reference.docx` has since had that committee line
stripped too, so the fallback is now neutral rather than wrong. Every
artefact must still ship its own `reference-<artefact>.docx`;
`tests/referenceDocFooter.test.js` fails the build if one is missing, or
if any artefact's footer names a committee it doesn't go to.

To regenerate after updating the source HLD template:
    python3 build-reference-doc.py <source-hld.docx> definitions/design/templates/reference.docx
    # then re-derive the artefact variants (see inline patch_footer in the
    # WI153 fix commit for the footer-stripping logic, or simply re-run the
    # generation snippet from that commit's message).
"""

import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
ET.register_namespace("w", W[1:-1])


def style_ids(styles_xml_bytes):
    root = ET.fromstring(styles_xml_bytes)
    return {s.get(f"{W}styleId"): s for s in root.findall(f"{W}style")}


def main(source_path, output_path):
    with tempfile.TemporaryDirectory() as tmp:
        pandoc_default = Path(tmp) / "pandoc-default-reference.docx"
        subprocess.run(
            ["pandoc", "-o", str(pandoc_default), "--print-default-data-file", "reference.docx"],
            check=True,
        )

        with zipfile.ZipFile(pandoc_default) as z:
            pandoc_styles = style_ids(z.read("word/styles.xml"))

        with zipfile.ZipFile(source_path) as z:
            source_styles_xml = z.read("word/styles.xml").decode("utf-8")
        source_style_ids = set(style_ids(source_styles_xml.encode("utf-8")))

        missing = [
            styleId
            for styleId in pandoc_styles
            if styleId not in source_style_ids
        ]
        missing_xml = "".join(ET.tostring(pandoc_styles[s], encoding="unicode") for s in missing)

        assert "</w:styles>" in source_styles_xml
        patched_styles_xml = source_styles_xml.replace("</w:styles>", missing_xml + "</w:styles>")

        shutil.copyfile(source_path, output_path)
        # zipfile can't update one member of an existing archive in place;
        # rewrite the whole archive, copying every part through unchanged
        # except the patched styles.xml.
        with zipfile.ZipFile(source_path) as src, zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as dst:
            for item in src.infolist():
                data = patched_styles_xml.encode("utf-8") if item.filename == "word/styles.xml" else src.read(item.filename)
                dst.writestr(item, data)

        print(f"Copied {len(missing)} missing style(s) from pandoc's default reference doc: {', '.join(missing)}")
        print(f"Wrote {output_path}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])
