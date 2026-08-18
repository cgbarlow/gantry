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
