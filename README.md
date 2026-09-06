# Folio Pro

[Open the live app](https://wieslawsoltes.github.io/FolioPro/) · [GitHub Actions](https://github.com/wieslawsoltes/FolioPro/actions)

**An independent, Acrobat-inspired PDF workspace built with plain HTML, CSS, JavaScript, a native PDF kernel, and a WebGPU page compositor.**

Folio Pro 0.1 is a functional engineering release. It opens and renders real PDFs, supports additive editing and annotation, fills basic forms, organizes pages, and writes real exported PDFs. It is not a complete Adobe Acrobat Pro implementation or a PDF conformance/security-certified product.

## Run immediately

Open **`dist/folio-pro.html`** for the self-contained application. The included Northstar document is generated as a real four-page PDF in memory; it is not an HTML imitation of a document. It includes bookmarks and three actual PDF form widgets. Its business metrics and reviewers are fictional.

For the predictable local-origin environment recommended for WebGPU and IndexedDB, use Node.js 22 or newer:

```sh
npm start
# Open http://localhost:4173
```

No npm installation, build framework, cloud account, API key, or runtime package dependency is required. The modular `index.html` and `src/` tree can also be deployed unchanged to static HTTPS hosting. Do not open the modular entry point directly from `file://`; use the bundled HTML or the supplied server.

The status-bar engine badge reports the real compositor. WebGPU is requested at runtime and Canvas 2D is explicitly used when unavailable. GPU rendering is not emulated by changing a label.

## What works

| Area | Implemented behavior |
| --- | --- |
| Workspace | Original Folio branding; Acrobat-style All tools, Edit, Convert, Fill & sign, Organize tabs; tool sidebar, thumbnails/bookmarks, page canvas, comments, properties, search and status controls. |
| PDF reading | Local open and drop; native parser for classic cross-reference tables, cross-reference streams, object streams, page trees and inherited resources; common stream filters. |
| Viewing | Actual page rasterization; selectable text overlay; document text search; zoom, fit page, fit width, pan and page navigation. |
| Additive editing | Text, PNG/JPEG images, rectangles, ellipses, lines, freehand paths, highlighting, watermarks and page numbering. Move, resize, recolor, change text/style/opacity, reorder and duplicate added objects. |
| Reviews | Position-attached comments, editing, resolve/reopen, local author labels and JSON export. New comments export as PDF note annotations. No cloud collaboration is implied. |
| Forms | Fill supported existing PDF text/checkbox widgets; create new text fields and checkboxes. Source-field edits are flattened on vector export; newly created fields remain actual interactive AcroForm widgets. |
| Signing | Typed and drawn visual signature placement and approval stamps. These are not cryptographic/certificate signatures. |
| Pages | Combine PDFs, insert a blank page, duplicate, remove, reorder, rotate, crop/reset crop, extract selected pages in a specified order. |
| Persistence | Undo/redo, editable `.folio` projects containing source PDFs and the edit model, IndexedDB autosave/recovery, explicit local-recovery deletion. |
| Export | Source-vector-preserving PDF, image-only PDF, current-page PNG, extracted text, comment JSON and editable project. Printable PDF opens in a browser tab. |
| Redaction | Mark regions, then explicitly export a newly constructed, image-only sanitized PDF with opaque replacement pixels. Vector export is blocked while redactions are pending. |

Text editing means editing **new Folio text objects**. Original PDF text is selectable and searchable but is not rewritten or reflowed. That distinction appears in the editor as well as this documentation.

## Everyday workflow

Use **Open** or drop a PDF into the workspace. The demo can always be reopened through File → Open example document. Select tools from the sidebar or floating toolbar. Click a page to add text/comments/signatures; drag to draw paths, shapes, highlights and crop/redaction regions. Use Select to drag objects and their bottom-right resize handles. The Properties panel provides exact dimensions in PDF points.

Existing form fields become interactive in Select mode. Double-click a newly created form field to select its properties. Fill & sign provides text fields, checkbox fields, typed text, check marks, signatures and stamps.

Use **Organize** to reorder page cards by dragging. Page extraction accepts ranges such as `1-3, 5, 8`, removes duplicates, preserves the specified order, and exports a separate PDF. Cropping changes the visible page area; it is not a secure content-removal operation.

**Export PDF** writes an ordinary PDF. Added artwork is flattened into its page content, while new notes and new form widgets remain annotations. **Save editable project** preserves editable objects and original source files for later work. The export and project are intentionally different products. Download a project rather than relying exclusively on browser recovery storage.

Keyboard shortcuts: Ctrl/Command+O opens; Ctrl/Command+S exports; Ctrl/Command+Shift+S saves a project; Ctrl/Command+Z undoes; Ctrl/Command+Shift+Z redoes; Ctrl/Command+F searches. V selects, H pans, T adds text, N comments, U highlights, R draws a rectangle and D draws freehand. Arrow keys nudge selected objects; Shift changes the nudge to 10 points. Space temporarily activates panning.

## Rendering architecture

```text
Local PDF bytes
  └─ PDFSource: xref / object resolution / page resources
      ├─ NativePDFRenderer: PDF operators → Canvas page raster + text geometry
      └─ Optional PDFJSRenderer: PDF.js worker / Canvas raster + text geometry
          └─ Screen-resolution cache and bounded render queue
              ├─ PageCompositor: WGSL textured quads on a WebGPU canvas
              └─ Explicit fallback: individual Canvas 2D page surfaces
                  + DOM text layer
                  + SVG annotation and selection layers
                  + DOM form widgets
```

The GPU stage is real texture-based compositing. **PDF parsing and rasterization are not performed in WGSL.** The default renderer interprets PDF content on the main thread. The optional PDF.js backend uses its worker architecture. This release does not claim GPU-native text/path PDF interpretation or a particular frame rate.

The native kernel is dependency-free. It implements dictionary/name/string/reference parsing; classic and hybrid cross-reference sections; compressed object streams; lazy shared promise-based object resolution; page inheritance; common compression filters; and resource graph copying with reference remapping. Flate uses browser `CompressionStream` / `DecompressionStream`. Source text, vectors and encoded resources are preserved by embedding source pages as Form XObjects during vector export rather than replacing them with screenshots.

Coordinate systems are explicit. The source CropBox, original page rotation and UserUnit are normalized to top-left point coordinates. Edits live in that normalized space. Cropping and additional rotation are applied by the view/export transform instead of repeatedly rewriting each annotation. Pointer coordinates invert that transform. PDF export maps edited points back into bottom-left PDF coordinates.

Rendering is demand-driven, not an unconditional animation loop. IntersectionObserver schedules visible and near-visible pages. Scale buckets reduce churn during zoom. Full-page renders receive queue priority over thumbnail work. CPU raster and GPU texture caches each have a 128 MiB byte budget; these are cache budgets, **not a promise that total process memory stays under 256 MiB**. Fonts, decoded source images, source buffers, history, mounted canvases, export buffers and browser internals consume additional memory. Thumbnail generation is capped at 200 pages. The document limit is 2,000 pages. A native page raster is capped at roughly 24 million pixels. Oversized GPU textures or a lost device switch to the visible Canvas fallback.

The compositor allocates reusable vertex/uniform buffers, uploads cached page textures through `copyExternalImageToTexture`, packs visible page rectangles and UVs into a vertex buffer, and presents them in one render pass. Quarter-turn rotation is applied to texture coordinates. WGSL compilation and device errors are reported. The diagnostics timing is CPU command-encoding/submission time, not measured GPU execution time.

History uses validated immutable model snapshots, capped at 80 undo entries, with one commit per completed pointer gesture. That is simple and auditable, but it is not a persistent-tree or operation-log history suitable for arbitrarily large collaborative documents. Gesture preview state is separate from committed state.

## Native renderer boundary and optional PDF.js

The offline renderer supports common text operators and Base14/system-font substitution, embedded TrueType fonts where supported by the browser, ToUnicode mappings, vector paths, clipping paths, common fill/stroke operators, basic graphics states/blending, Form XObjects, common image formats and appearance streams. It supports Flate, ASCII85, ASCIIHex, RunLength and LZW decoding, with common PNG/TIFF predictors.

Some valid PDFs require more than that subset. Unsupported shading, text clipping, Type 3 fonts, inline images, stencil masks, certain transparency/color-space operations, JPEG 2000 and JBIG2 require a compatibility renderer. Some font substitutions and CMYK approximations are reported as warnings. This native implementation has not been validated against a broad PDF conformance corpus; it may reject or misrender PDFs beyond the tested fixtures.

**File → Engine & compatibility → Load PDF.js renderer** dynamically imports pinned `pdfjs-dist@6.3.289` from jsDelivr, including its worker and supporting assets. This path is optional and network-dependent. The application does not upload document bytes, but the CDN sees asset requests and its code runs with document access in your page. For an audited deployment, vendor and pin the PDF.js distribution on your own origin and review its license/security posture. No PDF.js files are bundled here, and the remote backend could not be exercised in the network-restricted build environment.

The structural parser still rejects encrypted PDFs and XFA forms before rendering. Loading PDF.js does not remove those restrictions. Native vector export of newly added or newly filled text is limited to Latin-1; other scripts are explicitly rejected rather than silently replaced. Image-only export uses browser text rendering and can preserve those visible scripts, subject to available fonts. Original source font resources can still be preserved in vector export.

Not implemented: general source-content editing/reflow, OCR, certificate signing/validation, encryption/decryption, cloud collaboration, PDF/A or PDF/UA validation, accessibility remediation, full reading-order reconstruction, rich form types/actions, original bookmark/link/attachment preservation in rebuilt exports, portfolio workflows and press-proof ICC/preflight workflows. Source annotations without supported appearances are not fully preserved. Original digital signatures are not preserved by rewriting the PDF.

## Redaction and local-data safety

Redaction marks are previews until **Apply redactions & export** completes. The export path renders every selected page, paints opaque black rectangles after all other artwork, and constructs a new PDF from RGB pixel streams. It never copies source PDF objects, hidden text, form dictionaries, attachments or original metadata into that new file. The source-vector export path refuses pending redactions, and image-only export requires explicit redaction authorization.

The supplied integration test independently checks the exported file using PyMuPDF: masked pixels are black, extracted text is empty, source fonts and attachments are absent, the catalog is newly built, and the metadata is generic. That is a concrete regression test, not a security certification. Inspect every exported page before sharing; make sure every sensitive region has actually been marked. Unsupported-renderer errors must be resolved before export rather than ignored.

**The original document remains in the workspace, `.folio` project, undo snapshots, downloaded source files and local autosave. Never distribute those as a redacted document.** File → Forget local autosave removes the browser recovery record; future edits will create a new one. The app does not encrypt IndexedDB and does not securely erase browser/OS storage. Cropping and merely drawing black rectangles are not redaction.

## Tests and reproducible build

```sh
npm test        # 41 Node kernel/model tests; no packages required
npm run build   # bundle own ES modules and CSS into dist/folio-pro.html
npm run check   # validate source module and standalone bundle syntax

# Optional browser/independent-PDF development tests:
python -m pip install playwright pymupdf
# Provide Chromium via CHROMIUM=/path/to/chromium, default /usr/bin/chromium
npm run test:browser
```

Included fixtures were independently generated with ReportLab and PyMuPDF and contain no personal data. The browser suite combines actual pointer/keyboard/dialog interactions with direct core calls for exported-file inspection. Test output is written to `tests/out/`.

Verified in the delivered build: **41/41 Node tests and 22/22 browser integration checks**. The browser was Chromium 144.0.7559.96; exported PDFs were independently parsed and rendered by PyMuPDF 1.26.7. Browser checks cover text creation, search, undo/redo, geometry, comments, form filling, project round-trip, imported images, external object streams, page operations, signatures and sanitized export.

The managed browser blocked ordinary URL navigation, so integration tests loaded the self-contained document in memory. **The exercised renderer/compositor was native PDF plus Canvas 2D. Hardware WebGPU, persistent-origin IndexedDB, browser print integration, file-origin behavior and the remote PDF.js path were not verified in this environment.** There are no invented GPU benchmarks or cross-browser conformance claims. The application includes those runtime paths, with explicit fallback and diagnostics.

## Source layout

- `src/pdf-kernel.mjs`: PDF syntax, cross-reference/object resolution, filters, writer and source-resource copying.
- `src/pdf-renderer.mjs`: native operator interpreter, fonts/images, annotation appearances and optional PDF.js adapter.
- `src/gpu.mjs`: WebGPU textured-page compositor, buffers, texture cache and fallback.
- `src/documents.mjs`: document/page models, forms, coordinate conversion and vector/raster exports.
- `src/core.mjs`: affine math, validation, immutable history, bounded LRU cache and prioritized task pool.
- `src/app.mjs`, `src/ui.mjs`, `src/styles.css`: workspace, editing interactions, dialogs, icons and local persistence.
- `src/sample.mjs`: original demo-PDF generator.
- `scripts/`, `tests/`, `docs/`: build/server tooling, fixtures, regression tests and technical notes.

The UI is independently branded and uses original vector icons and system fonts. It is not affiliated with Adobe.

## GitHub Pages

The `Deploy GitHub Pages` workflow validates the kernel/model tests, creates the dependency-free standalone build, checks its JavaScript syntax, uploads `dist/` as a Pages artifact, and deploys the app to **https://wieslawsoltes.github.io/FolioPro/**. It runs on pushes to `main` and can also be started manually from Actions. Pull requests run the separate validation workflow without deploying.

`dist/index.html` and `dist/folio-pro.html` are the same self-contained application. All app resources are embedded, so hosting below the `/FolioPro/` project path does not require rewriting asset URLs. Source PDFs stay in the browser; deploying the application does not upload documents opened by its users. The optional PDF.js compatibility engine remains an explicit internet-dependent choice.
