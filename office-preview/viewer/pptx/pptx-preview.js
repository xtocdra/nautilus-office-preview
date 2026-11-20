(() => {
    'use strict';

    const openButton = document.getElementById('open-file');
    const fileInput = document.getElementById('file-input');
    const container = document.getElementById('pptx-container');
    const status = document.getElementById('status');

    let viewer = null;

    function showStatus(message, isError = false) {
        status.textContent = message;
        status.className = isError ? 'error' : '';
    }

    async function loadPresentation(file) {
        if (!file)
            return;

        try {
            if (viewer) {
                viewer.destroy();
                viewer = null;
            }

            container.replaceChildren();
            container.scrollTop = 0;

            showStatus(`Reading ${file.name}...`);

            const buffer = await file.arrayBuffer();

            showStatus('Parsing and rendering presentation...');

            viewer = await PptxRenderer.PptxViewer.open(
                buffer,
                container,
                {
                    zipLimits: PptxRenderer.RECOMMENDED_ZIP_LIMITS,
                    externalMedia: 'block',
                    lazySlides: true,
                    lazyMedia: true,
                    scrollContainer: container,
                    listOptions: {
                        windowed: true,
                        initialSlides: 4,
                        batchSize: 4,
                        showSlideLabels: true,
                    },
                    onSlideError: (index, error) => {
                        console.error(
                            `[PPTX] Slide ${index + 1} failed:`,
                            error
                        );
                    },
                    onNodeError: (nodeId, error) => {
                        console.warn(
                            `[PPTX] Node ${nodeId} failed:`,
                            error
                        );
                    },
                }
            );

            showStatus(
                `${file.name} — ${viewer.slideCount} slides`
            );

            console.log('[PPTX] Presentation loaded:', {
                name: file.name,
                size: file.size,
                slides: viewer.slideCount,
                width: viewer.slideWidth,
                height: viewer.slideHeight,
            });

        } catch (error) {
            console.error('[PPTX] Loading failed:', error);

            viewer?.destroy();
            viewer = null;

            container.replaceChildren();

            showStatus(
                `Unable to open presentation: ${error.message}`,
                true
            );
        }
    }

    openButton.addEventListener('click', () => {
        fileInput.click();
    });

    fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];

        if (!file)
            return;

        await loadPresentation(file);

        // Allow selecting the same file again.
        fileInput.value = '';
    });

    window.addEventListener('beforeunload', () => {
        viewer?.destroy();
    });

    // Exposed for possible Sushi integration.
    window.loadPptxPresentation = loadPresentation;

})();
EOF
