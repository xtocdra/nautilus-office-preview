#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ESBUILD="$ROOT/node_modules/.bin/esbuild"
VIEWER="$ROOT/office-preview/viewer"

if [[ ! -x "$ESBUILD" ]]; then
    echo "ERROR: esbuild is missing."
    echo "Run npm ci before building."
    exit 1
fi

echo "Building Nautilus Office Preview..."

for dir in docx xlsx pptx; do
    if [[ ! -d "$VIEWER/$dir" ]]; then
        echo "ERROR: Missing viewer directory: $VIEWER/$dir"
        exit 1
    fi
done

# DOCX: docx-preview
"$ESBUILD" \
    node_modules/docx-preview/dist/docx-preview.mjs \
    --bundle \
    --format=iife \
    --global-name=DocxPreview \
    --target=es2022 \
    --minify \
    --outfile="$VIEWER/docx/docx-preview.js"

# XLSX: SheetJS Community Edition 0.20.3
"$ESBUILD" \
    node_modules/xlsx/xlsx.mjs \
    --bundle \
    --format=iife \
    --global-name=XLSX \
    --target=es2022 \
    --minify \
    --outfile="$VIEWER/xlsx/xlsx.js"

# PPTX: standalone browser renderer
"$ESBUILD" \
    node_modules/@aiden0z/pptx-renderer/dist/aiden0z-pptx-renderer.browser.es.js \
    --bundle \
    --format=iife \
    --global-name=PptxRenderer \
    --target=es2022 \
    --minify \
    --outfile="$VIEWER/pptx/pptx-renderer.js"

echo
echo "Build completed successfully."

echo
echo "Generated viewer bundles:"
ls -lh \
    "$VIEWER/docx/docx-preview.js" \
    "$VIEWER/xlsx/xlsx.js" \
    "$VIEWER/pptx/pptx-renderer.js"
