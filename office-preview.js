import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import WebKit from 'gi://WebKit?version=6.0';

import {
    Renderer,
    ResizePolicy,
} from 'resource://org/gnome/NautilusPreviewer/plugin-api-1.js';


const pluginDir = Gio.File.new_for_uri(import.meta.url).get_parent();

const viewerDir = pluginDir
    .get_child('office-preview')
    .get_child('viewer');


function readFile(file) {
    const [success, contents] = file.load_contents(null);

    if (!success)
        throw new Error(`Unable to read ${file.get_path()}`);

    return contents;
}


function detectFormat(file, fileInfo) {
    let contentType = '';

    try {
        contentType = fileInfo?.get_content_type?.() ?? '';
    } catch (error) {
        printerr(`[Office Preview] MIME inspection failed: ${error.message}`);
    }

    const docxTypes = [
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/wps-office.docx',
    ];

    const xlsxTypes = [
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/wps-office.xlsx',
    ];

    const pptxTypes = [
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/wps-office.pptx',
    ];

    if (docxTypes.includes(contentType))
        return 'docx';

    if (xlsxTypes.includes(contentType))
        return 'xlsx';

    if (pptxTypes.includes(contentType))
        return 'pptx';

    const filename = (file.get_basename() ?? '').toLowerCase();

    if (filename.endsWith('.docx'))
        return 'docx';

    if (filename.endsWith('.xlsx'))
        return 'xlsx';

    if (filename.endsWith('.pptx'))
        return 'pptx';

    throw new Error(
        `Unsupported Office document: ${filename} (${contentType})`
    );
}


/* ============================================================
 * DOCX renderer HTML
 * ============================================================ */

function buildDocxHTML(documentFile) {
    const docxDir = viewerDir.get_child('docx');

    const decoder = new TextDecoder();

    let html = decoder.decode(
        readFile(docxDir.get_child('index.html'))
    );

    const bundle = decoder.decode(
        readFile(docxDir.get_child('docx-preview.js'))
    );

    const docxBytes = readFile(documentFile);
    const docxBase64 = GLib.base64_encode(docxBytes);

    // Embed the DOCX JavaScript bundle.
    const scriptTag = '<script src="docx-preview.js"></script>';

    if (!html.includes(scriptTag))
        throw new Error('Could not find the DOCX script tag');

    const safeBundle = bundle.replace(
        /<\/script/gi,
        '<\\/script'
    );

    html = html.replace(
        scriptTag,
        () => `<script>\n${safeBundle}\n</script>`
    );

    // Supply the document directly from memory.
    const fetchLine = "const response = await fetch('document.docx');";

    if (!html.includes(fetchLine))
        throw new Error('Could not find the DOCX fetch statement');

    const embeddedFetch = `
        const response = await Promise.resolve({
            ok: true,
            arrayBuffer: async () => {
                const binary = atob('${docxBase64}');
                const bytes = new Uint8Array(binary.length);

                for (let i = 0; i < binary.length; i++)
                    bytes[i] = binary.charCodeAt(i);

                return bytes.buffer;
            }
        });
    `;

    html = html.replace(fetchLine, embeddedFetch);

    printerr(`[Office Preview] DOCX embedded (${docxBytes.length} bytes)`);

    return html;
}


/* ============================================================
 * XLSX renderer HTML
 * ============================================================ */

function buildXlsxHTML(workbookFile) {
    const xlsxDir = viewerDir.get_child('xlsx');

    const decoder = new TextDecoder();

    let html = decoder.decode(
        readFile(xlsxDir.get_child('index.html'))
    );

    const xlsxBundle = decoder.decode(
        readFile(xlsxDir.get_child('xlsx.js'))
    );

    const previewScript = decoder.decode(
        readFile(xlsxDir.get_child('xlsx-preview.js'))
    );

    const workbookBytes = readFile(workbookFile);
    const workbookBase64 = GLib.base64_encode(workbookBytes);

    const xlsxTag = '<script src="xlsx.js" defer></script>';
    const previewTag = '<script src="xlsx-preview.js" defer></script>';

    if (!html.includes(xlsxTag))
        throw new Error('Could not find the XLSX library script tag');

    if (!html.includes(previewTag))
        throw new Error('Could not find the XLSX preview script tag');

    // Remove external references.
    html = html.replace(xlsxTag, '');
    html = html.replace(previewTag, '');

    const safeBundle = xlsxBundle.replace(
        /<\/script/gi,
        '<\\/script'
    );

    const safePreview = previewScript.replace(
        /<\/script/gi,
        '<\\/script'
    );

    // Load the viewer scripts and workbook after the HTML DOM.
    const embeddedScripts = `
<script>
${safeBundle}
</script>

<script>
${safePreview}
</script>

<script>
(() => {
    const binary = atob('${workbookBase64}');
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++)
        bytes[i] = binary.charCodeAt(i);

    window.loadXlsxWorkbook(bytes.buffer);
})();
</script>
`;

    const bodyEnd = html.lastIndexOf('</body>');

    if (bodyEnd === -1)
        throw new Error('Could not find the closing body tag');

    html = html.slice(0, bodyEnd)
        + embeddedScripts
        + html.slice(bodyEnd);

    // The workbook comes directly from Nautilus.
    html = html.replace(
        '</head>',
        '<style>#open-file { display: none !important; }</style>\n</head>'
    );

    printerr(`[Office Preview] XLSX embedded (${workbookBytes.length} bytes)`);

    return html;
}



