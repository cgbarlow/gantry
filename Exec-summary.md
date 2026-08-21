# Executive Summary
Contoso's current solution design process is scattered across up to 5 different documents across the solution lifecycle from idea to handover. It contains a lot of duplicated information, a lot of margin for human error, and a lot of unnecessary overhead.

We are building a proof of concept for a new design documentation pipeline to fix that. It is a first step towards Architecture as Code.

Gantry works from a Git repo. You write the design content once, in small pieces. Whatever a gate needs, a Solution on a Page, an HLD, a SAD, or As-built is built from those pieces on demand. There is one set of content, and the documents are just views of it.

Gantry knows nothing about design specifically. The process is set up in config, so the same approach works for anything with stages, gates and repeated content.