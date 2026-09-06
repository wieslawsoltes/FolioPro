# External fixtures

`imported.pdf` was produced independently with ReportLab. It contains Base14 text using the PDF default black graphics state, a four-color RGB image, a stroked rounded rectangle and ASCII85/Flate-compressed resources. All text, including the dummy "TOP SECRET" phrase, is synthetic.

`compressed-objects.pdf` is the same synthetic document rewritten by PyMuPDF with compressed object streams and a cross-reference stream. It exercises parsing of externally generated compressed PDF structure.

`test-image.png` is an original 160 × 100 four-quadrant RGB test bitmap with no text, font files or external assets.

The browser tests require these small committed fixtures. Test outputs are generated separately under `tests/out/`.
