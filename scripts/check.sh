#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "Checking GJS plugin syntax..."
node --check --input-type=module < office-preview.js

echo "Checking viewer JavaScript syntax..."
node --check office-preview/viewer/xlsx/xlsx-preview.js
node --check office-preview/viewer/pptx/pptx-preview.js

echo "Checking required runtime files..."

required_files=(
    "LICENSE"
    "office-preview.js"
    "office-preview/viewer/docx/index.html"
    "office-preview/viewer/docx/docx-preview.js"
    "office-preview/viewer/xlsx/index.html"
    "office-preview/viewer/xlsx/xlsx.js"
    "office-preview/viewer/xlsx/xlsx-preview.js"
    "office-preview/viewer/pptx/index.html"
    "office-preview/viewer/pptx/pptx-renderer.js"
    "office-preview/viewer/pptx/pptx-preview.js"
    "THIRD-PARTY-LICENSES/README.md"
    "THIRD-PARTY-SOURCES/mtx-decompressor/LICENSE"
)

for file in "${required_files[@]}"; do
    if [[ ! -s "$file" ]]; then
        echo "ERROR: Missing or empty file: $file"
        exit 1
    fi
done

echo "Checking Office MIME registrations..."

for mime in \
    application/vnd.openxmlformats-officedocument.wordprocessingml.document \
    application/wps-office.docx \
    application/vnd.openxmlformats-officedocument.spreadsheetml.sheet \
    application/wps-office.xlsx \
    application/vnd.openxmlformats-officedocument.presentationml.presentation \
    application/wps-office.pptx
do
    if ! grep -Fq "$mime" office-preview.js; then
        echo "ERROR: Missing MIME type: $mime"
        exit 1
    fi
done

echo "Checking viewer script references..."

grep -Fq 'docx-preview.js' office-preview/viewer/docx/index.html
grep -Fq 'xlsx.js' office-preview/viewer/xlsx/index.html
grep -Fq 'xlsx-preview.js' office-preview/viewer/xlsx/index.html
grep -Fq 'pptx-renderer.js' office-preview/viewer/pptx/index.html
grep -Fq 'pptx-preview.js' office-preview/viewer/pptx/index.html

echo
echo "All project checks passed."
