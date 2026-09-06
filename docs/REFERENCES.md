# Implementation references

The following primary specifications/documentation informed the interfaces and architectural separation. They are not evidence that this release passes a conformance suite.

- WebGPU specification: https://www.w3.org/TR/webgpu/
- WebGPU Shading Language: https://www.w3.org/TR/WGSL/
- Mozilla PDF.js project and examples: https://mozilla.github.io/pdf.js/ and https://mozilla.github.io/pdf.js/examples/
- Optional pinned distribution: https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/
- Adobe Acrobat workspace guide: https://helpx.adobe.com/acrobat/using/workspace-basics.html

The bundled offline parser, writer, renderer, sample document, UI and WebGPU compositor are Folio source code. PDF.js is an optional runtime import, not bundled code. For redistribution with a vendored compatibility engine, include the upstream PDF.js license and all required notices.
