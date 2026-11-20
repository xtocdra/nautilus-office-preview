# Changelog

All notable changes to Nautilus Office Preview are documented here.

## [1.0.0] - Initial release candidate

### Added

- Unified GNOME Nautilus Sushi plugin.
- DOCX preview using docx-preview 0.4.1.
- XLSX preview using SheetJS Community Edition 0.20.3.
- PPTX preview using @aiden0z/pptx-renderer 1.4.0.
- Standard Office Open XML MIME type detection.
- WPS Office MIME type detection.
- Locally bundled JavaScript rendering engines.
- In-memory document loading through WebKitGTK.
- Lazy PowerPoint slide and media loading.
- Windowed PowerPoint slide rendering.
- ZIP resource limits for PowerPoint parsing.
- Blocking of external PowerPoint media relationships.
- Build and validation scripts.
- Third-party licensing notices and MPL source preservation.

### Security

- Verified XLSX HTML escaping for HTML-like cell contents.
- Applied recommended PPTX ZIP parsing limits.
- Blocked external PPTX media relationships.
- Full npm audit completed with zero reported vulnerabilities.

### Compatibility

Tested on Arch Linux with GNOME Sushi 51.2,
GJS 1.90.1, WebKitGTK 6.0 2.54.3,
GTK 4 4.24.1 and libadwaita 1.10.0.
