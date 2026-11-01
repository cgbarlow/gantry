# How the AI reads Source documents, and how much fits in context

Research for [#240](https://github.com/cgbarlow/gantry/issues/240), part of map [#238](https://github.com/cgbarlow/gantry/issues/238) (v0.13.0 AI interview). Researched 2026-11-01.

**Question.** How should Gantry (a Node ≥24 server plus a vanilla-JS ES-module web app) read each Source document format: PDF, Word, Markdown, text, images, spreadsheets, PowerPoint? Which formats should be turned into text in Node, and which sent to the model as they are? How big are the context windows across the AI Provider types? Can a whole 10–30-document design pack go into context, or is retrieval needed? What does prompt caching offer for a long, multi-turn interview?

Every claim below links to its source. Where a claim comes from a hands-on test in this session, it is marked **(tested)** and the test is described in [Appendix A](#appendix-a--hands-on-tests).

---

## TL;DR

| Format | Recommendation |
|---|---|
| Markdown, text (`.md`, `.txt`, other text) | Read as UTF-8 and send as text. |
| CSV / TSV | Read as UTF-8 and send as text, capping rows per file. |
| Word (`.docx`) | Extract to Markdown in Node. No provider takes `.docx` natively on the API surface Gantry will use. |
| PowerPoint (`.pptx`) | Extract to Markdown in Node, **including speaker notes**. |
| Spreadsheets (`.xlsx`) | Extract to Markdown tables in Node, one section per sheet, capping rows per sheet. |
| PDF | Extract text in Node by default. Send the PDF natively to the model only when the text layer is near-empty (a scan), or when the architect marks the file as visual, *and* the provider accepts PDFs (Anthropic, OpenAI, OpenRouter). |
| Images (PNG/JPEG/GIF/WebP) | Send natively to vision-capable models. With a text-only model, leave the image out and tell the AI it is missing. SVG is sent as text. |

- **Library:** one extractor seam, backed by [`officeparser`](https://github.com/harshankur/officeParser) (MIT). It covers docx, pptx (with notes), xlsx, PDF, odt/odp/ods, rtf and csv in a single dependency, and it runs in Node and in the browser. Configure it with `allowRemoteAssets: false` and local pdf.js paths. The fallback is the `pandoc-wasm` Gantry already ships (it reads docx, pptx and xlsx, but not PDF, and it drops speaker notes) plus [`unpdf`](https://github.com/unjs/unpdf) (MIT) for PDF.
- **Context fit:** a realistic 10–30-document pack is about **100k–350k tokens as extracted text** (see the estimate in [§4](#4-will-a-design-pack-fit)). That fits in the 1M-token windows of current Anthropic and OpenAI models. It does not fit a 200k window at the top of that range. It never fits the 4k–32k context that Ollama and LM Studio give by default. Sending every PDF natively costs several times (roughly 3–10×) the tokens per page and runs into the 100- or 600-page cap per request. Default to text.
- **Strategy:** use a budget check, not a vector store. If the pack's text fits within about half the model's window, put the whole pack in a cached prefix. If it does not, put a *catalogue* in the prefix (each document's title, type, size and heading outline) and give the AI a `read_source_document(id, section/page range)` tool. Retrieval with embeddings is not needed for v0.13.0.
- **Prompt caching:** this is what makes whole-pack-in-context affordable. On Anthropic, cache reads cost 0.05–0.1× the input price. A 1-hour TTL suits an interview where the architect thinks between question cards. OpenAI caches automatically: GPT-5.6+ reads at 0.1× and writes at 1.25×, with a 30-minute default. A worked example: a 300k-token pack over a 40-turn interview on Claude Opus 5.5 costs about $48 of input without caching and about $4–6 with it.

---

## 1. What each AI Provider type accepts natively

### Anthropic (Messages API)

- **PDF.** Sent as a `document` content block, by base64 or by Files API `file_id`. "The system converts each page of the document into an image" and "the text from each page is extracted and provided alongside each page's image." Limits: 128 MB per request on the first-party API, and "600 [pages] (100 when the request's context window is under 1M tokens)". Cost: text "typically uses 1,500–3,000 tokens" per page, *plus* the image cost of every page. ([PDF support](https://platform.claude.com/docs/en/build-with-claude/pdf-support))
- **Office files are not accepted.** "Binary formats such as .xlsx or .docx are not supported in document blocks, so convert them to text or PDF first." Plain text files can go in document blocks. ([PDF support](https://platform.claude.com/docs/en/build-with-claude/pdf-support))
- **Images.** JPEG, PNG, GIF and WebP only. Up to 600 images per request (100 on 200k-window models). Each image may be at most 8000×8000 px and 10 MB base64 (5 MB on Bedrock). In a request with more than 20 images, keep each one at or below 3,000 px per side. Cost is `⌈w/28⌉ × ⌈h/28⌉` visual tokens, capped at 4,784 per image on Claude 4.7 and later (long edge 2,576 px) and 1,568 on older models. ([Vision](https://platform.claude.com/docs/en/build-with-claude/vision))
- **Context.** Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1 all have a 1M-token window, and "1M is the default: you don't need a beta header". Long-context requests are billed at standard pricing, except on Haiku 5.5, which costs more above 100k tokens. Older models such as Sonnet 4.5 have 200k. ([Context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows), [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview))
- **Context rot.** "As token count grows, accuracy and recall degrade, a phenomenon known as *context rot*. This makes curating what's in context just as important as how much space is available." ([Context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows))

### OpenAI

- **Chat Completions accepts only PDF as a file.** It "accepts only PDF files as `file` content parts" (via `file_data` or `file_id`; `file_url` is not supported). For anything else: "read the file in your application and send its contents as a `text` content part." ([PDF files](https://developers.openai.com/api/docs/guides/pdf-files))
- **The Responses API** also takes docx, pptx, xlsx and csv as `input_file`. It extracts text only and does not pull out embedded images or charts. For spreadsheets it "parses up to the first 1,000 rows per sheet". Each file must be under 50 MB, with 50 MB in total per request. With PDFs, vision-capable models receive extracted text plus page images. ([PDF files](https://developers.openai.com/api/docs/guides/pdf-files))
- **Context.** The current flagship models (GPT-6 Astra, GPT-6.1 Sol/Terra, GPT-6 Luna) have a 1.05M-token window and 128K max output. ([Models](https://developers.openai.com/api/docs/models))

Iris's OpenAI-compatible client is Chat Completions, and OpenAI-compatible servers implement the Chat Completions shape. So the lowest common denominator for Gantry is Chat Completions. A Responses-only path would cover just one of the six provider types.

### OpenRouter

- PDFs go in as a `file` content part on Chat Completions. If no engine is set, OpenRouter "uses the model's native file processing when the model supports it. Otherwise it falls back to `"mistral-ocr"`", which is billed at "$2 per 1,000 pages" **to the OpenRouter account, even for BYOK**. A free `cloudflare-ai` engine converts PDF to Markdown. ([OpenRouter PDFs](https://openrouter.ai/docs/guides/overview/multimodal/pdfs))
- So if Gantry sends a PDF natively through OpenRouter, it should set the `pdf` engine explicitly. That keeps a surprise OCR charge off the architect's bill.

### Ollama

- The OpenAI-compatible `/v1/chat/completions` supports text, arrays of content parts and **base64 images**. It does not support image URLs, and file parts are not documented. "The OpenAI API does not have a way of setting the context size for a model." The only route is a Modelfile with `PARAMETER num_ctx`. ([Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility))
- **Default context depends on VRAM.** It is "< 24 GiB VRAM: 4k context", "24-48 GiB VRAM: 32k context" and ">= 48 GiB VRAM: 256k context". `OLLAMA_CONTEXT_LENGTH` overrides it. ([Ollama context length](https://docs.ollama.com/context-length))

### LM Studio

- Serves `/v1/chat/completions` ("text and images"), `/v1/responses` and others at `http://localhost:1234/v1`. ([LM Studio OpenAI compat](https://lmstudio.ai/docs/developer/openai-compat))
- Context length is set when the model is loaded (`lms load --context-length`). ([lms load](https://lmstudio.ai/docs/cli/load)) I could not find the default value in LM Studio's own docs. Third-party guides say 2k–4k; that is **unverified**.

### Custom OpenAI-compatible

- Assume only Chat Completions with text. Images work only if the model is vision-capable. Gantry cannot know a custom endpoint's capabilities, so it needs a per-provider setting such as "this model accepts images / PDFs" (Iris's settings UI has a Test button; this would sit beside it).

### Consequence

Office formats must be turned into text by Gantry in every case: no provider type takes them natively on Chat Completions. Native PDF input is available for 3 of the 6 types (Anthropic, OpenAI, OpenRouter), and costs more there. Native images work on any vision-capable model. So **text extraction in Node is the backbone, and native input is an upgrade path** for scans, diagrams and images.

---

## 2. Node extraction libraries

Gantry today depends on `pandoc-wasm@1.1.0`, which is pandoc 3.10 compiled to WASM. Its licence is **GPL-2.0-or-later** ([package.json](../../package.json); `node_modules/pandoc-wasm/package.json`). It has no PDF, Office-reading or image library.

| Library | Licence | Latest release | Formats | Notes |
|---|---|---|---|---|
| [`officeparser`](https://github.com/harshankur/officeParser) 8.5.0 | MIT | 2026-10-31 | docx, pptx, xlsx, odt/odp/ods/odg, pdf, rtf, csv, md, html, epub, tex | Parses to an AST and outputs Markdown or text. Runs in Node and the browser. Speaker notes, footnotes, comments and headers/footers are on by default (`ignoreNotes` etc.). PDF structure (headings, tables, columns) is recovered from tags or geometry. OCR via tesseract.js is optional and off by default. Built-in zip-bomb limits (`decompressionLimits`). One maintainer, fast release cadence (v8). Hard dependencies: `pdfjs-dist`, `tesseract.js`, `fflate`, `@xmldom/xmldom`, `file-type`. About 145 MB installed in the test: officeparser 35 MB, pdfjs-dist 35 MB, tesseract.js-core 44 MB, and pdf.js's optional native `@napi-rs/canvas` 31 MB (**tested**). **By default it fetches the pdf.js worker, CMaps and Tesseract files from jsDelivr**; `allowRemoteAssets: false` blocks this ([README](https://www.npmjs.com/package/officeparser)). |
| [`pandoc-wasm`](https://github.com/pandoc/pandoc-wasm) 1.1.0 (already a dependency) | GPL-2.0-or-later | 2026-06-11 | Reads docx, pptx, xlsx, csv, tsv, odt, rtf, html and more. **No PDF input** ([pandoc manual](https://pandoc.org/MANUAL.html)) | Works in Node through `src/index.node.js` (**tested**). About 1.4 s cold start; docx→gfm in about 1.5 s. Drawbacks found in testing: **drops pptx speaker notes**, **drops xlsx inline-string cells** (only shared strings are read), and prints integers as `1200.0`. |
| [`unpdf`](https://github.com/unjs/unpdf) 2.1.0 | MIT | 2026-10-30 | PDF text | UnJS project wrapping a serverless pdf.js build, `engines: node >=24`. Gives flat text with no structure. Labels inside diagrams come out jumbled (**tested**). |
| [`pdfjs-dist`](https://github.com/mozilla/pdf.js) 6.5.438 | Apache-2.0 | 2026-11-01 | PDF | Mozilla's own library; the underlying engine of every Node PDF option here. Low-level. |
| [`pdf-parse`](https://github.com/mehmet-kozan/pdf-parse) 2.4.5 | Apache-2.0 | 2025-10-20 | PDF text | Pins an older `pdfjs-dist` 5.4. Superseded by the options above. |
| [`mammoth`](https://github.com/mwilliamson/mammoth.js) 1.13.0 | BSD-2-Clause | 2026-09-26 | docx | Good docx→HTML. Its Markdown output escapes heavily and flattens tables into one cell per line (**tested**). |
| SheetJS `xlsx` | Apache-2.0 | npm copy 0.18.5 from **2022-03-24** | xlsx/xls | The npm registry copy is stale: "the registry is out of date… The latest version on that registry is 0.18.5". The current release (0.20.3) is only on cdn.sheetjs.com ([SheetJS docs](https://docs.sheetjs.com/docs/getting-started/installation/nodejs)). Avoid. |
| [`exceljs`](https://github.com/exceljs/exceljs) 4.4.0 | MIT | 2023-10-19 | xlsx | No release in 3 years. Avoid. |
| [`read-excel-file`](https://gitlab.com/catamphetamine/read-excel-file) 9.3.14 | MIT | 2026-10-29 | xlsx | Active, small. Spreadsheets only. |

Release dates and licences come from `npm view <pkg> --json` (`time[version]`, `license`), queried 2026-11-01.

### Recommendation

- Put **one module behind one seam**: `extractSourceDocument(bytes, filename) → { markdown, pageCount, charCount, estimatedTokens, sparseTextLayer, truncated, warnings }`. Use **officeparser** for docx, pptx, xlsx and PDF.
  - Pin an exact version. It is moving fast and has one maintainer.
  - Set `allowRemoteAssets: false` and point `pdfWorkerSrc`, `pdfCMapUrl` and `pdfDecoderUrl` at the files under `node_modules/pdfjs-dist`. Gantry must not reach out to a CDN while it reads a client's documents.
  - Leave `ocr: false`. OCR is a later upgrade; scans go to the model natively instead (see §3).
- **Licence posture:** officeparser and its tree (MIT, Apache-2.0) fit Gantry's MIT licence cleanly. If officeparser's weight or its single maintainer is unacceptable, the fallback is `pandoc-wasm` for docx and xlsx (licence already accepted), `unpdf` for PDF, and a small handwritten pptx notes reader. The fallback has the gaps listed above.
- **Where it runs:** both officeparser and pandoc-wasm also run in the browser. For local (client-filesystem) workspaces, the browser can extract and send text, so no file bytes go to the server. For server and remote workspaces, `gantry serve` extracts in Node. The seam makes the location a deployment detail.
- **Cache extraction by content hash.** A 289-page PDF takes about 9 s (**tested**). Whether the extracted Markdown is committed next to the Source document, which would make citations stable and let every workspace kind reuse it, is a storage decision for another ticket.

---

## 3. Per-format recommendation

| Format | How | Why |
|---|---|---|
| **Markdown, text** | UTF-8 as is. | Already text. Iris does the same ([extract.py](https://github.com/cgbarlow/iris/blob/main/backend/app/ai/extract.py)). |
| **CSV / TSV** | UTF-8 as is, with a row cap (e.g. 1,000 rows, as OpenAI uses) and a truncation note. | CSV is denser than a Markdown table. |
| **Word** | officeparser → Markdown. Keep headings, tables, footnotes and comments. | No native docx on Chat Completions. Anthropic says to "convert them to text or PDF first". Headings give the catalogue its outline and give citations a section anchor. |
| **PowerPoint** | officeparser → Markdown, one section per slide, **speaker notes included** (**tested**: notes kept; pandoc drops them). | In decks, much of the meaning sits in the notes. |
| **Spreadsheets** | officeparser → one Markdown table per sheet, row cap per sheet. Use cached formula values, not formulas. | Matches OpenAI's own approach (first 1,000 rows per sheet). In the **tested** minimal workbook, sheet names did not appear in the Markdown, so check this against a real Excel file and prepend `## Sheet: <name>` if needed. |
| **PDF (text layer)** | officeparser → Markdown, page-numbered. | 1,500 chars/page on a 289-page book is about 600 tokens/page as text (**tested**). Native costs 1,500–3,000 text tokens *plus* up to 4,784 image tokens per page (docs, §1). Text is therefore roughly 3–10× cheaper and works with every provider. |
| **PDF (scanned or near-empty text layer)** | If text is below roughly 100 chars/page and the provider accepts PDFs (Anthropic, OpenAI, OpenRouter with an explicit engine), send natively. Otherwise flag it: "this document has no readable text with this AI Provider." | **Tested**: a 4-page scanned spec yields 2 characters from unpdf and 181 from officeparser. Text extraction gets nothing, while vision gets everything. |
| **PDF (diagram-heavy, architect's choice)** | An optional per-document "read visually" toggle, sent natively. | Labels inside diagrams come out of text extraction jumbled ("Step Step Step Outcome…", **tested**). |
| **Images** | Native image block or part (base64), for vision-capable models only. With a text-only model, leave the image out and add a catalogue entry saying it could not be read. SVG goes as text (it is XML). HEIC, TIFF and BMP are not supported formats ([Vision](https://platform.claude.com/docs/en/build-with-claude/vision)): reject them at upload or convert them. Downscaling is optional because the API resizes. Keep images ≤ 3,000 px per side when there are more than 20 in a request. | There is no text to extract; OCR would lose the diagram. Ollama needs base64, not URLs. |
| **Images embedded in Office files** | Out of scope for v0.13.0 (text only, as OpenAI's Responses API does). Later, officeparser's `extractAttachments` can forward selected images. | Keeps v0.13.0 small. |

---

## 4. Will a design pack fit?

### Token arithmetic

Anthropic gives this conversion for the current tokenizer: "1M tokens is roughly 555k words or 2.5M Unicode characters". That is about **2.5 characters per token** ([Models overview](https://platform.claude.com/docs/en/about-claude/models/overview)). Measured sizes (**tested**):

| Sample | Extracted text | ≈ tokens (2.5 chars/token) |
|---|---|---|
| Gantry-rendered SAD (`.docx`) | 35–38k chars | ~15k |
| Gantry-rendered SOAP (`.docx`) | 6–7k chars | ~3k |
| Text PDF, 289 pages | 434–443k chars (≈1,500/page) | ~175k (≈600/page) |

### A realistic 30-document pack (estimate)

The per-document sizes below are assumptions extrapolated from the measured samples. They are not measurements.

| Kind | Count | Assumed size | ≈ tokens |
|---|---|---|---|
| Word design docs (SAD, HLD, standards) | 8 | ~15k each | 120k |
| PDFs (vendor specs, policies), ~20 pages | 8 | ~12k each | 96k |
| Slide decks, ~30 slides with notes | 5 | ~4k each | 20k |
| Spreadsheets (requirements, costs) | 4 | ~15k each | 60k |
| Images / diagrams | 5 | ~3k each (native) | 15k |
| **Total** | **30** | | **≈ 310k** |

A 10-document pack is about **100k tokens**. The range in the TL;DR (100k–350k) leaves room for denser documents.

### Verdict by AI Provider type

| Provider / model class | Window | 10-doc pack (~100k) | 30-doc pack (~310k) |
|---|---|---|---|
| Anthropic current (Opus/Sonnet/Haiku 5.5, Fable 5.1) | 1M | Fits easily | Fits; about 1/3 of the window |
| OpenAI current (GPT-6 / 6.1) | 1.05M | Fits easily | Fits |
| Older 200k models (e.g. Sonnet 4.5) | 200k | Fits, tight | **Does not fit** |
| OpenRouter | Whatever the routed model has | Depends | Depends |
| Ollama default | 4k / 32k / 256k by VRAM | **No** / **No** / fits | **No** / **No** / tight |
| LM Studio | Set at model load; small by default (unverified) | Usually **no** | **No** |

**If every PDF were sent natively**, the pack's 8×20 = 160 PDF pages alone would cost about 160 × (1.5–3k text + 1.5–4.8k image) ≈ **0.5–1.2M tokens**. That alone fills a 1M window, and at 30 large PDFs it would exceed the 600-page cap. Native PDF must stay the exception.

**Context rot.** Even when the pack fits, more context is "not automatically better" (§1). Putting the whole pack into the prompt for every stage is the simple v0.13.0 approach. Per-stage curation, where only the documents relevant to the stage being drafted go in, can come later.

### Strategy: a budget check, then whole-pack or catalogue-plus-tool

1. **Measure.** Each Source document's `estimatedTokens` comes from the extractor: chars ÷ 2.5 for text, plus the documented image formula for native images. For Anthropic, the [token counting API](https://platform.claude.com/docs/en/build-with-claude/token-counting) gives an exact figure.
2. **Whole pack** (sum ≤ about 50% of the model's window, leaving room for system prompt, tools, the growing conversation and 128k output): put every document in one stable, cached prefix, each wrapped with its id and title so question cards can cite it.
3. **Catalogue + read tool** (pack too large, or a small local model): the prefix carries a catalogue (id, title, type, page or slide count, heading outline, token size), and the AI calls `read_source_document(id, range)` to pull sections on demand. The interview already needs tool use for question cards, so this adds no new capability requirement. This is also how small-context local models can take part at all.
4. **No embeddings or vector store in v0.13.0.** A design pack is tens of documents with good headings. An outline plus targeted reads is enough, and it avoids adding an embedding provider to every AI Provider type.

Ollama's OpenAI endpoint cannot raise `num_ctx` per request (§1), so Gantry cannot fix a small local window itself. The provider settings should show the configured or assumed window and let the architect override it. Below some floor (e.g. 32k), Gantry should warn that the interview will be catalogue-only.

---

## 5. What prompt caching offers

### Anthropic ([Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [Pricing](https://platform.claude.com/docs/en/about-claude/pricing))

- **What it does.** It caches the prefix in the order `tools` → `system` → `messages`, up to a `cache_control` breakpoint. **Automatic caching** is one top-level `cache_control` that "moves [the breakpoint] forward as conversations grow". That fits a multi-turn interview exactly: each turn reads the earlier turns from cache.
- **What can be cached.** Explicitly: "Images and documents: Content blocks in the `messages.content` array, in user turns", plus tools and system prompt. Up to 4 breakpoints.
- **TTL.** 5 minutes by default, refreshed free on each hit. 1 hour is available with `"ttl": "1h"`.
- **Price.** 5-minute writes cost 1.25× input and 1-hour writes 2×. Reads cost 0.1×, or **0.05× on Opus 5.5 and Sonnet 5.5** (0.025× on Fable/Mythos 5.1). For Opus 5.5: input $4, 5m write $5, 1h write $8, read $0.20 per MTok.
- **Minimum.** 512 tokens on current models. A pack is far above this.
- **Effect on context.** "Cached prompt prefixes still occupy the context window: prompt caching changes what you pay for those tokens, not whether they count." ([Context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows))

### OpenAI ([Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching))

- "Enabled by default for supported OpenAI models." The minimum cacheable prompt is 1,024 tokens on GPT-5.6+.
- **GPT-5.6+.** Reads cost 0.1× (0.05× on GPT-6.1 Sol/Terra) and writes 1.25× for the default 30-minute TTL, or 2.5× for 12 hours (12h is Responses API only). Explicit breakpoints are supported.
- **Earlier models.** Caching is implicit, with no write charge and `in_memory` or `24h` retention.
- **Guidance.** "Put stable developer instructions and shared reference material first", and put dynamic content at the end.

### OpenRouter, Ollama, LM Studio, custom

- OpenRouter passes caching through to the underlying provider. I did not verify the exact pass-through mechanics; check them when building.
- For local servers no billed caching applies. Any reuse of the processed prompt is server-internal and not documented on the pages consulted.

### Worked example: Claude Opus 5.5, 300k-token pack, 40 turns

These figures cover the pack prefix only. The conversation itself adds a growing, also-cached tail.

| Approach | Pack input cost |
|---|---|
| No caching: 40 × 300k × $4/MTok | **≈ $48** |
| 5m cache, architect always replies within 5 min: 1 write ($1.50) + 39 reads ($2.34) | **≈ $3.84** |
| 5m cache, the cache lapses on ~1/3 of turns: 14 writes ($21) + 26 reads ($1.56) | **≈ $22.56** |
| 1h cache: 1–2 writes ($2.40 each) + reads ($0.20/MTok × 300k ≈ $0.06/turn) | **≈ $4.70–$7.10** |

**Recommendation.**

- **Prefix order:** system prompt and interview instructions, then tool definitions (question card, read_source_document, save stage), then the Source documents block (or catalogue), then the Instance's current module content, then the conversation.
- **Breakpoints:** put an explicit breakpoint with a **1-hour TTL** at the end of the Source documents block, and use automatic caching for the conversation tail. The architect stops to think between cards, so the 5-minute default will often lapse.
- **Order matters:** anything that changes per turn, such as the current stage or module drafts the AI just wrote, goes *after* the documents. Otherwise it would invalidate the documents cache.
- **Cache hits also cut time-to-first-token on every turn.** Waiting on a question card is the interview's main latency.
- **Usage:** cache usage is reported per response (`cache_creation_input_tokens`, `cache_read_input_tokens`; `cached_tokens` on OpenAI). That feeds the "Cost & usage visibility" item still open on the map.

---

## 6. Open points handed on

- **Storage:** whether extracted Markdown is committed next to each Source document (stable citations, reuse across workspace kinds) or cached only. This belongs to the Source document storage decision.
- **Capability flags:** a per-AI-Provider setting for "accepts images / accepts PDFs / context window", with sensible defaults per provider type. Custom endpoints and local models cannot be detected.
- **Cost surfacing:** the per-document token estimate and the cache usage fields above feed the map's "Cost & usage visibility" item.
- **Re-running:** a content-hash change on a Source document is the natural trigger for "sources changed since drafting" (map item "Re-running").

---

## Appendix A — hands-on tests

All tests ran on 2026-11-01 under Node 24 in a scratch directory, not in the Gantry repo.

1. **pandoc-wasm in Node.** `node_modules/pandoc-wasm/src/index.node.js` reports pandoc **3.10**. Its input formats include `docx pptx xlsx csv tsv odt rtf` and **no `pdf`**. A pptx generated by pandoc from Markdown with a `::: notes` block was read back to gfm: slide titles, bullets and table were kept, and **the speaker note was dropped**, although the note text was confirmed present in `ppt/notesSlides/notesSlide1.xml`. A hand-built xlsx with **inline strings** came back with empty text cells. Rebuilt with a **shared-strings** table (what Excel writes), it came back correct, with numbers as `1200.0`. A Gantry-rendered SOAP `.docx` converted cleanly to gfm with tables in about 1.5–1.7 s.
2. **officeparser 8.5.0.** On the same files: the pptx kept the speaker note (as a blockquote), the xlsx gave clean tables (`1200`) but no sheet names in the Markdown, and the SOAP docx gave clean Markdown with tables in 0.76 s. A 289-page text PDF gave 443k chars in 9.1 s. A 4-page scanned PDF gave 181 chars. A one-page diagram PDF gave a correct heading plus readable prose. Defaults include `allowRemoteAssets: true` and pdf.js worker/CMap URLs on cdn.jsdelivr.net.
3. **unpdf 2.1.0.** The 289-page PDF gave 433,888 chars (1,501 chars/page) in 3.0 s. The scanned PDF gave **2 chars**. The diagram PDF gave jumbled labels ("Step / Step / Step Outcome…") before the prose.
4. **mammoth 1.13.0.** Raw text from the SAD docx was 34,865 chars. `convertToMarkdown` turned each table cell into its own paragraph and backslash-escaped hyphens.

## Appendix B — Iris for comparison

[`backend/app/ai/extract.py`](https://github.com/cgbarlow/iris/blob/main/backend/app/ai/extract.py) uses pdfplumber, python-docx, openpyxl and python-pptx. It sends text only, caps each file at 100,000 characters, and sends nothing natively.

| Iris behaviour | Gantry should do differently because |
|---|---|
| Drops Word tables (paragraphs only). | Tables carry much design content. |
| Drops pptx speaker notes. | Notes carry much of a deck's meaning. |
| Returns nothing useful for scanned PDFs. | Native PDF input fixes this on 3 of 6 provider types. |
| Truncates silently at 100k chars. | Gantry should report truncation to the AI and the architect, and fall back to the read tool instead. |