/* ============================================================
 * PPTX renderer HTML
 * ============================================================ */

function buildPptxHTML(presentationFile) {
    const pptxDir = viewerDir.get_child('pptx');
    const decoder = new TextDecoder();

    let html = decoder.decode(
        readFile(pptxDir.get_child('index.html'))
    );

    const bundle = decoder.decode(
        readFile(pptxDir.get_child('pptx-renderer.js'))
    );

    const previewScript = decoder.decode(
        readFile(pptxDir.get_child('pptx-preview.js'))
    );

    const presentationBytes = readFile(presentationFile);
    const presentationBase64 = GLib.base64_encode(presentationBytes);
    const fileName = presentationFile.get_basename() ?? 'presentation.pptx';

    const bundleTag = '<script src="pptx-renderer.js"></script>';
    const previewTag = '<script src="pptx-preview.js"></script>';

    if (!html.includes(bundleTag))
        throw new Error('Could not find the PPTX renderer script tag');

    if (!html.includes(previewTag))
        throw new Error('Could not find the PPTX preview script tag');

    const safeBundle = bundle.replace(
        /<\/script/gi,
        '<\\/script'
    );

    const safePreview = previewScript.replace(
        /<\/script/gi,
        '<\\/script'
    );

    // Embed both JavaScript files directly into the HTML.
    html = html.replace(
        bundleTag,
        () => `<script>\n${safeBundle}\n</script>`
    );

    html = html.replace(
        previewTag,
        () => `<script>\n${safePreview}\n</script>`
    );

    // Hide the standalone file-picker controls. Sushi supplies
    // the presentation directly from the selected document.
    html = html.replace(
        '</head>',
        '<style>#open-file, #file-input { display: none !important; }</style>\n</head>'
    );

    // Supply a File-like object backed by the embedded presentation.
    // The standalone loader can therefore be reused without changing
    // its tested rendering implementation.
    const startupScript = `
<script>
(() => {
    const binary = atob('${presentationBase64}');
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++)
        bytes[i] = binary.charCodeAt(i);

    const presentation = {
        name: ${JSON.stringify(fileName)},
        size: bytes.byteLength,
        arrayBuffer: async () => bytes.buffer,
    };

    Promise.resolve()
        .then(() => window.loadPptxPresentation(presentation))
        .then(() => {
            const status = document.getElementById('status');

            if (status?.classList.contains('error')) {
                document.title =
                    'office-preview:pptx-error:' +
                    encodeURIComponent(status.textContent);
            } else {
                document.title = 'office-preview:pptx-ready';
            }
        })
        .catch(error => {
            console.error('[Office Preview] PPTX startup failed:', error);

            document.title =
                'office-preview:pptx-error:' +
                encodeURIComponent(error.message || String(error));
        });
})();
</script>
`;

    const bodyEnd = html.lastIndexOf('</body>');

    if (bodyEnd === -1)
        throw new Error('Could not find the closing body tag');

    html = html.slice(0, bodyEnd)
        + startupScript
        + html.slice(bodyEnd);

    printerr(
        `[Office Preview] PPTX embedded (${presentationBytes.length} bytes)`
    );

    return html;
}


/* ============================================================
 * Unified Nautilus Sushi renderer
 * ============================================================ */

export const Klass = class OfficePreviewRenderer extends Adw.Bin {
    static {
        GObject.registerClass({
            Implements: [Renderer],
        }, this);
    }

    constructor(file, fileInfo, constructProperties = {}) {
        super(constructProperties);

        this._ready = false;
        this._webView = null;

        printerr(`[Office Preview] Renderer constructed: ${file.get_uri()}`);

        try {
            this._format = detectFormat(file, fileInfo);

            printerr(`[Office Preview] Detected format: ${this._format.toUpperCase()}`);

            let html;

            if (this._format === 'docx') {
                html = buildDocxHTML(file);
            } else if (this._format === 'xlsx') {
                html = buildXlsxHTML(file);
            } else {
                html = buildPptxHTML(file);
            }

            printerr(`[Office Preview] HTML prepared (${html.length} characters)`);

            this._webView = new WebKit.WebView({
                hexpand: true,
                vexpand: true,
            });

            this.set_child(this._webView);

            this._webView.connect('load-changed', (_view, event) => {
                printerr(`[Office Preview] WebView load event: ${event}`);

                if (event === WebKit.LoadEvent.FINISHED && !this._ready) {
                    this._ready = true;

                    if (this._format === 'pptx') {
                        printerr(
                            '[Office Preview] PPTX viewer page ready; slide rendering continues asynchronously'
                        );
                    }

                    this.markReady();
                }
            });

            this._webView.connect(
                'load-failed',
                (_view, _event, uri, error) => {
                    printerr(
                        `[Office Preview] WebKit load failed (${uri}): ${error.message}`
                    );

                    if (!this._ready)
                        this.markFailed(error);

                    return false;
                }
            );

            this._webView.load_html(html, null);

        } catch (error) {
            printerr(`[Office Preview] Initialization failed: ${error.message}`);

            this.markFailed(
                new GLib.Error(
                    Gio.io_error_quark(),
                    Gio.IOErrorEnum.FAILED,
                    error.message
                )
            );
        }
    }

    get resizePolicy() {
        return ResizePolicy.SCALED;
    }

    stop() {
        this._webView?.stop_loading();
    }

    cleanup() {
        this._webView?.stop_loading();
    }
};


export const contentTypes = [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/wps-office.docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/wps-office.xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/wps-office.pptx',
];
