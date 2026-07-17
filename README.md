# Local PDF

Every PDF tool — merge, split, compress, convert, sign, redact, OCR — running entirely in the browser.

**Live:** [localpdfapp.com](https://localpdfapp.com)

## Highlights
- 100% on-device: files are never uploaded — no accounts, no tracking, no server-side processing
- Offline-first PWA; the service worker precaches everything, including the OCR engine
- Strict Content Security Policy; built on pdf-lib, pdf.js, and Tesseract (WASM)
- One-time Pro unlock via Stripe + RevenueCat Web Billing

## Screenshots
Coming soon.

## Tech notes
Vanilla JavaScript PWA served as a static site (GitHub Pages). All document processing happens client-side.

## Run locally
Serve the folder with any static file server, e.g. `npx serve .`

## About this repo
This repository contains the deployed build; the app is developed in a private monorepo.

## License
MIT

---
Part of my work at [edenapps.app](https://edenapps.app) · [github.com/edentheoschlegel-code](https://github.com/edentheoschlegel-code)