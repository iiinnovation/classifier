# OCR runtime bundles

Generated bundles live in `<platform>-<arch>/` and are excluded from Git. Each
bundle includes the executable, its non-system libraries, English and simplified
Chinese trained data, available notices, and a SHA-256 inventory.

On the target Mac, `npm run desktop:prepare-ocr` copies the local Tesseract runtime,
relocates dylib dependencies into the bundle, applies ad-hoc signatures and checks
the binary with a system-only PATH. `CLASSIFIER_OCR_SOURCE` and
`CLASSIFIER_OCR_TESSDATA` can select an explicit source distribution.

`npm run desktop:prepare-ocr:windows` extracts the pinned x64 Windows installer
with 7-Zip, verifies its checksum and PE architecture, and downloads the pinned
English and simplified Chinese models from `runtime-sources.json`. Bundles
prepared on a Mac have not passed Windows runtime validation. DLL dependencies
and third-party notices still require review on the target platform.

Missing license notices must be resolved before distribution. Mac x64 includes
the Leptonica and tessdata-fast license texts in `notices/`; copying them does
not replace a full distribution license audit. Clean-target validation remains
part of D0-04. A Mac bundle must never be reused for another architecture or
platform.
