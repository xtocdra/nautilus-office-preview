(() => {
    'use strict';

    const sheetSelect = document.getElementById('sheet-select');
    const sheetInfo = document.getElementById('sheet-info');
    const spreadsheet = document.getElementById('spreadsheet');
    const fileInput = document.getElementById('file-input');
    const openFileButton = document.getElementById('open-file');

    let workbook = null;

    function showError(message) {
        spreadsheet.replaceChildren();

        const status = document.createElement('div');
        status.id = 'status';
        status.className = 'error';
        status.textContent = message;

        spreadsheet.appendChild(status);
    }

    function renderSheet(sheetName) {
        if (!workbook)
            return;

        const worksheet = workbook.Sheets[sheetName];

        if (!worksheet)
            return;

        try {
            const html = XLSX.utils.sheet_to_html(worksheet, {
                id: 'xlsx-table',
                editable: false,
            });

            spreadsheet.innerHTML = html;

            const range = XLSX.utils.decode_range(
                worksheet['!ref'] || 'A1'
            );

            sheetInfo.textContent =
                `${range.e.r + 1} rows × ${range.e.c + 1} columns`;

            spreadsheet.scrollTop = 0;
            spreadsheet.scrollLeft = 0;

        } catch (error) {
            console.error(error);
            showError(`Unable to render worksheet: ${error.message}`);
        }
    }

    function loadWorkbook(data) {
        try {
            workbook = XLSX.read(data, {
                type: 'array',
                cellStyles: true,
                cellDates: true,
            });

            if (!workbook.SheetNames.length)
                throw new Error('The workbook contains no worksheets.');

            sheetSelect.replaceChildren();

            for (const name of workbook.SheetNames) {
                const option = document.createElement('option');
                option.value = name;
                option.textContent = name;
                sheetSelect.appendChild(option);
            }

            sheetSelect.disabled = false;

            renderSheet(workbook.SheetNames[0]);

        } catch (error) {
            console.error(error);
            workbook = null;
            sheetSelect.disabled = true;
            showError(`Unable to open workbook: ${error.message}`);
        }
    }

    sheetSelect.addEventListener('change', () => {
        renderSheet(sheetSelect.value);
    });

    openFileButton.addEventListener('click', () => {
	console.log('[XLSX Preview] Open button clicked');
        fileInput.click();
    });

    fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];

        if (!file)
            return;

        try {
            const data = await file.arrayBuffer();
            loadWorkbook(data);
        } catch (error) {
            showError(`Unable to read workbook: ${error.message}`);
        }
    });

    // Sushi integration can provide an ArrayBuffer directly.
    window.loadXlsxWorkbook = loadWorkbook;

})();
