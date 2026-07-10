/**
 * Quick regression test for table selection (number + name).
 * Run: node scripts/test-table-selection.js
 */

function resolveTableFromInput(text, tables, menuOptions = {}) {
    const normalized = String(text || '').trim();
    let tableNumber = null;
    let tableId = null;

    const applyTable = (t) => {
        if (!t) {
            return false;
        }
        tableNumber = t.name;
        tableId = String(t.id);
        return true;
    };

    if (normalized.startsWith('table_')) {
        const id = normalized.replace('table_', '');
        applyTable(tables.find(tbl => String(tbl.id) === String(id)));
        return { tableNumber, tableId };
    }

    if (menuOptions[normalized]) {
        const tableKey = menuOptions[normalized];
        if (String(tableKey).startsWith('table_')) {
            const id = String(tableKey).replace('table_', '');
            applyTable(tables.find(tbl => String(tbl.id) === String(id)));
            return { tableNumber, tableId };
        }
    }

    if (tables.length > 0) {
        const byName = tables.find(tbl =>
            String(tbl.name).toLowerCase() === normalized.toLowerCase()
            || String(tbl.id) === normalized
        );
        if (applyTable(byName)) {
            return { tableNumber, tableId };
        }

        const index = parseInt(normalized, 10);
        if (!Number.isNaN(index) && index >= 1 && index <= tables.length) {
            applyTable(tables[index - 1]);
        }
    }

    return { tableNumber, tableId };
}

/** Mirrors processMessage smart menu middleware */
function applySmartMenuMapping(text, menuOptions) {
    if (menuOptions && menuOptions[text.toLowerCase()]) {
        return menuOptions[text.toLowerCase()];
    }
    if (menuOptions && !Number.isNaN(text)) {
        const num = parseInt(text, 10).toString();
        if (menuOptions[num]) {
            return menuOptions[num];
        }
    }
    return text;
}

const tables = [
    { id: 12, name: 'Mawenzi' },
    { id: 34, name: 'Kibo' },
];

const menuOptions = {
    '1': 'table_12',
    '2': 'table_34',
};

const cases = [
    {
        label: 'User types list number 1 (after smart menu → table_12)',
        input: applySmartMenuMapping('1', menuOptions),
        expect: { tableNumber: 'Mawenzi', tableId: '12' },
    },
    {
        label: 'User types list number 2',
        input: applySmartMenuMapping('2', menuOptions),
        expect: { tableNumber: 'Kibo', tableId: '34' },
    },
    {
        label: 'User types table name Mawenzi',
        input: 'Mawenzi',
        expect: { tableNumber: 'Mawenzi', tableId: '12' },
    },
    {
        label: 'User types table name case-insensitive mawenzi',
        input: 'mawenzi',
        expect: { tableNumber: 'Mawenzi', tableId: '12' },
    },
    {
        label: 'User types table name Kibo',
        input: 'Kibo',
        expect: { tableNumber: 'Kibo', tableId: '34' },
    },
    {
        label: 'Invalid table number 99',
        input: applySmartMenuMapping('99', menuOptions),
        expect: { tableNumber: null, tableId: null },
    },
];

let passed = 0;
let failed = 0;

for (const c of cases) {
    const result = resolveTableFromInput(c.input, tables, menuOptions);
    const ok = result.tableNumber === c.expect.tableNumber && result.tableId === c.expect.tableId;
    if (ok) {
        passed++;
        console.log(`✅ PASS: ${c.label}`);
        console.log(`   → table_number=${result.tableNumber}, table_id=${result.tableId}`);
    } else {
        failed++;
        console.log(`❌ FAIL: ${c.label}`);
        console.log(`   expected: ${JSON.stringify(c.expect)}`);
        console.log(`   got:      ${JSON.stringify(result)}`);
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
