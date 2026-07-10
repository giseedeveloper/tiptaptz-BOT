/**
 * TAP brand visual language for WhatsApp (no custom CSS — unicode + emoji).
 * Colors from samaki_samaki_tap_branded_ui.html (#2121CC primary, #6C63FF accent).
 */

const { integratedPaymentsEnabled } = require('./features');

const TAP = {
    divider: '━━━━━━━━━━━━━━━━━━━━',
    primary: '🔵',
    accent: '🟣',
    pay: '💠',
    star: '⭐',
};

function tapFooter(session, T) {
    return `0️⃣ ${T(session, 'home_type_zero')} · _${T(session, 'tap_powered_by')}_`;
}

/** First token of display name — e.g. "ERICK SALEHE" → "ERICK" */
function waiterFirstName(fullName) {
    if (!fullName || typeof fullName !== 'string') {
        return null;
    }

    const first = fullName.trim().split(/\s+/)[0];

    return first || null;
}

/** Home screen line: "waiter ERICK" / "mhudumu ERICK" */
function formatWaiterHomeLine(session, T) {
    const first = waiterFirstName(session.waiter_name);

    if (!first) {
        return null;
    }

    return T(session, 'home_waiter_line').replace('{name}', first);
}

function buildWelcomeBody(session, T) {
    const name = session.restaurant_name || 'Restaurant';
    const lines = [
        TAP.divider,
        `${TAP.primary} *${T(session, 'home_welcome')} ${name}!*`,
        TAP.divider,
    ];

    const waiterLine = formatWaiterHomeLine(session, T);
    if (waiterLine) {
        lines.push(`🧑‍🍳 ${waiterLine}`);
    }

    if (session.table_number) {
        lines.push(`🪑 ${T(session, 'table')}: *${session.table_number}*`);
    }

    lines.push('');
    lines.push(T(session, 'tap_welcome_help'));
    lines.push('');
    lines.push(`💡 _${T(session, 'tap_welcome_sub')}_`);

    return lines.join('\n');
}

function buildStartWelcome(T, session) {
    return (
        `${TAP.divider}\n` +
        `${TAP.primary} *TipTap*\n` +
        `${TAP.divider}\n\n` +
        `${T(session, 'start_welcome')}\n\n` +
        `_${T(session, 'tap_powered_by')}_`
    );
}

function buildServiceSections(session, T) {
    const waiterShort = waiterFirstName(session.waiter_name) || session.waiter_name;
    const waiterDesc = waiterShort || T(session, 'call_waiter_desc');
    const tipDesc = waiterShort
        ? T(session, 'tap_tip_waiter').replace('{name}', waiterShort)
        : T(session, 'tip_desc');
    const rateDesc = T(session, 'tap_rate_service_desc');

    const foodRows = [
        { id: 'view_menu', title: `🍽️ ${T(session, 'menu_view')}`, description: T(session, 'menu_view_desc') },
    ];

    if (session.waiter_id) {
        foodRows.push({
            id: 'call_waiter',
            title: `🔔 ${T(session, 'call_waiter_short')}`,
            description: waiterDesc,
        });
    } else if (session.table_number || session.table_id) {
        foodRows.push({
            id: 'call_waiter',
            title: `🔔 ${T(session, 'call_waiter_short')}`,
            description: T(session, 'call_waiter_order_desc'),
        });
    }

    const allRows = [...foodRows];

    if (integratedPaymentsEnabled) {
        allRows.push(
            { id: 'live_bill', title: `💳 ${T(session, 'pay_bill')}`, description: T(session, 'tap_pay_methods') },
            { id: 'give_tips', title: `💵 ${T(session, 'tip')}`, description: tipDesc },
        );
    }

    allRows.push(
        { id: 'rate_service', title: `⭐ ${T(session, 'tap_rate_service')}`, description: rateDesc },
        { id: 'change_language', title: `🌐 ${T(session, 'change_language')}`, description: T(session, 'change_language_desc') },
        { id: 'exit_bot', title: `❌ ${T(session, 'tap_exit')}`, description: T(session, 'exit_desc') },
    );

    // WhatsApp requires one list section; flat row list avoids category headers (Food, Feedback, etc.).
    return [{ title: T(session, 'tap_list_flat_section'), rows: allRows }];
}

function buildHomeListBody(session, T) {
    const name = session.restaurant_name || 'Restaurant';
    const waiterLine = formatWaiterHomeLine(session, T);

    let body = `👋 ${T(session, 'home_welcome')} ${name}`;
    if (waiterLine) {
        body += `\n🧑‍🍳 ${waiterLine}`;
    } else if (session.table_number) {
        body += `\n🪑 ${T(session, 'table')} ${session.table_number}`;
    }
    body += `\n\n${T(session, 'home_choose')}`;

    return body;
}

function buildCallWaiterSent(session, T, displayName) {
    const waiterName = waiterFirstName(session.waiter_name) || session.waiter_name || displayName;
    return (
        `${TAP.divider}\n` +
        `🔔 *${T(session, 'call_waiter_arriving').replace('{name}', waiterName)}*\n` +
        `_${T(session, 'call_waiter_eta')}_\n` +
        TAP.divider
    );
}

function buildLanguagePrompt(session, T) {
    return `${TAP.accent} *${T(session, 'select_language')}*`;
}

module.exports = {
    TAP,
    tapFooter,
    waiterFirstName,
    formatWaiterHomeLine,
    buildWelcomeBody,
    buildHomeListBody,
    buildStartWelcome,
    buildServiceSections,
    buildCallWaiterSent,
    buildLanguagePrompt,
};
