# Nautilus Office Preview

A lightweight, browser-based Office document preview plugin for GNOME Nautilus, powered by GNOME Sushi and WebKitGTK.

Preview Microsoft Office Open XML documents directly inside Nautilus, without launching LibreOffice or converting presentations to PDF.

## Features

- **Word documents:** DOCX preview powered by docx-preview.
- **Excel spreadsheets:** XLSX preview powered by SheetJS Community Edition.
- **PowerPoint presentations:** PPTX preview powered by @aiden0z/pptx-renderer.
- Automatic document-format detection using MIME types and filename extensions.
- Support for standard Office OOXML MIME types and WPS Office MIME types.
- Local, bundled JavaScript rendering engines.
- No external CDN or runtime Node.js dependency.
- PowerPoint lazy loading and windowed slide rendering.
- In-memory document loading through WebKitGTK.

## Supported formats

| Format | Extension | Rendering engine |
|---|---|---|
| Microsoft Word | `.docx` | docx-preview 0.4.1 |
| Microsoft Excel | `.xlsx` | SheetJS 0.20.3 |
| Microsoft PowerPoint | `.pptx` | pptx-renderer 1.4.0 |

The plugin also recognizes the corresponding WPS Office MIME types.

Legacy binary formats (`.doc`, `.xls` and `.ppt`) are not currently supported.

## Requirements

- GNOME desktop environment
- GNOME Sushi with plugin API version 1
- GJS
- WebKitGTK 6.0

### Tested environment

The project has been tested on:

| Component | Version |
|---|---|
| Arch Linux | Rolling release |
| GNOME Sushi | 51.2-1 |
| GJS | 1.90.1 |
| WebKitGTK 6.0 | 2.54.3-1 |
| GTK 4 | 4.24.1-1 |
| libadwaita | 1.10.0-1 |

These are tested versions, not declared minimum requirements.

## Installation

### Manual installation

Clone or download the project source, then copy the plugin and its viewer assets into the user plugin directory.

```bash
PLUGIN_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/sushi/plugins-1"

mkdir -p "$PLUGIN_DIR/office-preview"

cp office-preview.js "$PLUGIN_DIR/"

cp -a office-preview/. "$PLUGIN_DIR/office-preview/"
```

Restart Sushi:

```bash
pkill -x sushi 2>/dev/null || true
```

Open Nautilus, select a supported document and press **Space**.

### Arch Linux

An Arch Linux package and AUR release are planned.

The intended system-wide plugin directory is:

```text
/usr/lib/sushi/plugins-1/
```

## Development

### Build requirements

- Node.js 20 or later
- npm

### Install development dependencies

```bash
npm ci
```

### Rebuild viewer bundles

```bash
npm run build
```

The build script generates the three bundled browser rendering engines:

- `office-preview/viewer/docx/docx-preview.js`
- `office-preview/viewer/xlsx/xlsx.js`
- `office-preview/viewer/pptx/pptx-renderer.js`

### Validate the project

```bash
npm run check
```

The validation script checks JavaScript syntax, required assets, viewer references and registered Office MIME types.

### Project structure

```text
nautilus-office-preview/
├── LICENSE
├── README.md
├── CHANGELOG.md
├── package.json
├── package-lock.json
├── office-preview.js
├── office-preview/
│   └── viewer/
│       ├── docx/
│       ├── xlsx/
│       └── pptx/
├── scripts/
│   ├── build.sh
│   └── check.sh
├── THIRD-PARTY-LICENSES/
└── THIRD-PARTY-SOURCES/
    └── mtx-decompressor/
```

## Rendering architecture

GNOME Sushi loads `office-preview.js` as a GJS plugin.

The plugin identifies the document format and creates a WebKitGTK WebView containing the corresponding viewer.

Each rendering engine is bundled locally and supplied with document data in memory.

PowerPoint presentations use asynchronous rendering, lazy slide parsing, lazy media decoding and windowed slide mounting. External media relationships are blocked by the viewer configuration; embedded presentation media remains available.

The previewer is intended for viewing documents, not editing them. Rendering fidelity depends on the capabilities of the individual engines. Advanced PowerPoint effects and animations may not be reproduced exactly.

## Security

- All rendering JavaScript is bundled locally.
- XLSX worksheet data is escaped by SheetJS when generating HTML.
- PPTX parsing uses the renderer's recommended ZIP resource limits.
- External PPTX media relationships are blocked.
- Documents are processed locally by the browser rendering engines.

Users should still treat documents from untrusted sources with appropriate care.

## Third-party software and licensing

Nautilus Office Preview's original source code is licensed under the Apache License 2.0.

The project bundles third-party rendering engines and dependencies, each retaining its own applicable license.

See:

- `THIRD-PARTY-LICENSES/README.md`
- `THIRD-PARTY-LICENSES/`
- `THIRD-PARTY-SOURCES/`

These notices and source materials must be preserved when redistributing the bundled software.

## Project status

The three document preview engines have been integrated and tested independently and through the unified GNOME Sushi plugin.

The project is being prepared for its first public GitHub release and subsequent Arch User Repository packaging.
