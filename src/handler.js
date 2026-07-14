const api = require('./api');
const whatsapp = require('./whatsapp');
const sessionStore = require('./session-store');
const { T } = require('./lang');
const { itemEtaMinutes, cartEtaMinutes, formatEtaLabel } = require('./eta');
const {
    TAP,
    tapFooter,
    buildHomeListBody,
    buildStartWelcome,
    buildServiceSections,
    buildCallWaiterSent,
    buildLanguagePrompt,
} = require('./brand');
const { isEntryCode, shouldOfferWelcome } = require('./greetings');

/**
 * Process-local cache of the active session for each WhatsApp id.
 * Hydrated from Laravel at the start of every inbound message and persisted
 * back when the handler finishes. Long-running flows (e.g. payment polling
 * intervals) keep reading from this cache between webhook events.
 */
const sessions = {};

/**
 * Inbound Cloud API webhook entry point. Hydrates persisted state, runs the
 * existing state-machine, then writes the updated session back to MySQL.
 *
 * @param {object} message Meta message object from value.messages[]
 * @param {object|null} contact Matching contact entry (profile.name, wa_id)
 */
async function handleMessage(message, contact) {
    const waId = whatsapp.digitsOnly(message?.from || '');
    if (!waId) return;

    const text = extractMessageText(message);
    if (text === null || text === '') return;

    let session = await sessionStore.load(waId);

    if (session._justExpired) {
        const preservedLang = session.lang || 'en';
        const preservedName = session.customer_name ?? null;
        const restaurantName = session._expiredRestaurantName;

        await sendSessionExpiredNotice(whatsapp, waId, preservedLang, restaurantName);

        session = sessionStore.defaultSession();
        session.lang = preservedLang;
        if (preservedName) {
            session.customer_name = preservedName;
        }
    }

    sessions[waId] = session;

    try {
        await processMessage(waId, session, text, contact, message);
    } finally {
        await sessionStore.save(waId, session);
    }
}

async function sendSessionExpiredNotice(sock, waId, lang, restaurantName) {
    const session = { lang: lang || 'en' };
    const key = restaurantName ? 'session_expired' : 'session_expired_no_name';
    let message = T(session, key);

    if (restaurantName) {
        message = message.replace(/{name}/g, restaurantName);
    }

    await sendText(sock, waId, message);
}

/**
 * Original handler body, kept verbatim aside from the renamed parameters.
 * `from` is now the digits-only WhatsApp id (no @s.whatsapp.net suffix) and
 * `sock` is the Cloud API client whose `sendMessage(to, payload)` mirrors the
 * Baileys signature the screen builders depend on.
 */
async function processMessage(from, session, initialText, contact, _message) {
    let text = initialText;
    const sock = whatsapp;

    if (contact?.profile?.name) {
        session.customer_name = contact.profile.name;
    }
    console.log(`📩 [${session.state}] From: ${from} | Text: "${text}"`);

    // ═══════════════════════════════════════════════════════════════
    // SMART MENU MAPPING (Middleware)
    // ═══════════════════════════════════════════════════════════════
    if (session.menu_options && session.menu_options[text.toLowerCase()]) {
        const mappedAction = session.menu_options[text.toLowerCase()];
        text = mappedAction;
    } else if (session.menu_options && !isNaN(text)) {
        const num = parseInt(text).toString();
        if (session.menu_options[num]) {
            text = session.menu_options[num];
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // GLOBAL: 0 = Back to main menu (from any state)
    // ═══════════════════════════════════════════════════════════════
    if (text === '0') {
        session.state = 'HOME';
        await showHomeScreen(sock, from, session);
        return;
    }

    if (isLeaveCommand(text)) {
        await clearCustomerSession(from, session);
        await sendText(sock, from, T(session, 'goodbye'));
        return;
    }

    // QR / waiter tag / START — always process entry before welcome card (e.g. after Leave).
    if (isEntryCode(text)) {
        return await handleEntry(sock, from, session, text);
    }

    if (shouldOfferWelcome(session, text)) {
        await sendStartWelcome(sock, from, session);
        session.state = 'SEARCH_RESTAURANT';
        return;
    }

    // ═══════════════════════════════════════════════════════════════
    // GLOBAL COMMANDS
    // ═══════════════════════════════════════════════════════════════
    if (text.toLowerCase() === '!waiter') {
        if (session.waiter_name) {
            await sendText(sock, from, `You are being served by ${session.waiter_name} (Active).`);
        } else {
            await sendText(sock, from, 'You are not assigned to any waiter yet.');
        }
        return;
    }

    if (text.toLowerCase() === '!status' || text.toLowerCase() === 'status') {
        if (session.restaurant_id && session.table_number) {
            return await showTrackStatus(sock, from, session);
        } else {
            await sendText(sock, from, 'Please scan a QR code or search for a restaurant first.');
            return;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // STATE MACHINE
    // ═══════════════════════════════════════════════════════════════
    try {
        switch (session.state) {
            case 'START':
                await handleStartState(sock, from, session, text);
                break;

            case 'SEARCH_RESTAURANT':
                await handleSearchState(sock, from, session, text);
                break;

            case 'PICK_TABLE':
            case 'TABLE_INPUT':
                await handleTableState(sock, from, session, text);
                break;

            case 'HOME':
                await handleHomeState(sock, from, session, text);
                break;

            case 'MENU_HUB':
                await handleMenuHubState(sock, from, session, text);
                break;

            case 'CATEGORIES':
                await handleCategoriesState(sock, from, session, text);
                break;

            case 'ITEMS_LIST':
                await handleItemsListState(sock, from, session, text);
                break;

            case 'ITEM_DETAIL':
                await handleItemDetailState(sock, from, session, text);
                break;

            case 'QUANTITY':
            case 'QUANTITY_MORE':
                await handleQuantityState(sock, from, session, text);
                break;

            case 'CART':
                await handleCartState(sock, from, session, text);
                break;

            case 'CART_EDIT':
                await handleCartEditState(sock, from, session, text);
                break;

            case 'CONFIRM_ORDER':
                await handleConfirmOrderState(sock, from, session, text);
                break;

            case 'PAYMENT_SUMMARY':
                await handlePaymentSummaryState(sock, from, session, text);
                break;

            case 'CASH_PAYMENT':
                await handleCashPaymentState(sock, from, session, text);
                break;

            case 'PROVIDER_SELECT':
                await handleProviderSelectState(sock, from, session, text);
                break;

            case 'USSD_NUMBER':
                await handleUssdNumberState(sock, from, session, text);
                break;

            case 'PAY_NOW':
                await handlePayNowState(sock, from, session, text);
                break;

            case 'USSD_PENDING':
                await handleUssdPendingState(sock, from, session, text);
                break;

            case 'MANUAL_USSD':
                await handleManualUssdState(sock, from, session, text);
                break;

            case 'TRACK_STATUS':
                await handleTrackStatusState(sock, from, session, text);
                break;

            case 'FEEDBACK_TYPE':
            case 'FEEDBACK_WAITER_LIST':
            case 'FEEDBACK':
            case 'FEEDBACK_B':
                await handleFeedbackState(sock, from, session, text);
                break;

            case 'FEEDBACK_COMMENT':
                await handleFeedbackCommentState(sock, from, session, text);
                break;

            case 'TIP':
            case 'POST_PAYMENT_TIP':
                await handlePostPaymentTipState(sock, from, session, text);
                break;

            case 'POST_PAYMENT_TIP_STAFF':
                await handlePostPaymentTipStaffState(sock, from, session, text);
                break;

            case 'CALL_WAITER':
                await handleCallWaiterState(sock, from, session, text);
                break;

            case 'WAITERS_LIST':
                await handleWaitersListState(sock, from, session, text);
                break;

            case 'MENU_SELECTION':
                await handleMenuSelectionState(sock, from, session, text);
                break;

            case 'MENU_IMAGE_ORDER':
                await handleMenuImageOrderState(sock, from, session, text);
                break;

            case 'QUICK_PAYMENT_AMOUNT':
                await handleQuickPaymentAmountState(sock, from, session, text);
                break;

            case 'QUICK_PAYMENT_PHONE':
                await handleQuickPaymentPhoneState(sock, from, session, text);
                break;

            case 'QUICK_PAYMENT_NETWORK':
                await handleQuickPaymentNetworkState(sock, from, session, text);
                break;

            case 'QUICK_PAYMENT_PENDING':
                await handleQuickPaymentPendingState(sock, from, session, text);
                break;

            case 'CALL_WAITER_ASK_TABLE':
                await handleCallWaiterAskTableState(sock, from, session, text);
                break;

            case 'PICK_TABLE_FOR_ORDER':
                await handlePickTableForOrderState(sock, from, session, text);
                break;

            case 'LANGUAGE_SELECT':
                await handleLanguageSelectState(sock, from, session, text);
                break;

            case 'SELECT_WAITER_TIP':
                await handleSelectWaiterTipState(sock, from, session, text);
                break;

            case 'TIP_AMOUNT':
                await handleTipAmountState(sock, from, session, text);
                break;

            default:
                await sendText(sock, from, T(session, 'not_understood'));
                session.state = 'START';
                break;
        }
    } catch (error) {
        console.error('Handler error:', error);
        await sendText(sock, from, '❌ Technical error. Please try again.');
    }
}

// ═══════════════════════════════════════════════════════════════
// MESSAGE EXTRACTION (Meta Cloud API payload)
// ═══════════════════════════════════════════════════════════════
/**
 * Reduce an incoming Cloud API message object to the single string token the
 * state machine reasons about. For interactive replies the *button/list id*
 * is returned so each row's `id` continues to drive routing.
 *
 * @param {object} msg The element from value.messages[]
 * @returns {string|null}
 */
function extractMessageText(msg) {
    if (!msg || typeof msg !== 'object') return null;

    switch (msg.type) {
        case 'text':
            return (msg.text?.body || '').trim() || null;

        case 'button':
            // Quick-reply template button click.
            return (msg.button?.payload || msg.button?.text || '').trim() || null;

        case 'interactive': {
            const interactive = msg.interactive || {};
            if (interactive.type === 'button_reply') {
                return (interactive.button_reply?.id || '').trim() || null;
            }
            if (interactive.type === 'list_reply') {
                return (interactive.list_reply?.id || '').trim() || null;
            }
            if (interactive.type === 'nfm_reply') {
                try {
                    const json = JSON.parse(interactive.nfm_reply?.response_json || '{}');
                    return json.id || json.flow_token || null;
                } catch (_) {
                    return null;
                }
            }
            return null;
        }

        case 'image':
        case 'audio':
        case 'video':
        case 'document':
        case 'sticker':
            // Media-only messages are not understood by the state machine; treat
            // them as an unrecognised input so the bot falls back to the help
            // prompt rather than ignoring the customer entirely.
            return msg.image?.caption || msg.video?.caption || msg.document?.caption || '';

        default:
            return null;
    }
}

// ═══════════════════════════════════════════════════════════════
// SESSION MANAGEMENT
// ═══════════════════════════════════════════════════════════════
function createNewSession() {
    return {
        state: 'START',
        lang: 'en',
        cart: [],
        restaurant_id: null,
        restaurant_name: null,
        support_phone: null,
        table_number: null,
        table_id: null,
        waiter_id: null,
        waiter_name: null,
        customer_name: null,
        active_order_id: null,
        order_total: 0,
        menu_cache: null,
        current_category: null,
        ussd_phone: null,
        ussd_provider: null,
        rating: null,
        pending_item: null,
        pending_qty: 1,
        quick_payment_id: null,
        quick_payment_amount: null,
        quick_payment_desc: null,
        quick_payment_network: null,
        tip_waiter_id: null,
        tip_waiter_name: null,
        tip_pool_id: null,
        tip_pool_name: null,
        feedback_waiter_id: null,
        feedback_waiter_name: null,
        bill_image_sent_for_order: null,
        pending_order_lines: null,
        menu_options: null,
        header_info: null,
        search_results: null,
    };
}

/** Reset the live session object (and DB) after Leave / Exit. */
async function clearCustomerSession(waId, session) {
    const preserved = {
        customer_name: session.customer_name ?? null,
        lang: session.lang || 'en',
    };

    Object.keys(session).forEach((key) => {
        delete session[key];
    });
    Object.assign(session, createNewSession(), preserved);

    sessions[waId] = session;
    await sessionStore.clear(waId);
}

function isLeaveCommand(text) {
    const t = String(text || '').toLowerCase().trim();

    return t === 'exit_bot'
        || t === 'leave'
        || t.includes('leave')
        || t.includes('exit');
}

// ═══════════════════════════════════════════════════════════════
// UNIFIED ENTRY HANDLER (QR & TAGS)
// ═══════════════════════════════════════════════════════════════
async function handleEntry(sock, from, session, text) {
    try {
        const customerPhone = from.split('@')[0];
        const result = await api.parseEntry(text, {
            wa_id: customerPhone,
            customer_phone: customerPhone,
        });
        console.log('🔍 Parse Entry Result:', JSON.stringify(result, null, 2));

        if (result.type === 'waiter') {
            // Waiter Assignment
            session.restaurant_id = result.data.restaurant_id;
            session.restaurant_name = result.data.restaurant_name;
            session.support_phone = result.data.support_phone || null;
            session.waiter_id = result.data.waiter_id;
            session.waiter_name = result.data.waiter_name;
            session.header_info = result.data.waiter_name; // Set header for Home Screen

            // Do not send standalone "Welcome to X! Y will be your waiter." — go straight to menu only.
            // (API may send skip_standalone_welcome; we always skip here so the first bubble never appears.)

            // If we don't have a table yet, maybe ask for it or just go home?
            // Assuming we go to Home, but without a table number some features might be limited.
            // However, the user didn't specify asking for a table after waiter scan.
            // Let's go to Home.
            await showHomeScreen(sock, from, session);

        } else if (result.type === 'table') {
            // Table / restaurant QR — no assigned waiter; show customer support, not call waiter
            session.restaurant_id = result.data.restaurant_id;
            session.restaurant_name = result.data.restaurant_name;
            session.support_phone = result.data.support_phone || null;
            session.waiter_id = null;
            session.waiter_name = null;
            session.table_id = result.data.table_id;
            session.table_number = result.data.table_number || result.data.table_name; // Assuming 'number' is the display number
            session.header_info = `Table ${session.table_number}`; // Set header for Home Screen

            // Do not send standalone welcome line — go straight to menu only.
            await showHomeScreen(sock, from, session);

} else {
            await sendText(sock, from,
                `❌ ${T(session, 'invalid_qr')}\n\n` +
                'No QR code? No problem! Please type the code START-_-_W** to proceed.'
            );
            session.state = 'SEARCH_RESTAURANT';
        }
    } catch (error) {
        console.error('Entry error:', error);
        await sendText(sock, from, `❌ ${T(session, 'error_try_again')}`);
        session.state = 'SEARCH_RESTAURANT';
    }
}

// ═══════════════════════════════════════════════════════════════
// STATE HANDLERS
// ═══════════════════════════════════════════════════════════════

async function handleStartState(sock, from, session, text) {
    await sendStartWelcome(sock, from, session);
    session.state = 'SEARCH_RESTAURANT';
}

async function handleSearchState(sock, from, session, text) {
    // Handle numbered selection
    const selection = parseInt(text);
    if (!isNaN(selection) && session.search_results) {
        if (selection === 0) {
            await sendText(sock, from, 'Type the restaurant name:');
            return;
        }

        const restaurant = session.search_results[selection - 1];
        if (restaurant) {
            session.restaurant_id = restaurant.id;
            session.restaurant_name = restaurant.name;
            session.support_phone = restaurant.support_phone || null;

            if (!session.table_number) {
                await showTableSelection(sock, from, session);
                session.state = 'PICK_TABLE';
            } else {
                await showHomeScreen(sock, from, session);
            }
            return;
        }
    }

    if (text.startsWith('pick_rest_')) {
        session.restaurant_id = text.replace('pick_rest_', '');
        try {
            const result = await api.verifyRestaurant(session.restaurant_id, null);
            if (result.success) {
                session.restaurant_name = result.data.name;
                session.support_phone = result.data.support_phone || null;
            }
        } catch (e) { }

        if (!session.table_number) {
            await showTableSelection(sock, from, session);
            session.state = 'PICK_TABLE';
        } else {
            await showHomeScreen(sock, from, session);
        }
    } else if (text === 'search_again') {
        await sendText(sock, from, 'Type the restaurant name:');
    } else {
        await handleSearchRestaurant(sock, from, session, text);
    }
}

async function handleTableState(sock, from, session, text) {
    if (text.startsWith('table_')) {
        const val = text.replace('table_', '');
        if (val === 'type') {
            session.state = 'TABLE_INPUT';
            await sendText(sock, from, T(session, 'enter_table'));
        } else {
            session.table_number = val;
            await showHomeScreen(sock, from, session);
        }
    } else if (!isNaN(text) && parseInt(text) > 0) {
        session.table_number = text;
        await showHomeScreen(sock, from, session);
    } else {
        await sendText(sock, from, T(session, 'valid_table'));
    }
}

async function handleHomeState(sock, from, session, text) {
    const t = text.toLowerCase();

    if (t === 'home_more_1') {
        await showHomeMoreScreen(sock, from, session, 1);
        return;
    }

    if (t === 'home_more_2') {
        await showHomeMoreScreen(sock, from, session, 2);
        return;
    }

    if (t === 'home_back_main') {
        await showHomeScreen(sock, from, session);
        return;
    }

    // New Menu Options Mapping
    // Menu = menu PDF only (no list menu from main screen)
    if (t === 'view_menu' || t.includes('menu')) {
        await showMenuImage(sock, from, session);
        return;
    }
    if (t === 'track_order' || t === 'status' || t.includes('track')) {
        await showTrackStatus(sock, from, session);
    } else if (t === 'rate_service' || t.includes('rate')) {
        if (session.waiter_id && session.waiter_name) {
            session.feedback_waiter_id = session.waiter_id;
            session.feedback_waiter_name = session.waiter_name;
            await showFeedbackA(sock, from, session);
        } else {
            await showFeedbackTypeSelection(sock, from, session);
        }
    } else if (t === 'live_bill' || t === 'pay_bill' || t.includes('bill') || t.includes('lipa')) {
        await showLiveBillOptions(sock, from, session);
    } else if (t === 'give_tips' || t.includes('tip')) {
        let autoTipOk = false;
        if (session.waiter_id && session.waiter_name) {
            try {
                const tippable = await api.getWaiters(session.restaurant_id, { tippableOnly: true });
                autoTipOk = !!(tippable?.success && Array.isArray(tippable.data)
                    && tippable.data.some((w) => String(w.id) === String(session.waiter_id)));
            } catch (e) {
                console.error('Tippable waiter check error:', e);
            }
        }
        if (autoTipOk) {
            session.tip_waiter_id = session.waiter_id;
            session.tip_waiter_name = session.waiter_name;
            delete session.tip_pool_id;
            delete session.tip_pool_name;
            session.quick_payment_desc = `Tip for ${session.tip_waiter_name}`;
            await showQuickPaymentAmount(sock, from, session);
        } else {
            await showWaiterTipList(sock, from, session);
        }
    } else if (t === 'call_waiter') {
        if (session.waiter_id) {
            // Check waiter online status FIRST (before asking table) when customer has specific waiter (e.g. from QR)
            let statusRes;
            try {
                statusRes = await api.getWaiterStatus(session.waiter_id);
            } catch (e) {
                console.error('Waiter status check error:', e);
            }
            if (statusRes && statusRes.success && statusRes.data && !statusRes.data.is_online) {
                const waiterName = statusRes.data.name || session.waiter_name || 'Waiter';
                const msg = T(session, 'waiter_offline_msg').replace(/{name}/g, waiterName);
                await sendText(sock, from, `⚠️ ${msg}`);
                return;
            }
            if (session.table_number || session.table_id) {
                await initiateCallWaiter(sock, from, session, 'call_waiter', 'Call Waiter');
            } else {
                session.state = 'CALL_WAITER_ASK_TABLE';
                session.pending_call_type = 'call_waiter';
                session.pending_call_label = 'Call Waiter';
                await showCallWaiterAskTable(sock, from, session);
            }
        } else {
            await showWaitersList(sock, from, session);
        }
    } else if (t === 'customer_support' || t.includes('support')) {
        if (session.support_phone) {
            // One message only: support number + "Type 0 to go back". No extra "Choose: 1 Back to Menu" bubble.
            await sendText(sock, from,
                `📞 *${T(session, 'support_title')}*\n\n` +
                `${T(session, 'support_call')} *${session.support_phone}*\n\n` +
                `_${T(session, 'support_type_zero')}_`
            );
        } else {
            await showHomeScreen(sock, from, session);
        }
    } else if (t === 'change_language' || t.includes('language') || t.includes('lugha')) {
        await showLanguageSelect(sock, from, session);
    } else {
        await showHomeScreen(sock, from, session);
    }
}

async function handleCallWaiterState(sock, from, session, text) {
    if (text === 'call_only') {
        await initiateCallWaiter(sock, from, session, 'call_waiter', 'Call Waiter');
    } else if (text === 'request_bill') {
        await initiateCallWaiter(sock, from, session, 'request_bill', 'Request Bill');
    } else if (text === 'list_waiters') {
        await showWaitersList(sock, from, session);
    } else if (text === 'home') {
        await showHomeScreen(sock, from, session);
    } else {
        await showCallWaiterOptions(sock, from, session);
    }
}

async function handleWaitersListState(sock, from, session, text) {
    if (text.startsWith('call_waiter_')) {
        const rest = text.replace('call_waiter_', '');
        const pipe = rest.indexOf('|');
        const waiterId = pipe >= 0 ? rest.slice(0, pipe) : null;
        const waiterName = pipe >= 0 ? rest.slice(pipe + 1) : rest;
        if (waiterId) session.waiter_id = waiterId;
        if (waiterName) session.waiter_name = waiterName;
        const apiType = pipe >= 0 ? 'call_waiter' : `call_waiter_${waiterName}`;
        await initiateCallWaiter(sock, from, session, apiType, waiterName ? `Call ${waiterName}` : 'Call Waiter');
    } else if (text === 'home') {
        await showHomeScreen(sock, from, session);
    } else {
        await showWaitersList(sock, from, session);
    }
}

async function showCallWaiterAskTable(sock, from, session) {
    try {
        const result = await api.getRestaurantTables(session.restaurant_id);
        if (result.success && result.data && result.data.length > 0) {
            session.call_waiter_tables = result.data;
            session.menu_options = {};
            let msg = `🪑 *${T(session, 'order_which_table')}*\n\n${T(session, 'choose')}\n`;
            result.data.slice(0, 10).forEach((t, i) => {
                const num = (i + 1).toString();
                session.menu_options[num] = `table_${t.id}`;
                msg += `${num}. ${t.name}\n`;
            });
            msg += `\n_${T(session, 'order_reply_table_number')}_`;
            await sendText(sock, from, msg);
        } else {
            await sendText(sock, from, `🪑 ${T(session, 'order_which_table')}\n\n${T(session, 'enter_table')}`);
        }
    } catch (e) {
        console.error('getRestaurantTables error:', e);
        await sendText(sock, from, `🪑 ${T(session, 'order_which_table')}\n\n${T(session, 'enter_table')}`);
    }
}

/** Ask which table (for order) — tables fetched from manager via API. Used before submitting text order or cart. */
async function showOrderTableSelect(sock, from, session) {
    session.state = 'PICK_TABLE_FOR_ORDER';
    try {
        const result = await api.getRestaurantTables(session.restaurant_id);
        if (result.success && result.data && result.data.length > 0) {
            session.order_tables = result.data;
            session.menu_options = {};
            let msg = `🪑 *${T(session, 'order_which_table')}*\n\n`;
            result.data.slice(0, 15).forEach((t, i) => {
                const num = (i + 1).toString();
                session.menu_options[num] = `table_${t.id}`;
                msg += `${getNumberEmoji(i + 1)} ${t.name}\n`;
            });
            msg += `\n_${T(session, 'order_reply_table_number')}_`;
            await sendText(sock, from, msg);
        } else {
            await sendText(sock, from, `🪑 ${T(session, 'order_which_table')}\n\n${T(session, 'enter_table')}`);
        }
    } catch (e) {
        console.error('getRestaurantTables error:', e);
        await sendText(sock, from, `🪑 ${T(session, 'order_which_table')}\n\n${T(session, 'enter_table')}`);
    }
}

async function handlePickTableForOrderState(sock, from, session, text) {
    if (text === 'home' || text === '0') {
        session.state = 'HOME';
        delete session.pending_order_text;
        session.pending_order_lines = null;
        delete session.pending_table_for;
        delete session.order_tables;
        await showHomeScreen(sock, from, session);
        return;
    }
    let tableNumber = null;
    let tableId = null;
    const tables = session.order_tables || [];
    ({ tableNumber, tableId } = resolveTableFromInput(text, tables, session.menu_options || {}));
    if (!tableNumber && !tableId) {
        // Accept any table number as free text (e.g. "5") so order goes with that table even if not in list
        const trimmed = String(text).trim();
        if (trimmed.length > 0 && trimmed.length <= 20) {
            session.table_number = trimmed;
            session.table_id = null;
        } else {
            await sendText(sock, from, T(session, 'valid_table'));
            return;
        }
    } else {
        session.table_number = tableNumber || tableId;
        session.table_id = tableId ? parseInt(tableId, 10) : null;
    }
    const forWhat = session.pending_table_for;
    delete session.pending_table_for;
    delete session.order_tables;

    if (forWhat === 'text_order' && session.pending_order_text) {
        const orderText = session.pending_order_text;
        delete session.pending_order_text;
        await sendText(sock, from, `🔄 ${T(session, 'processing_order')}`);
        try {
            const result = await api.createOrderText({
                restaurant_id: session.restaurant_id,
                table_id: session.table_id,
                table_number: session.table_number,
                waiter_id: session.waiter_id,
                customer_name: session.customer_name,
                customer_phone: from.split('@')[0],
                whatsapp_jid: from,
                order_text: orderText
            });
            if (result.success && result.order) {
                session.active_order_id = result.order.id;
                session.order_total = result.order.total;
                session.cart = [];
                let msg = `✅ *${T(session, 'order_received')}*\n`;
                msg += `🧾 ${T(session, 'order_id')}${result.order.id}\n`;
                msg += `🛒 *${T(session, 'items_found')}*\n`;
                if (result.order.items && result.order.items.length > 0) {
                    result.order.items.forEach(item => {
                        msg += `• ${item.name} x${item.quantity} = ${item.total?.toLocaleString()}/=\n`;
                    });
                }
                msg += `\n💰 *${T(session, 'total')} ${result.order.total?.toLocaleString()}/=*`;
                msg += `\n\n${T(session, 'waiter_confirm')}`;
                await sendButtons(sock, from, msg, [
                    { id: 'go_payment', text: `💳 ${T(session, 'pay_now')}` },
                    { id: 'track_order', text: `📍 ${T(session, 'track_status')}` },
                    { id: 'home', text: `🏠 ${T(session, 'home')}` }
                ], '🧾✨');
                session.state = 'HOME';
            } else {
                await sendText(sock, from, result.message || T(session, 'error_order'));
                session.state = 'MENU_IMAGE_ORDER';
                await showMenuImage(sock, from, session);
            }
        } catch (e) {
            console.error('Create order (text) error:', e);
            await sendText(sock, from, '❌ ' + T(session, 'error_try_again'));
            session.state = 'MENU_IMAGE_ORDER';
            await showMenuImage(sock, from, session);
        }
        return;
    }

    if (forWhat === 'cart') {
        await createOrder(sock, from, session);
    }
}

const BOT_MENU_BUTTON_IDS = new Set([
    'change_language', 'call_waiter', 'rate_service', 'view_menu', 'track_order',
    'go_payment', 'pay_cash', 'give_tips', 'customer_support', 'exit_bot',
    'home', 'home_more_1', 'home_more_2', 'home_back_main', 'call_only',
    'request_bill', 'list_waiters', 'lang_en', 'lang_sw', 'search_food',
]);

function isBotMenuButtonId(text) {
    const t = String(text || '').trim().toLowerCase();
    if (!t) {
        return true;
    }
    if (BOT_MENU_BUTTON_IDS.has(t)) {
        return true;
    }
    if (t.startsWith('lang_') || t.startsWith('rate_') || t.startsWith('call_waiter_')) {
        return true;
    }
    if (t.includes('_') && !/^\d+$/.test(t)) {
        return true;
    }
    return false;
}

function sanitizeSessionTableNumber(session) {
    if (isBotMenuButtonId(session.table_number)) {
        session.table_number = null;
    }
}

function isValidManualTableInput(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed || trimmed.length > 20) {
        return false;
    }
    return !isBotMenuButtonId(trimmed);
}

/**
 * Resolve a table from user input. Handles:
 * - Smart-menu mapped values like "table_42" (after user typed "1")
 * - Raw list numbers ("1", "2")
 * - Table names ("Mawenzi")
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

async function handleCallWaiterAskTableState(sock, from, session, text) {
    if (text === 'home') {
        session.state = 'HOME';
        await showHomeScreen(sock, from, session);
        return;
    }
    if (text === 'change_language' || String(text).toLowerCase().includes('language')) {
        session.state = 'HOME';
        await showLanguageSelect(sock, from, session);
        return;
    }
    let tableNumber = null;
    let tableId = null;
    const tables = session.call_waiter_tables || [];
    ({ tableNumber, tableId } = resolveTableFromInput(text, tables, session.menu_options || {}));
    if (tableNumber || tableId) {
        if (tableNumber) session.table_number = tableNumber;
        if (tableId) session.table_id = tableId;
        const apiType = session.pending_call_type || 'call_waiter';
        const label = session.pending_call_label || 'Call Waiter';
        session.state = 'HOME';
        await initiateCallWaiter(sock, from, session, apiType, label);
    } else {
        const trimmed = String(text).trim();
        if (isValidManualTableInput(trimmed)) {
            session.table_number = trimmed;
            session.table_id = null;
            const apiType = session.pending_call_type || 'call_waiter';
            const label = session.pending_call_label || 'Call Waiter';
            session.state = 'HOME';
            await initiateCallWaiter(sock, from, session, apiType, label);
        } else {
            await sendText(sock, from, `❌ ${T(session, 'call_waiter_table_invalid')}`);
            await showCallWaiterAskTable(sock, from, session);
        }
    }
}

async function initiateCallWaiter(sock, from, session, apiType, displayName) {
    try {
        sanitizeSessionTableNumber(session);
        // If customer has a specific waiter (from QR scan), check if they're online first
        if (session.waiter_id) {
            let statusRes;
            try {
                statusRes = await api.getWaiterStatus(session.waiter_id);
            } catch (e) {
                console.error('Waiter status check error:', e);
            }
            if (statusRes && statusRes.success && statusRes.data && !statusRes.data.is_online) {
                const waiterName = statusRes.data.name || session.waiter_name || 'Waiter';
                const msg = T(session, 'waiter_offline_msg').replace(/{name}/g, waiterName);
                await sendText(sock, from, `⚠️ ${msg}`);
                session.state = 'HOME';
                return;
            }
        }

        const payload = {
            restaurant_id: session.restaurant_id,
            table_number: session.table_number || '',
            waiter_id: session.waiter_id,
            request_type: apiType
        };
        if (session.table_id) payload.table_id = session.table_id;
        await api.callWaiter(payload);

        await sendText(sock, from, buildCallWaiterSent(session, T, displayName));
        await showHomeScreen(sock, from, session);
    } catch (e) {
        console.error('Call waiter error:', e);
        await sendText(sock, from, `❌ ${T(session, 'call_waiter_failed')}`);
        await showHomeScreen(sock, from, session);
    }
}

async function handleMenuHubState(sock, from, session, text) {
    const t = text.toLowerCase();
    if (text.startsWith('cat_')) {
        const categoryId = text.replace('cat_', '');
        session.current_category = categoryId;
        await showItemsList(sock, from, session, categoryId);
    } else if (t.includes('chakula') || t.includes('vinywaji') || t.includes('drink') || t.includes('zaidi')) {
        await showMenuHub(sock, from, session);
    } else if (t === 'home' || t.includes('home') || t.includes('nyuma')) {
        await showHomeScreen(sock, from, session);
    } else {
        await showMenuHub(sock, from, session);
    }
}

async function showCategoriesList(sock, from, session, type) {
    session.state = 'CATEGORIES';

    try {
        if (!session.menu_cache) {
            const result = await api.getFullMenu(session.restaurant_id);
            if (result.success) {
                session.menu_cache = result.data;
            }
        }

        if (session.menu_cache && session.menu_cache.length > 0) {
            const rows = session.menu_cache.map(c => ({
                id: `cat_${c.id}`,
                title: `${c.name} (${c.menu_items?.length || 0})`,
                description: `${c.menu_items?.length || 0} items`
            }));

            rows.push({ id: 'home', title: '🏠 Home', description: '' });

            await sendList(sock, from,
                '📂 *Select Category*',
                'View Categories',
                [{ title: 'Categories', rows }]
            );
        } else {
            await sendText(sock, from, 'Sorry, menu is unavailable.');
            await showHomeScreen(sock, from, session);
        }
    } catch (e) {
        console.error('Fetch categories error:', e);
        await showHomeScreen(sock, from, session);
    }
}

async function handleCategoriesState(sock, from, session, text) {
    if (text.startsWith('cat_')) {
        const categoryId = text.replace('cat_', '');
        session.current_category = categoryId;
        await showItemsList(sock, from, session, categoryId);
    } else if (text === 'back_menu') {
        await showMenuHub(sock, from, session);
    } else if (text === 'home') {
        await showHomeScreen(sock, from, session);
    }
}

async function handleItemsListState(sock, from, session, text) {
    if (text.startsWith('item_')) {
        const itemId = text.replace('item_', '');
        await showItemDetail(sock, from, session, itemId);
    } else if (text === 'back_categories') {
        await showCategoriesList(sock, from, session, session.current_category_type);
    } else if (text === 'home') {
        await showHomeScreen(sock, from, session);
    }
}

async function handleItemDetailState(sock, from, session, text) {
    if (text.startsWith('add_')) {
        const itemId = text.replace('add_', '');
        session.pending_item = itemId;
        session.pending_qty = 1;
        await showQuantitySelection(sock, from, session, itemId);
        session.state = 'QUANTITY';
    } else if (text === 'back_items') {
        await showItemsList(sock, from, session, session.current_category);
    } else if (text === 'go_cart') {
        await showCart(sock, from, session);
    } else if (text === 'home') {
        await showHomeScreen(sock, from, session);
    }
}

async function handleQuantityState(sock, from, session, text) {
    if (text.startsWith('qty_')) {
        const parts = text.split('_');
        if (parts[1] === 'plus') {
            session.pending_qty++;
            await showQuantityMore(sock, from, session);
        } else if (parts[1] === 'minus') {
            session.pending_qty = Math.max(1, session.pending_qty - 1);
            await showQuantityMore(sock, from, session);
        } else if (parts[1] === 'done') {
            await addToCart(sock, from, session, session.pending_item, session.pending_qty);
        } else {
            const qty = parseInt(parts[1]);
            if (qty <= 3) {
                await addToCart(sock, from, session, session.pending_item, qty);
            } else {
                session.pending_qty = 3;
                session.state = 'QUANTITY_MORE';
                await showQuantityMore(sock, from, session);
            }
        }
    } else if (text === 'qty_more') {
        session.pending_qty = 3;
        session.state = 'QUANTITY_MORE';
        await showQuantityMore(sock, from, session);
    }
}

async function handleCartState(sock, from, session, text) {
    switch (text) {
        case 'confirm_order':
            await showConfirmOrder(sock, from, session);
            break;
        case 'edit_cart':
            await showCartEdit(sock, from, session);
            break;
        case 'clear_cart':
            session.cart = [];
            await sendText(sock, from, '🗑️ Cart cleared.');
            await showHomeScreen(sock, from, session);
            break;
        case 'home':
            await showHomeScreen(sock, from, session);
            break;
        case 'continue_menu':
            await showMenuHub(sock, from, session);
            break;
    }
}

async function handleCartEditState(sock, from, session, text) {
    if (text.startsWith('remove_')) {
        const idx = parseInt(text.replace('remove_', ''));
        if (session.cart[idx]) {
            const removed = session.cart.splice(idx, 1)[0];
            await sendText(sock, from, `❌ ${removed.name} removed.`);
        }
        await showCart(sock, from, session);
    } else if (text === 'back_cart') {
        await showCart(sock, from, session);
    }
}

async function handleConfirmOrderState(sock, from, session, text) {
    switch (text) {
        case 'confirm_yes':
            if (!session.table_number && !session.table_id) {
                session.pending_table_for = 'cart';
                await showOrderTableSelect(sock, from, session);
            } else {
                await createOrder(sock, from, session);
            }
            break;
        case 'back_cart':
            await showCart(sock, from, session);
            break;
        case 'cancel_order':
            session.cart = [];
            await sendText(sock, from, '❌ Order cancelled.');
            await showHomeScreen(sock, from, session);
            break;
    }
}

async function handlePaymentSummaryState(sock, from, session, text) {
    switch (text) {
        case 'pay_cash':
            await showCashPayment(sock, from, session);
            break;
        case 'pay_mobile':
            session.state = 'USSD_NUMBER';
            await sendText(sock, from, `📱 ${T(session, 'enter_phone_billed')}`);
            break;
        case 'home':
            await showHomeScreen(sock, from, session);
            break;
    }
}

async function handleCashPaymentState(sock, from, session, text) {
    switch (text) {
        case 'cash_paid':
            await sendText(sock, from,
                '✅ Thank you!\n\nWaiting for waiter to confirm payment...'
            );
            await offerPostPaymentTipOrContinue(sock, from, session);
            break;
        case 'track_order':
            await showTrackStatus(sock, from, session);
            break;
        case 'home':
            await showHomeScreen(sock, from, session);
            break;
    }
}

async function handleProviderSelectState(sock, from, session, text) {
    if (text.startsWith('provider_')) {
        session.ussd_provider = text.replace('provider_', '');
        session.state = 'USSD_NUMBER';
        await sendText(sock, from, `📱 ${T(session, 'enter_phone_billed')}`);
    } else if (text === 'back_payment') {
        await showPaymentSummary(sock, from, session);
    }
}

async function handleUssdNumberState(sock, from, session, text) {
    // Validate phone number
    if (/^(0\d{9}|255\d{9})$/.test(text)) {
        session.ussd_phone = text.startsWith('255') ? '0' + text.slice(3) : text;
        session.ussd_provider = detectNetwork(session.ussd_phone);
        await showPayNow(sock, from, session);
    } else {
        await sendText(sock, from, '❌ Invalid number. Enter like 0712345678 or 255712345678');
    }
}

async function handlePayNowState(sock, from, session, text) {
    switch (text) {
        case 'paynow':
            await initiateUssdPayment(sock, from, session);
            break;
        case 'change_number':
            session.state = 'USSD_NUMBER';
            await sendText(sock, from, 'Andika namba mpya ya simu:');
            break;
        case 'back_provider':
            await showProviderSelect(sock, from, session);
            break;
    }
}

async function handleUssdPendingState(sock, from, session, text) {
    switch (text) {
        case 'check_status':
            await checkPaymentStatus(sock, from, session);
            break;
        case 'cancel_payment':
            await showPaymentSummary(sock, from, session);
            break;
        case 'manual_ussd':
            await showManualUssd(sock, from, session);
            break;
        case 'home':
            await showHomeScreen(sock, from, session);
            break;
    }
}

async function handleManualUssdState(sock, from, session, text) {
    if (text === 'manual_paid') {
        session.state = 'USSD_PENDING';
        await sendText(sock, from, 'Enter Transaction ID (e.g., MPESA123XYZ):');
    } else if (text === 'pay_cash') {
        await showCashPayment(sock, from, session);
    } else if (text === 'home') {
        await showHomeScreen(sock, from, session);
    } else {
        // Assume it's a transaction ID
        session.transaction_id = text;
        await sendText(sock, from, '✅ Transaction ID received.\nWaiting for confirmation...');
        await showPostPaymentOptions(sock, from, session);
    }
}

async function handleTrackStatusState(sock, from, session, text) {
    switch (text) {
        case 'refresh':
            await showTrackStatus(sock, from, session);
            break;
        case 'go_payment':
            await showPaymentSummary(sock, from, session);
            break;
        case 'rate_service':
            await showFeedbackTypeSelection(sock, from, session);
            break;
        case 'home':
            await showHomeScreen(sock, from, session);
            break;
    }
}

async function handleFeedbackState(sock, from, session, text) {
    if (session.state === 'FEEDBACK_TYPE') {
        if (text === 'rate_restaurant') {
            session.feedback_waiter_id = null;
            session.feedback_waiter_name = null;
            await showFeedbackA(sock, from, session);
        } else if (text === 'rate_waiter') {
            if (session.waiter_id && session.waiter_name) {
                // Auto-select assigned waiter
                session.feedback_waiter_id = session.waiter_id;
                session.feedback_waiter_name = session.waiter_name;
                await showFeedbackA(sock, from, session);
            } else {
                await showWaiterFeedbackList(sock, from, session);
            }
        } else if (text === 'home') {
            await showHomeScreen(sock, from, session);
        }
    } else if (session.state === 'FEEDBACK_WAITER_LIST') {
        if (text.startsWith('rate_waiter_')) {
            const parts = text.replace('rate_waiter_', '').split('|');
            session.feedback_waiter_id = parts[0];
            session.feedback_waiter_name = parts[1];
            await showFeedbackA(sock, from, session);
        } else if (text === 'home') {
            await showHomeScreen(sock, from, session);
        }
    } else if (text.startsWith('rate_')) {
        const rating = text.replace('rate_', '');
        session.rating = parseInt(rating);
        session.state = 'FEEDBACK_COMMENT';

        await sendText(sock, from, `📝 ${T(session, 'comment_prompt')}`);
    }
}

async function handleFeedbackCommentState(sock, from, session, text) {
    const comment = (text.toLowerCase() === 'end' || text.toLowerCase() === 'skip') ? '' : text;

    try {
        await api.submitFeedback({
            restaurant_id: session.restaurant_id,
            customer_phone: from.split('@')[0],
            rating: session.rating,
            comment: comment,
            waiter_id: session.feedback_waiter_id
        });
    } catch (e) {
        console.error('Feedback error:', e);
    }

    await sendText(sock, from, `🙏 ${T(session, 'thanks_feedback')}`);
    await showHomeScreen(sock, from, session);
}



// ═══════════════════════════════════════════════════════════════
// SCREEN BUILDERS
// ═══════════════════════════════════════════════════════════════

async function showHomeScreen(sock, from, session) {
    session.state = 'HOME';
    session.pending_order_lines = null;
    delete session.pending_order_text;
    delete session.tip_waiter_id;
    delete session.tip_waiter_name;
    delete session.tip_pool_id;
    delete session.tip_pool_name;
    delete session.feedback_waiter_id;
    delete session.feedback_waiter_name;
    delete session.is_post_payment_tip;
    delete session.post_payment_tip_options;
    delete session.post_payment_tip_staff_role;
    session.quick_payment_desc = null;

    const name = session.restaurant_name || 'Restaurant';

    await sendList(
        sock,
        from,
        buildHomeListBody(session, T),
        T(session, 'home_main_services'),
        buildServiceSections(session, T),
        `🏠 ${name}`,
        tapFooter(session, T),
    );
}

async function showHomeMoreScreen(sock, from, session, page) {
    const name = session.restaurant_name || 'Restaurant';

    if (page === 1) {
        await sendButtons(
            sock,
            from,
            `🏠 *${name}*\n${T(session, 'home_choose')}`,
            [
                { id: 'rate_service', text: `⭐ ${T(session, 'rate_service')}` },
                { id: 'give_tips', text: `💵 ${T(session, 'tip')}` },
                { id: 'home_more_2', text: '➡️ More' },
            ],
            '✨ More Services',
            `_${T(session, 'home_type_zero')}_`
        );
        return;
    }

    const actionButtons = [];

    if (session.waiter_id) {
        actionButtons.push({ id: 'call_waiter', text: `🔔 ${T(session, 'call_waiter')}` });
    } else if (session.support_phone) {
        actionButtons.push({ id: 'customer_support', text: `📞 ${T(session, 'customer_support')}` });
    }

    actionButtons.push({ id: 'change_language', text: `🌐 ${T(session, 'change_language')}` });
    actionButtons.push({ id: 'exit_bot', text: `❌ ${T(session, 'exit')}` });

    if (actionButtons.length < 3) {
        actionButtons.push({ id: 'home_back_main', text: `⬅️ ${T(session, 'back_to_menu')}` });
    }

    await sendButtons(
        sock,
        from,
        `🏠 *${name}*\n${T(session, 'home_choose')}`,
        actionButtons,
        '⚙️ Settings',
        `_${T(session, 'home_type_zero')}_`
    );
}

async function showLanguageSelect(sock, from, session) {
    session.state = 'LANGUAGE_SELECT';
    await sendButtons(sock, from, buildLanguagePrompt(session, T), [
        { id: 'lang_en', text: `🇬🇧 ${T(session, 'lang_english')}` },
        { id: 'lang_sw', text: `🇹🇿 ${T(session, 'lang_swahili')}` },
    ], `${TAP.primary} TAP`, tapFooter(session, T));
}

async function handleLanguageSelectState(sock, from, session, text) {
    if (text === 'lang_en') {
        session.lang = 'en';
        await sendText(sock, from, T(session, 'language_changed'));
        await showHomeScreen(sock, from, session);
    } else if (text === 'lang_sw') {
        session.lang = 'sw';
        await sendText(sock, from, T(session, 'language_changed_sw'));
        await showHomeScreen(sock, from, session);
    } else {
        await showLanguageSelect(sock, from, session);
    }
}

async function showTableSelection(sock, from, session) {
    try {
        const result = await api.getRestaurantTables(session.restaurant_id);
        if (result.success && result.data.length > 0) {
            let text = `━━━━━━━━ 🪑 ━━━━━━━━\n`;
            text += `🧾 Choose your table:\n`;

            session.menu_options = {};
            result.data.slice(0, 10).forEach((t, i) => {
                const numEmoji = getNumberEmoji(i + 1);
                text += `${numEmoji} Table ${t.name} 👥 (People ${t.capacity})\n`;
                session.menu_options[(i + 1).toString()] = `table_${t.id}`;
            });

            text += `✅ (Choose number)\n`;
            text += `━━━━━━━━ ✨ ━━━━━━━━`;
            await sendText(sock, from, text);
        } else {
            await sendText(sock, from, 'Please enter your table number (e.g., 7):');
        }
    } catch (e) {
        console.error('Fetch tables error:', e);
        await sendText(sock, from, 'Please enter your table number (e.g., 7):');
    }
}

async function showMenuHub(sock, from, session) {
    session.state = 'MENU_HUB';

    try {
        // Use the bot-specific full-menu endpoint instead of manager categories
        if (!session.menu_cache) {
            const result = await api.getFullMenu(session.restaurant_id);
            if (result.success) {
                session.menu_cache = result.data;
            }
        }

        if (session.menu_cache && session.menu_cache.length > 0) {
            const rows = session.menu_cache.map(c => ({
                id: `cat_${c.id}`,
                title: `📂${c.name.replace(/\s/g, '')}`
            }));

            const sections = [
                {
                    title: '🔍SEARCH',
                    rows: [{ id: 'search_food', title: '🔎SearchFood' }]
                },
                {
                    title: '🍴CATEGORIES',
                    rows: rows
                },
                {
                    title: '🏠HOME',
                    rows: [{ id: 'home', title: '🔙BackHome' }]
                }
            ];

            await sendList(sock, from, '🍽️OUR_MENU', 'Menu', sections, '🍽️✨');
        } else {
            await sendText(sock, from, 'Sorry, menu is unavailable right now.');
            await showHomeScreen(sock, from, session);
        }
    } catch (e) {
        console.error('Fetch menu error:', e);
        await sendText(sock, from, 'Error fetching menu. Please try again later.');
    }
}

async function showItemsList(sock, from, session, categoryId) {
    session.state = 'ITEMS_LIST';
    session.current_category = categoryId;

    const category = (session.menu_cache || []).find(c => c.id == categoryId);

    if (category && category.menu_items && category.menu_items.length > 0) {
        if (!session.menu_items_cache) session.menu_items_cache = [];
        category.menu_items.forEach(item => {
            if (!session.menu_items_cache.find(i => i.id == item.id)) {
                session.menu_items_cache.push(item);
            }
        });

        const rows = category.menu_items.map(i => {
            const eta = itemEtaMinutes(i);
            return {
                id: `item_${i.id}`,
                title: `🍲${i.name.replace(/\s/g, '')} - ${i.price.toLocaleString()}/=`,
                description: `⏱${eta} min · ${i.price.toLocaleString()}/=`
            };
        });

        await sendList(sock, from, `🍽️${category.name.toUpperCase().replace(/\s/g, '')}`, 'Foods', [
            {
                title: '📋LIST',
                rows: rows
            },
            {
                title: '🏠HOME',
                rows: [
                    { id: 'back_menu', title: '🔙BackMenu' },
                    { id: 'go_cart', title: '🛒MyOrder' }
                ]
            }
        ], '✨🍴');
    } else {
        await sendText(sock, from, 'No items here.');
        await showMenuHub(sock, from, session);
    }
}

async function showItemDetail(sock, from, session, itemId) {
    session.state = 'ITEM_DETAIL';
    session.pending_item = itemId;

    const item = (session.menu_items_cache || []).find(i => i.id == itemId);

    if (!item) {
        await sendText(sock, from, 'Item not found.');
        return await showMenuHub(sock, from, session);
    }

    const etaMinutes = itemEtaMinutes(item);
    const etaText = formatEtaLabel(etaMinutes, session.lang || 'en');

    const text =
        `🍲*${item.name.replace(/\s/g, '')}*\n` +
        `💰${item.price?.toLocaleString()}/=\n` +
        `⏱*${etaText}*\n` +
        `${item.description ? `📝${item.description}\n` : ''}`;

    const buttons = [
        { id: `add_${itemId}`, text: '➕Add' },
        { id: 'back_items', text: '🔙Back' },
        { id: 'go_cart', text: '🛒Order' }
    ];

    if (item.image) {
        await sendImageWithButtons(sock, from, item.image, text, buttons, '🍲✨');
    } else {
        await sendButtons(sock, from, text, buttons, '🍲✨');
    }
}

async function showQuantitySelection(sock, from, session, itemId) {
    await sendList(sock, from,
        '🔢*Quantity?*',
        'Choose',
        [
            {
                title: '⚡CHOOSE',
                rows: [
                    { id: 'qty_1', title: '1' },
                    { id: 'qty_2', title: '2' },
                    { id: 'qty_3', title: '3' },
                    { id: 'qty_4', title: '4' },
                    { id: 'qty_5', title: '5' }
                ]
            },
            {
                title: '🏠HOME',
                rows: [
                    { id: 'qty_more', title: '🔢OtherNumber' }
                ]
            }
        ],
        '🔢✨'
    );
}

async function showQuantityMore(sock, from, session) {
    await sendButtons(sock, from,
        `🔢Quantity: *${session.pending_qty}*`,
        [
            { id: 'qty_plus', text: '➕+1' },
            { id: 'qty_minus', text: '➖-1' },
            { id: 'qty_done', text: '✅Done' }
        ]
    );
}

async function addToCart(sock, from, session, itemId, qty) {
    let item = (session.menu_items_cache || []).find(i => i.id == itemId);
    if (!item) return;

    const existing = session.cart.find(c => c.menu_id == itemId);
    const prepMinutes = itemEtaMinutes(item);
    if (existing) {
        existing.qty += qty;
        existing.preparation_time = prepMinutes;
        existing.eta_minutes = prepMinutes;
    } else {
        session.cart.push({
            menu_id: itemId,
            name: item.name,
            price: item.price,
            qty: qty,
            preparation_time: prepMinutes,
            eta_minutes: prepMinutes,
        });
    }

    const total = session.cart.reduce((sum, i) => sum + (i.price * i.qty), 0);
    const orderEta = cartEtaMinutes(session.cart);
    const etaText = formatEtaLabel(orderEta, session.lang || 'en');

    await sendButtons(sock, from,
        `✅*Added!*\n` +
        `${item.name} x${qty}\n` +
        `⏱${etaText}\n` +
        `Total: ${total.toLocaleString()}/=`,
        [
            { id: 'continue_menu', text: '➕Continue' },
            { id: 'go_cart', text: '🛒GoToCart' },
            { id: 'home', text: '🏠Home' }
        ]
    );
    session.state = 'CART';
}

async function showCart(sock, from, session) {
    session.state = 'CART';

    if (session.cart.length === 0) {
        await sendButtons(sock, from,
            '🛒*Cart is empty*',
            [
                { id: 'go_menu', text: '🍽️Menu' },
                { id: 'home', text: '🏠Home' }
            ]
        );
        return;
    }

    let text = '🛒*Your Cart*\n';
    let total = 0;
    session.cart.forEach((item, i) => {
        const subtotal = item.price * item.qty;
        const lineEta = itemEtaMinutes(item);
        text += `${i + 1}.${item.name} x${item.qty}=${subtotal.toLocaleString()}/= (⏱${lineEta}m)\n`;
        total += subtotal;
    });
    const orderEta = cartEtaMinutes(session.cart);
    text += `⏱*${formatEtaLabel(orderEta, session.lang || 'en')}*\n`;
    text += `💰*Total: ${total.toLocaleString()}/=*`;
    session.order_total = total;
    session.order_eta_minutes = orderEta;

    await sendList(sock, from, text, 'Choose', [
        {
            title: '⚡ACTIONS',
            rows: [
                { id: 'confirm_order', title: '✅Confirm' },
                { id: 'continue_menu', title: '➕AddMore' },
                { id: 'edit_cart', title: '✏️Edit' }
            ]
        },
        {
            title: '🏠HOME',
            rows: [
                { id: 'home', title: '🔙BackHome' }
            ]
        }
    ], '🛒✨');
}

async function showCartEdit(sock, from, session) {
    session.state = 'CART_EDIT';
    const rows = session.cart.map((item, i) => ({
        id: `remove_${i}`,
        title: `❌${item.name.replace(/\s/g, '')} (x${item.qty})`,
        description: `x${item.qty}`
    }));
    rows.push({ id: 'back_cart', title: '🔙BackCart' });

    await sendList(sock, from, '✏️*EditCart*', 'View Items', [{ title: 'Items', rows }], '✏️✨');
}

async function showConfirmOrder(sock, from, session) {
    session.state = 'CONFIRM_ORDER';
    let text = `🧾*Confirm Order*\n`;
    text += `📍Table:${session.table_number}\n`;
    session.cart.forEach(item => { text += `•${item.name} x${item.qty}\n`; });
    text += `💰*Total:${session.order_total.toLocaleString()}/=*`;

    await sendButtons(sock, from, text, [
        { id: 'confirm_yes', text: '✅Confirm' },
        { id: 'back_cart', text: '🔙Back' },
        { id: 'cancel_order', text: '❌Cancel' }
    ], '🧾✨');
}

async function createOrder(sock, from, session) {
    try {
        const result = await api.createOrder({
            restaurant_id: session.restaurant_id,
            table_id: session.table_id,
            table_number: session.table_number,
            customer_phone: from.split('@')[0],
            customer_name: session.customer_name,
            whatsapp_jid: from,
            items: session.cart,
            waiter_id: session.waiter_id
        });

        if (result.success) {
            session.active_order_id = result.order_id;
            session.order_total = result.total;
            session.cart = [];

            await sendButtons(sock, from,
                `✅*Order Received!*\n` +
                `🧾#${result.order_id}\n` +
                `💰${result.total.toLocaleString()}/=\n` +
                `Waiter is coming...`,
                [
                    { id: 'go_payment', text: '💳PayNow' },
                    { id: 'track_order', text: '📍Track' },
                    { id: 'home', text: '🏠Home' }
                ]
            );
            session.state = 'HOME';
        }
    } catch (error) {
        console.error('Create order error:', error);
        await sendText(sock, from, '❌Error creating order.');
    }
}

async function showPaymentSummary(sock, from, session) {
    session.state = 'PAYMENT_SUMMARY';
    if (!session.active_order_id) {
        await sendText(sock, from, 'No active order to pay.');
        return await showHomeScreen(sock, from, session);
    }

    let text = '🧾*Your Bill*\n';
    text += `📋#${session.active_order_id}\n`;
    text += `💰*Total:${session.order_total?.toLocaleString() || 0}/=*\n`;

    await sendList(sock, from, text, 'Payment', [
        {
            title: '💳PAYMENT',
            rows: [
                { id: 'pay_mobile', title: '📲MobileMoney' },
                { id: 'pay_cash', title: '💵Cash' }
            ]
        },
        {
            title: '🏠HOME',
            rows: [
                { id: 'home', title: '🔙BackHome' }
            ]
        }
    ], '💳✨');
}

async function showCashPayment(sock, from, session) {
    session.state = 'CASH_PAYMENT';
    await sendButtons(sock, from,
        '💵*You chose CASH*\n' +
        'Please pay the waiter.\n' +
        'After paying, press "I HAVE PAID".',
        [
            { id: 'cash_paid', text: '✅I HAVE PAID' },
            { id: 'track_order', text: '📍Track' },
            { id: 'home', text: '🏠Home' }
        ]
    );
}

async function showProviderSelect(sock, from, session) {
    session.state = 'PROVIDER_SELECT';
    const rows = [
        { id: 'provider_mpesa', title: 'M-Pesa' },
        { id: 'provider_tigopesa', title: 'TigoPesa' },
        { id: 'provider_airtelmoney', title: 'AirtelMoney' },
        { id: 'provider_halopesa', title: 'HaloPesa' },
        { id: 'back_payment', title: '🔙Back' }
    ];
    await sendList(sock, from, '📲*MobileMoney*', 'Choose', [{ title: 'Networks', rows }], '📲✨');
}

async function showPayNow(sock, from, session) {
    session.state = 'PAY_NOW';
    await sendButtons(sock, from,
        `📲*Pay Now*\n` +
        `💰${session.order_total?.toLocaleString() || 0}/=\n` +
        `📱${session.ussd_phone}\n` +
        `Press "PAY NOW".`,
        [
            { id: 'paynow', text: '✅PAY NOW' },
            { id: 'change_number', text: '✍️Edit' },
            { id: 'back_provider', text: '⬅️Back' }
        ]
    );
}

async function initiateUssdPayment(sock, from, session) {
    try {
        const result = await api.initiateUssdPayment({
            order_id: session.active_order_id,
            phone: session.ussd_phone,
            amount: session.order_total,
            network: session.ussd_provider
        });
        if (result.success) {
            session.state = 'USSD_PENDING';
            await sendButtons(sock, from,
                '📲 *Request Sent!*\n' +
                'Confirm on your phone.\n\n' +
                `✅ *${T(session, 'bot_confirm_auto')}*`,
                [
                    { id: 'manual_ussd', text: '📟 Manual' },
                    { id: 'home', text: '🏠 Home' }
                ]
            );
            startPaymentPolling(sock, from, session, 'order', session.active_order_id);
        }
    } catch (error) {
        console.error('USSD error:', error);
        await sendButtons(sock, from, '❌USSD Error.', [
            { id: 'paynow', text: '🔁Try Again' },
            { id: 'pay_cash', text: '💵Cash' }
        ]);
    }
}

async function checkPaymentStatus(sock, from, session) {
    try {
        const result = await api.getOrderStatus(session.active_order_id);
        if (result.payment_status === 'paid') {
            await sendText(sock, from, '✅ *Payment Confirmed!* Thank you.');
            await offerPostPaymentTipOrContinue(sock, from, session);
        } else {
            const status = result.status || 'Pending';
            const payStatus = result.payment_status || 'Pending';
            await sendButtons(sock, from,
                `⏳ *Status Update*\n\n` +
                `Order: ${status}\n` +
                `Payment: ${payStatus}\n\n` +
                `Bado tunasubiri malipo...`,
                [
                    { id: 'check_status', text: '🔄 Check Again' },
                    { id: 'home', text: '🏠 Home' }
                ]
            );
        }
    } catch (error) { console.error(error); }
}

async function showManualUssd(sock, from, session) {
    session.state = 'MANUAL_USSD';
    await sendButtons(sock, from,
        '📟*Manual USSD*\n' +
        'Dial *150*00#\n' +
        'Pay amount: ' + session.order_total?.toLocaleString() + '/=\n' +
        'When done, press "I HAVE PAID":',
        [
            { id: 'manual_paid', text: '✅I HAVE PAID' },
            { id: 'home', text: '🏠Home' }
        ]
    );
}

async function showPostPaymentOptions(sock, from, session) {
    session.state = 'HOME';
    await sendButtons(sock, from, 'What would you like to do next?', [
        { id: 'track_order', text: '📍 Track Order' },
        { id: 'rate_service', text: '⭐ Rate Service' },
        { id: 'home', text: '🏠 Home' }
    ]);
}

/**
 * Optional post-payment tip: Waiter / Barista / Kitchen / Split + amounts.
 * Skips when no recipients are available or tip was already offered/done.
 */
async function offerPostPaymentTipOrContinue(sock, from, session) {
    if (session.post_payment_tip_done) {
        await showPostPaymentOptions(sock, from, session);
        return;
    }

    try {
        const preferred = session.waiter_id || session.tip_waiter_id || null;
        const result = await api.getPostPaymentTipOptions(session.restaurant_id, preferred);
        const options = result?.data?.options || {};
        const available = ['waiter', 'barista', 'kitchen', 'split']
            .some((key) => options[key]?.available);

        if (!result?.success || !available) {
            session.post_payment_tip_done = true;
            await showPostPaymentOptions(sock, from, session);
            return;
        }

        session.post_payment_tip_options = result.data;
        await showPostPaymentTipOffer(sock, from, session);
    } catch (e) {
        console.error('Post-payment tip options error:', e);
        await showPostPaymentOptions(sock, from, session);
    }
}

async function showPostPaymentTipOffer(sock, from, session) {
    session.state = 'POST_PAYMENT_TIP';
    const options = session.post_payment_tip_options?.options || {};
    const rows = [];

    if (options.waiter?.available) {
        const name = options.waiter.default?.name;
        rows.push({
            id: 'tip_opt_waiter',
            title: '🙋 Waiter',
            description: name ? `Tip ${name}` : 'Tip your waiter',
        });
    }
    if (options.barista?.available) {
        const name = options.barista.default?.name;
        rows.push({
            id: 'tip_opt_barista',
            title: '☕ Barista',
            description: name ? `Tip ${name}` : 'Tip a barista',
        });
    }
    if (options.kitchen?.available) {
        rows.push({
            id: 'tip_opt_kitchen',
            title: '🍳 Kitchen',
            description: options.kitchen.pool?.name || 'Kitchen tip pool',
        });
    }
    if (options.split?.available) {
        rows.push({
            id: 'tip_opt_split',
            title: '➗ Split',
            description: options.split.description || '50% staff · 50% kitchen',
        });
    }
    rows.push({ id: 'tip_skip', title: 'Skip tip', description: 'Continue without tipping' });

    await sendList(
        sock,
        from,
        '💝 *Optional tip*\nThank you for paying! Who would you like to tip?',
        'Choose recipient',
        [{ title: 'Tip recipient', rows }],
        '💝✨',
    );
}

function clearTipRecipient(session) {
    delete session.tip_waiter_id;
    delete session.tip_waiter_name;
    delete session.tip_pool_id;
    delete session.tip_pool_name;
}

async function handlePostPaymentTipState(sock, from, session, text) {
    const t = String(text || '').trim();
    const options = session.post_payment_tip_options?.options || {};

    if (t === 'tip_skip' || t === 'home' || t === 'skip') {
        session.post_payment_tip_done = true;
        clearTipRecipient(session);
        await showPostPaymentOptions(sock, from, session);
        return;
    }

    if (t === 'tip_opt_waiter') {
        const staff = options.waiter?.staff || [];
        if (staff.length > 1) {
            session.post_payment_tip_staff_role = 'waiter';
            await showPostPaymentTipStaffPick(sock, from, session, staff, 'Waiter');
            return;
        }
        const pick = options.waiter?.default || staff[0];
        if (!pick) {
            await showPostPaymentTipOffer(sock, from, session);
            return;
        }
        clearTipRecipient(session);
        session.tip_waiter_id = pick.id;
        session.tip_waiter_name = pick.name;
        session.quick_payment_desc = `Tip for ${pick.name}`;
        session.is_post_payment_tip = true;
        await showPostPaymentTipAmounts(sock, from, session);
        return;
    }

    if (t === 'tip_opt_barista') {
        const staff = options.barista?.staff || [];
        if (staff.length > 1) {
            session.post_payment_tip_staff_role = 'barista';
            await showPostPaymentTipStaffPick(sock, from, session, staff, 'Barista');
            return;
        }
        const pick = options.barista?.default || staff[0];
        if (!pick) {
            await showPostPaymentTipOffer(sock, from, session);
            return;
        }
        clearTipRecipient(session);
        session.tip_waiter_id = pick.id;
        session.tip_waiter_name = pick.name;
        session.quick_payment_desc = `Tip for barista ${pick.name}`;
        session.is_post_payment_tip = true;
        await showPostPaymentTipAmounts(sock, from, session);
        return;
    }

    if (t === 'tip_opt_kitchen') {
        const pool = options.kitchen?.pool;
        if (!pool) {
            await showPostPaymentTipOffer(sock, from, session);
            return;
        }
        clearTipRecipient(session);
        session.tip_pool_id = pool.id;
        session.tip_pool_name = pool.name || 'Kitchen tip pool';
        session.quick_payment_desc = `Kitchen tip pool: ${session.tip_pool_name}`;
        session.is_post_payment_tip = true;
        await showPostPaymentTipAmounts(sock, from, session);
        return;
    }

    if (t === 'tip_opt_split') {
        const staff = options.split?.staff;
        const pool = options.split?.pool;
        if (!staff || !pool) {
            await showPostPaymentTipOffer(sock, from, session);
            return;
        }
        clearTipRecipient(session);
        session.tip_waiter_id = staff.id;
        session.tip_waiter_name = staff.name;
        session.tip_pool_id = pool.id;
        session.tip_pool_name = pool.name || 'Kitchen tip pool';
        session.quick_payment_desc = `Split tip: ${staff.name} + ${session.tip_pool_name}`;
        session.is_post_payment_tip = true;
        await showPostPaymentTipAmounts(sock, from, session);
        return;
    }

    // Legacy tip_500 / tip_1000 / tip_skip from old TIP screen
    if (t.startsWith('tip_') && !t.startsWith('tip_opt_') && !t.startsWith('tip_amt_') && !t.startsWith('tip_waiter_') && !t.startsWith('tip_pool_') && !t.startsWith('tip_staff_')) {
        await handleTipAmountState(sock, from, session, t);
        return;
    }

    await showPostPaymentTipOffer(sock, from, session);
}

async function showPostPaymentTipStaffPick(sock, from, session, staff, label) {
    session.state = 'POST_PAYMENT_TIP_STAFF';
    const rows = staff.map((s) => ({
        id: `tip_staff_${s.id}|${s.name}`,
        title: `👤 ${s.name}`,
        description: `Tip this ${label.toLowerCase()}`,
    }));
    rows.push({ id: 'tip_skip', title: 'Skip tip' });

    await sendList(
        sock,
        from,
        `💝 *Choose ${label}*`,
        `Select ${label}`,
        [{ title: label, rows }],
        '💝✨',
    );
}

async function handlePostPaymentTipStaffState(sock, from, session, text) {
    const t = String(text || '').trim();
    if (t === 'tip_skip' || t === 'home') {
        session.post_payment_tip_done = true;
        clearTipRecipient(session);
        await showPostPaymentOptions(sock, from, session);
        return;
    }

    if (t.startsWith('tip_staff_')) {
        const parts = t.replace('tip_staff_', '').split('|');
        clearTipRecipient(session);
        session.tip_waiter_id = parts[0];
        session.tip_waiter_name = parts[1] || 'Staff';
        const role = session.post_payment_tip_staff_role === 'barista' ? 'barista ' : '';
        session.quick_payment_desc = `Tip for ${role}${session.tip_waiter_name}`.trim();
        session.is_post_payment_tip = true;
        await showPostPaymentTipAmounts(sock, from, session);
        return;
    }

    await showPostPaymentTipOffer(sock, from, session);
}

async function showPostPaymentTipAmounts(sock, from, session) {
    session.state = 'TIP_AMOUNT';
    const suggestions = session.post_payment_tip_options?.suggestions || {};
    const fallbackAmounts = session.post_payment_tip_options?.amounts || [500, 1000, 2000, 5000];
    const who = session.tip_waiter_name
        || session.tip_pool_name
        || 'team';

    // Base bill amount for percentage suggestions (order total when known).
    const baseAmount = Number(session.order_total) > 0 ? Number(session.order_total) : 0;
    const usePercent = suggestions.mode === 'percent'
        && Array.isArray(suggestions.percentages)
        && suggestions.percentages.length > 0
        && baseAmount > 0;

    const rows = [];
    if (usePercent) {
        for (const pct of suggestions.percentages) {
            const amount = Math.max(1, Math.round((baseAmount * Number(pct)) / 100));
            rows.push({
                id: `tip_amt_${amount}`,
                title: `${pct}% · ${amount.toLocaleString()}/=`,
                description: `Tip ${who}`,
            });
        }
    } else {
        for (const amount of fallbackAmounts) {
            rows.push({
                id: `tip_amt_${amount}`,
                title: `${Number(amount).toLocaleString()}/=`,
                description: `Tip ${who}`,
            });
        }
    }
    rows.push({ id: 'tip_skip', title: 'Skip tip', description: 'Continue without tipping' });

    const hint = usePercent ? '\n_Based on your bill_' : '';

    await sendList(
        sock,
        from,
        `💝 *Tip amount*\nWho: *${who}*${hint}`,
        'Choose amount',
        [{ title: 'Amounts', rows }],
        '💝✨',
    );
}

async function handleTipAmountState(sock, from, session, text) {
    const t = String(text || '').trim();

    if (t === 'tip_skip' || t === 'skip' || t === 'home') {
        session.post_payment_tip_done = true;
        clearTipRecipient(session);
        delete session.is_post_payment_tip;
        await showPostPaymentOptions(sock, from, session);
        return;
    }

    let amount = null;
    if (t.startsWith('tip_amt_')) {
        amount = parseInt(t.replace('tip_amt_', ''), 10);
    } else if (t.startsWith('tip_') && t !== 'tip_skip') {
        amount = parseInt(t.replace('tip_', ''), 10);
    } else {
        amount = parseInt(t.replace(/,/g, ''), 10);
    }

    if (!amount || Number.isNaN(amount) || amount <= 0) {
        await sendText(sock, from, `❌ ${T(session, 'invalid_amount')}`);
        await showPostPaymentTipAmounts(sock, from, session);
        return;
    }

    session.quick_payment_amount = amount;
    session.is_post_payment_tip = true;
    await showQuickPaymentPhone(sock, from, session);
}

async function showTipScreen(sock, from, session) {
    // Kept for compatibility — routes into the post-payment tip offer.
    await offerPostPaymentTipOrContinue(sock, from, session);
}

async function showTrackStatus(sock, from, session) {
    session.state = 'TRACK_STATUS';
    try {
        // Use the new active-order API which is more reliable for table-based tracking
        const result = await api.getActiveOrder(session.restaurant_id, session.table_number);

        if (!result.success || !result.order) {
            await sendText(sock, from, '🧐 No active order found for this table.');
            return await showHomeScreen(sock, from, session);
        }

        const order = result.order;
        session.active_order_id = order.id; // Sync session
        await maybeSendBillImage(sock, from, session, order);

        const statusIcons = {
            'pending': '⏳ Received',
            'received': '⏳ Received',
            'confirmed': '✅ Accepted',
            'accepted': '✅ Accepted',
            'preparing': '👨‍🍳 Preparing',
            'ready': '🍽️ Ready',
            'served': '✅ Served',
            'paid': '✔️ Completed',
            'completed': '✔️ Completed',
            'cancelled': '❌ Cancelled',
        };

        let text = `📍 *Order #${order.id}*\n`;
        text += `Status: ${statusIcons[order.status] || order.status}\n`;
        text += `Payment: ${order.payment_status === 'paid' ? '✅ Paid' : '⏳ Pending'}\n`;
        if (order.waiter_name) {
            text += `🙋 Waiter: ${order.waiter_name}\n`;
        }

        text += `\n🛒 *Items:*\n`;
        order.items.forEach(item => {
            text += `• ${item.name} x${item.quantity}\n`;
        });

        text += `\n💰 *Total: Tsh ${order.total?.toLocaleString()}/=*`;

        const buttons = [
            { id: 'refresh', text: '🔄 Refresh' }
        ];

        if (order.payment_status !== 'paid') {
            buttons.push({ id: 'go_payment', text: '💳 Pay Now' });
        }

        if (order.status === 'served' || order.status === 'ready' || order.payment_status === 'paid') {
            buttons.push({ id: 'rate_service', text: '⭐ Rate Service' });
        }

        buttons.push({ id: 'home', text: '🏠 Home' });

        await sendButtons(sock, from, text, buttons, '📡✨');
    } catch (e) {
        console.error('Track status error:', e);
        await sendText(sock, from, '❌ Error fetching order status.');
    }
}

async function showFeedbackTypeSelection(sock, from, session) {
    session.state = 'FEEDBACK_TYPE';
    await sendButtons(sock, from, T(session, 'feedback_prompt'), [
        { id: 'rate_restaurant', text: T(session, 'feedback_rate_restaurant') },
        { id: 'rate_waiter', text: T(session, 'feedback_rate_waiter_btn') },
        { id: 'home', text: `🏠 ${T(session, 'home')}` },
    ], '⭐✨');
}

async function showWaiterFeedbackList(sock, from, session) {
    session.state = 'FEEDBACK_WAITER_LIST';
    try {
        const result = await api.getWaiters(session.restaurant_id);
        if (result.success && result.data.length > 0) {
            const rows = result.data.map(w => ({
                id: `rate_waiter_${w.id}|${w.name}`,
                title: `🙋 ${w.name}`,
                description: T(session, 'feedback_waiter_tap_rate'),
            }));
            rows.push({ id: 'home', title: `🏠 ${T(session, 'home')}` });

            await sendList(
                sock,
                from,
                T(session, 'feedback_waiter_pick_title'),
                T(session, 'feedback_waiter_pick_section'),
                [{ title: T(session, 'feedback_waiter_pick_section'), rows }],
                '🙋✨',
            );
        } else {
            await sendText(sock, from, T(session, 'waiters_list_empty'));
            await showHomeScreen(sock, from, session);
        }
    } catch (e) {
        console.error('Fetch waiters error:', e);
        await showHomeScreen(sock, from, session);
    }
}

async function showFeedbackA(sock, from, session) {
    session.state = 'FEEDBACK';
    const title = session.feedback_waiter_name
        ? T(session, 'feedback_rating_for').replace('{name}', session.feedback_waiter_name)
        : T(session, 'feedback_rating_generic');
    await sendButtons(sock, from, `${title}\n${T(session, 'feedback_give_stars')}`, [
        { id: 'rate_1', text: '⭐1' },
        { id: 'rate_2', text: '⭐⭐2' },
        { id: 'rate_3', text: '⭐⭐⭐3' },
        { id: 'rate_4', text: '⭐⭐⭐⭐4' },
        { id: 'rate_5', text: '⭐⭐⭐⭐⭐5' }
    ], '⭐✨');
}

async function showCallWaiterOptions(sock, from, session) {
    session.state = 'CALL_WAITER';
    await sendButtons(sock, from, '🙋 *What do you need?*', [
        { id: 'call_only', text: '🙋 Call Waiter' },
        { id: 'request_bill', text: '🧾 Request Bill' },
        { id: 'list_waiters', text: '👥 Waiters List' },
        { id: 'home', text: '🏠 Home' }
    ], '🙋✨');
}

async function showWaitersList(sock, from, session) {
    session.state = 'WAITERS_LIST';
    try {
        const result = await api.getWaiters(session.restaurant_id);
        if (result.success && result.data.length > 0) {
            const rows = result.data.map(w => ({
                id: `call_waiter_${w.id}|${w.name}`,
                title: w.is_online ? `🙋 ${w.name}` : `🙋 ${w.name} ${T(session, 'waiters_offline_badge')}`,
                description: w.is_online ? T(session, 'waiters_tap_to_call') : T(session, 'waiters_not_on_duty')
            }));

            rows.push({ id: 'home', title: '🏠 Home', description: '' });

            await sendList(sock, from,
                `👥 *${T(session, 'waiters_list_title')}*\n\n${T(session, 'waiters_list_subtitle')}`,
                T(session, 'waiters_list_btn'),
                [{ title: T(session, 'waiters_list_title'), rows }],
                '👥✨'
            );
        } else {
            await sendText(sock, from, T(session, 'waiters_list_empty'));
            await showCallWaiterOptions(sock, from, session);
        }
    } catch (e) {
        console.error('Fetch waiters error:', e);
        await showCallWaiterOptions(sock, from, session);
    }
}

async function handleSearchRestaurant(sock, from, session, query) {
    try {
        const result = await api.searchRestaurant(query);
        if (result.success && result.data?.length > 0) {
            const restaurants = result.data.slice(0, 5);
            session.search_results = restaurants;
            session.menu_options = {};

            let text = `━━━━━━━━ 🔍 ━━━━━━━━\n`;
            text += `✅ Found restaurants: ${result.count}\n`;
            text += `👇 Choose by typing number:\n`;

            restaurants.forEach((r, i) => {
                const numEmoji = getNumberEmoji(i + 1);
                text += `${numEmoji} 🏠 ${r.name}\n📍 ${r.location || 'Tanzania'}\n`;
                session.menu_options[(i + 1).toString()] = `pick_rest_${r.id}`;
            });

            text += `0️⃣ 🔄 Search again\n`;
            session.menu_options['0'] = 'search_again';

            text += `━━━━━━━━ ✨ ━━━━━━━━`;
            await sendText(sock, from, text);
            session.state = 'SEARCH_RESTAURANT';
        } else {
            await sendStartWelcome(sock, from, session);
            session.state = 'SEARCH_RESTAURANT';
        }
    } catch (e) {
        if (!session.restaurant_id) {
            await sendStartWelcome(sock, from, session);
            session.state = 'SEARCH_RESTAURANT';
        } else {
            await sendText(sock, from, '❌Error searching.');
        }
    }
}

async function showMenuSelection(sock, from, session) {
    session.state = 'MENU_SELECTION';
    await sendButtons(sock, from, 'Which menu would you like to see?', [
        { id: 'menu_image', text: '🖼️ Menu Image' },
        { id: 'menu_list', text: '📋 List Menu' },
        { id: 'home', text: '🏠 Home' }
    ], '🍽️✨');
}

async function handleMenuSelectionState(sock, from, session, text) {
    if (text === 'menu_image') {
        await showMenuImage(sock, from, session);
    } else if (text === 'menu_list') {
        await showMenuHub(sock, from, session);
    } else if (text === 'home') {
        await showHomeScreen(sock, from, session);
    } else {
        await showMenuSelection(sock, from, session);
    }
}

async function showMenuImage(sock, from, session) {
    session.state = 'MENU_IMAGE_ORDER';

    const customerPhone = from.split('@')[0];
    const result = await api.getMenuPdf(session.restaurant_id, {
        wa_id: customerPhone,
        customer_phone: customerPhone,
        table_id: session.table_id,
        table_number: session.table_number,
    });
    const pdfUrl = result.success ? result.data?.menu_pdf_url : null;
    const fileName = result.data?.filename || 'menu.pdf';

    if (pdfUrl) {
        const cmdZero = T(session, 'menu_cmd_zero');
        const cmdOrder = T(session, 'menu_cmd_order');
        const caption = `👆 ${T(session, 'here_is_menu')}\n\n*${T(session, 'menu_commands')}*\n• ${cmdZero}\n• ${cmdOrder}`;
        try {
            await sock.sendMessage(from, {
                document: { url: pdfUrl, fileName },
                mimetype: 'application/pdf',
                caption,
            });
        } catch (e) {
            await sendText(sock, from, caption);
        }
    } else {
        await sendText(sock, from, `❌ ${T(session, 'menu_not_available')}`);
        session.state = 'HOME';
        await showHomeScreen(sock, from, session);
    }
}

async function handleMenuImageOrderState(sock, from, session, text) {
    // 0 or home = back to main menu (0 is also handled globally)
    if (text === 'home' || text === '0') {
        await showHomeScreen(sock, from, session);
        return;
    }

    // If table not set (e.g. came via waiter QR), ask which table before submitting order
    if (!session.table_number && !session.table_id) {
        session.pending_order_text = text;
        session.pending_table_for = 'text_order';
        await showOrderTableSelect(sock, from, session);
        return;
    }

    await sendText(sock, from, `🔄 ${T(session, 'processing_order')}`);

    try {
        const result = await api.createOrderText({
            restaurant_id: session.restaurant_id,
            table_id: session.table_id,
            table_number: session.table_number,
            waiter_id: session.waiter_id,
            customer_name: session.customer_name,
            customer_phone: from.split('@')[0],
            whatsapp_jid: from,
            order_text: text
        });

        if (result.success) {
            if (result.order) {
                session.active_order_id = result.order.id;
                session.order_total = result.order.total;
                session.cart = []; // Clear cart if any

                let msg = `✅ *${T(session, 'order_received')}*\n`;
                msg += `🧾 ${T(session, 'order_id')}${result.order.id}\n`;
                msg += `🛒 *${T(session, 'items_found')}*\n`;

                if (result.order.items && result.order.items.length > 0) {
                    result.order.items.forEach(item => {
                        msg += `• ${item.name} x${item.quantity} = ${item.total?.toLocaleString()}/=\n`;
                    });
                }

                msg += `\n💰 *${T(session, 'total')} ${result.order.total?.toLocaleString()}/=*`;
                msg += `\n\n${T(session, 'waiter_confirm')}`;

                await sendButtons(sock, from, msg, [
                    { id: 'go_payment', text: `💳 ${T(session, 'pay_now')}` },
                    { id: 'track_order', text: `📍 ${T(session, 'track_status')}` },
                    { id: 'home', text: `🏠 ${T(session, 'home')}` }
                ], '🧾✨');
            } else {
                // Handle success but no order object (e.g. just a message)
                await sendText(sock, from, result.message || '✅ Order received! Waiter is coming.');
                await showHomeScreen(sock, from, session);
            }

            session.state = 'HOME';
        } else {
            await sendText(sock, from, `❌ ${result.message || T(session, 'error_order')}\n\n${T(session, 'try_clear')}`);
            await sendButtons(sock, from, T(session, 'choose'), [
                { id: 'home', text: `🏠 ${T(session, 'home_btn')}` }
            ]);
        }
    } catch (e) {
        console.error('Text order error:', e);
        await sendText(sock, from, '❌ Technical error. Please try again or use List Menu.');
    }
}

async function showLiveBillOptions(sock, from, session) {
    // Clear tip info when paying bill
    delete session.tip_waiter_id;
    delete session.tip_waiter_name;
    delete session.tip_pool_id;
    delete session.tip_pool_name;
    delete session.is_post_payment_tip;
    delete session.post_payment_tip_done;
    session.quick_payment_desc = 'Bill Payment';

    // If no table number, we can't fetch an active order, so go straight to quick payment
    if (!session.table_number) {
        await showQuickPaymentAmount(sock, from, session);
        return;
    }

    try {
        const activeOrder = await api.getActiveOrder(session.restaurant_id, session.table_number);
        if (activeOrder.success && activeOrder.order && activeOrder.order.payment_status !== 'paid') {
            session.active_order_id = activeOrder.order.id;
            session.order_total = activeOrder.order.total;
            await showPaymentSummary(sock, from, session);
        } else {
            await showQuickPaymentAmount(sock, from, session);
        }
    } catch (e) {
        await showQuickPaymentAmount(sock, from, session);
    }
}



async function showQuickPaymentPhone(sock, from, session) {
    session.state = 'QUICK_PAYMENT_PHONE';
    const msg = session.tip_waiter_id
        ? `📱 ${T(session, 'enter_phone_tip')}`
        : session.quick_payment_desc === 'Bill Payment'
            ? `📱 ${T(session, 'enter_phone_billed')}`
            : `📱 ${T(session, 'enter_phone_pay')}`;
    await sendText(sock, from, msg);
}

async function handleQuickPaymentPhoneState(sock, from, session, text) {
    if (/^(0\d{9}|255\d{9})$/.test(text)) {
        session.ussd_phone = text.startsWith('255') ? '0' + text.slice(3) : text;
        await initiateQuickPayment(sock, from, session);
    } else {
        await sendText(sock, from, `❌ ${T(session, 'invalid_number')}`);
    }
}

async function showQuickPaymentAmount(sock, from, session) {
    session.state = 'QUICK_PAYMENT_AMOUNT';
    const msg = session.tip_waiter_id && session.tip_waiter_name
        ? `💰 ${T(session, 'tip_amount')} ${session.tip_waiter_name.toUpperCase()} (Tsh):`
        : session.tip_pool_id
            ? `💰 Tip amount for kitchen pool (Tsh):`
            : `💰 ${T(session, 'enter_amount')}`;
    await sendText(sock, from, msg);
}

async function handleQuickPaymentAmountState(sock, from, session, text) {
    const amount = parseInt(text.replace(/,/g, ''));
    if (!isNaN(amount) && amount > 0) {
        session.quick_payment_amount = amount;
        await showQuickPaymentPhone(sock, from, session);
    } else {
        await sendText(sock, from, `❌ ${T(session, 'invalid_amount')}`);
    }
}

async function initiateQuickPayment(sock, from, session) {
    await sendText(sock, from, `🔄 ${T(session, 'sending_request')}`);
    try {
        const payload = {
            restaurant_id: session.restaurant_id,
            phone_number: session.ussd_phone,
            amount: session.quick_payment_amount,
            description: session.quick_payment_desc || 'Bill Payment',
            network: detectNetwork(session.ussd_phone)
        };
        if (session.tip_waiter_id) payload.waiter_id = session.tip_waiter_id;
        if (session.tip_pool_id) payload.tip_pool_id = session.tip_pool_id;
        const result = await api.initiateQuickPayment(payload);

        if (result.success) {
            session.quick_payment_id = result.payment_id;
            session.state = 'QUICK_PAYMENT_PENDING';
            await sendButtons(sock, from,
                `✅ ${T(session, 'request_sent')} ${session.ussd_phone}!\n\n` +
                `Amount: ${session.quick_payment_amount}/=\n\n` +
                `${T(session, 'confirm_on_phone')}\n` +
                `✅ *${T(session, 'bot_confirm_auto')}*`,
                [
                    { id: 'home', text: `🏠 ${T(session, 'home')}` }
                ],
                '💳✨'
            );
            startPaymentPolling(sock, from, session, 'quick', result.payment_id);
        } else {
            await sendText(sock, from, '❌ Oops! There is a technical issue. Please try again later.');
            await showHomeScreen(sock, from, session);
        }
    } catch (e) {
        console.error('Quick Payment Error:', e);
        await sendText(sock, from, '❌ Oops! There is a technical issue. Please try again later.');
        await showHomeScreen(sock, from, session);
    }
}

async function handleQuickPaymentPendingState(sock, from, session, text) {
    if (text === 'check_status') {
        const result = await api.checkQuickPaymentStatus(session.quick_payment_id);
        if (result.success && result.status === 'paid') {
            await sendText(sock, from, '✅ Malipo yamethibitishwa! Asante.');
            await afterQuickPaymentConfirmed(sock, from, session);
        } else {
            await sendText(sock, from, `⏳ Status: ${result.status || 'Pending'}. Bado tunasubiri...`);
            await sendButtons(sock, from, 'Chagua:', [
                { id: 'check_status', text: '🔄 Check Tena' },
                { id: 'home', text: '🏠 Home' }
            ]);
        }
    } else if (text === 'home') {
        await showHomeScreen(sock, from, session);
    }
}

async function afterQuickPaymentConfirmed(sock, from, session) {
    const wasTip = !!(session.tip_waiter_id || session.tip_pool_id);

    if (wasTip) {
        const tipThanks = session.tip_waiter_name || session.tip_pool_name
            ? `💝 Asante kwa tip! (${session.tip_waiter_name || session.tip_pool_name})`
            : '💝 Asante kwa tip!';
        await sendText(sock, from, tipThanks);

        if (session.is_post_payment_tip) {
            session.post_payment_tip_done = true;
            delete session.is_post_payment_tip;
            clearTipRecipient(session);
            await showPostPaymentOptions(sock, from, session);
            return;
        }

        clearTipRecipient(session);
        await showHomeScreen(sock, from, session);
        return;
    }

    await offerPostPaymentTipOrContinue(sock, from, session);
}

async function showWaiterTipList(sock, from, session) {
    session.state = 'SELECT_WAITER_TIP';
    try {
        const [result, pools] = await Promise.all([
            api.getWaiters(session.restaurant_id, { tippableOnly: true }),
            api.getTipPools(session.restaurant_id).catch(() => ({ success: false, data: [] })),
        ]);

        const rows = [];
        if (pools?.success && Array.isArray(pools.data)) {
            for (const pool of pools.data) {
                rows.push({
                    id: `tip_pool_${pool.id}|${pool.name}`,
                    title: `🍳 ${pool.name}`,
                    description: `Shared tip · ${pool.member_count || 0} kitchen staff`,
                });
            }
        }

        if (result.success && result.data.length > 0) {
            for (const w of result.data) {
                rows.push({
                    id: `tip_waiter_${w.id}|${w.name}`,
                    title: `👤 ${w.name}`,
                    description: T(session, 'tip_waiter_tap_tip'),
                });
            }
        }

        if (rows.length > 0) {
            rows.push({ id: 'home', title: `🏠 ${T(session, 'home')}` });
            await sendList(
                sock,
                from,
                T(session, 'tip_waiter_pick_title'),
                T(session, 'tip_waiter_pick_section'),
                [{ title: T(session, 'tip_waiter_pick_section'), rows }],
                '💝✨',
            );
        } else {
            await sendText(sock, from, '💝 Digital tipping is not enabled for any staff or kitchen pool right now.');
            await showHomeScreen(sock, from, session);
        }
    } catch (e) {
        console.error('Fetch waiters error:', e);
        await showHomeScreen(sock, from, session);
    }
}

async function handleSelectWaiterTipState(sock, from, session, text) {
    if (text.startsWith('tip_pool_')) {
        const parts = text.replace('tip_pool_', '').split('|');
        session.tip_pool_id = parts[0];
        session.tip_pool_name = parts[1] || 'Kitchen tip pool';
        delete session.tip_waiter_id;
        delete session.tip_waiter_name;
        session.quick_payment_desc = `Kitchen tip pool: ${session.tip_pool_name}`;
        await showQuickPaymentAmount(sock, from, session);
    } else if (text.startsWith('tip_waiter_')) {
        const parts = text.replace('tip_waiter_', '').split('|');
        session.tip_waiter_id = parts[0];
        session.tip_waiter_name = parts[1];
        delete session.tip_pool_id;
        delete session.tip_pool_name;
        session.quick_payment_desc = `Tip for ${session.tip_waiter_name}`;
        await showQuickPaymentAmount(sock, from, session);
    } else if (text === 'home') {
        await showHomeScreen(sock, from, session);
    }
}



// ═══════════════════════════════════════════════════════════════
// MESSAGE SENDERS
// ═══════════════════════════════════════════════════════════════

async function sendText(sock, from, text) {
    await sock.sendMessage(from, { text });
}

async function sendStartWelcome(sock, from, session) {
    let branding = null;

    try {
        branding = await api.getBranding();
    } catch (error) {
        console.error('Welcome branding fetch failed:', error.message);
    }

    const payload = branding?.data || {};
    const brandName = String(payload.title || 'TipTap').trim();
    const titleLine = /welcome/i.test(brandName)
        ? brandName
        : `${T(session, 'start_welcome_title')} ${brandName}!`;
    const body = payload.body || T(session, 'start_welcome');
    const footer = T(session, 'tap_powered_by');
    const caption = `*${titleLine}*\n\n${body}\n\n_${footer}_`;
    const imageUrl = payload.image_url;

    if (imageUrl) {
        try {
            await sock.sendMessage(from, {
                image: { url: imageUrl },
                caption,
            });
            return;
        } catch (error) {
            console.error('Welcome image send failed, using text fallback:', error.message);
        }
    }

    await sendText(sock, from, buildStartWelcome(T, session));
}

function rememberMenuOptions(session, entries) {
    session.menu_options = session.menu_options || {};

    entries.forEach((entry, index) => {
        const key = (index + 1).toString();
        session.menu_options[key] = entry.id;
        session.menu_options[entry.id] = entry.id;
        session.menu_options[String(entry.id).toLowerCase()] = entry.id;
    });
}

function buildTextMenuFallback(text, entries, headerLabel = '✨') {
    let menuText = `━━━━━━━━ ${headerLabel} ━━━━━━━━\n${text}\n\n`;

    entries.forEach((entry, index) => {
        const numEmoji = getNumberEmoji(index + 1);
        menuText += `${numEmoji}${entry.label}\n`;
    });

    menuText += '━━━━━━━━━━━━━━━━\n✅ Reply with the number to choose';

    return menuText;
}

async function sendButtons(sock, from, text, buttons, headerEmoji = '✨', footerText = null) {
    const session = sessions[from];
    rememberMenuOptions(session, buttons.map((button) => ({ id: button.id })));

    try {
        if (whatsapp.USE_INTERACTIVE !== false) {
            if (buttons.length <= 3) {
                await sock.sendMessage(from, {
                    interactive: {
                        type: 'button',
                        header: headerEmoji,
                        body: text,
                        footer: footerText || 'Tap a button below',
                        buttons,
                    },
                });
                return;
            }

            await sock.sendMessage(from, {
                interactive: {
                    type: 'list',
                    header: headerEmoji,
                    body: text,
                    footer: footerText || 'Tap the menu button below',
                    buttonText: 'Choose',
                    sections: [{ title: 'Options', rows: buttons.map((button) => ({
                        id: button.id,
                        title: button.text,
                        description: button.description || '',
                    })) }],
                },
            });
            return;
        }
    } catch (error) {
        console.warn('Interactive buttons failed, falling back to text menu:', error.message);
    }

    await sock.sendMessage(from, {
        text: buildTextMenuFallback(text, buttons.map((button) => ({ id: button.id, label: button.text })), headerEmoji),
    });
}

async function sendList(sock, from, text, buttonText, sections, headerEmoji = '✨', footerText = null) {
    const session = sessions[from];
    const entries = [];

    sections.forEach((section) => {
        section.rows.forEach((row) => {
            entries.push({ id: row.id, label: row.title, description: row.description });
        });
    });

    rememberMenuOptions(session, entries);

    try {
        if (whatsapp.USE_INTERACTIVE !== false) {
            await sock.sendMessage(from, {
                interactive: {
                    type: 'list',
                    header: headerEmoji,
                    body: text,
                    footer: footerText || 'Tap the menu button below',
                    buttonText,
                    sections,
                },
            });
            return;
        }
    } catch (error) {
        console.warn('Interactive list failed, falling back to text menu:', error.message);
    }

    let menuText = `━━━━━━━━ ${headerEmoji} ━━━━━━━━\n${text}\n`;
    entries.forEach((entry, index) => {
        menuText += `${getNumberEmoji(index + 1)}${entry.label}\n`;
    });
    menuText += '━━━━━━━━━━━━━━━━\n✅ Reply with the number to choose';

    await sock.sendMessage(from, { text: menuText });
}

async function sendImageWithButtons(sock, from, imageUrl, caption, buttons, headerEmoji = '✨') {
    try {
        await sock.sendMessage(from, { image: { url: imageUrl }, caption: caption });
    } catch (e) {
        await sendText(sock, from, caption);
    }
    await sendButtons(sock, from, 'Choose:', buttons, headerEmoji);
}

function getNumberEmoji(num) {
    const emojis = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    return emojis[num] || `*${num}.*`;
}

function detectNetwork(phone) {
    if (phone.startsWith('255')) phone = '0' + phone.slice(3);
    const prefix = phone.substring(0, 3);
    if (['074', '075', '076'].includes(prefix)) return 'vodacom';
    if (['065', '067', '071', '077'].includes(prefix)) return 'tigo';
    if (['068', '069', '078', '079'].includes(prefix)) return 'airtel';
    if (['062'].includes(prefix)) return 'halotel';
    return 'vodacom';
}

async function startPaymentPolling(sock, from, session, type, id) {
    let attempts = 0;
    const maxAttempts = 30; // 5 minutes (10s * 30)

    const interval = setInterval(async () => {
        attempts++;
        if (attempts > maxAttempts) {
            clearInterval(interval);
            return;
        }

        try {
            let result;
            if (type === 'order') {
                result = await api.getOrderStatus(id);
                await maybeSendBillImage(sock, from, session, {
                    id,
                    bill_image_url: result.bill_image_url,
                    is_bill_ready: result.is_bill_ready
                });
                if (result.payment_status === 'paid') {
                    await sendText(sock, from, '✅ *Payment Confirmed!* Thank you for your payment.');
                    await offerPostPaymentTipOrContinue(sock, from, session);
                    clearInterval(interval);
                }
            } else {
                result = await api.checkQuickPaymentStatus(id);
                if (result.success && result.status === 'paid') {
                    await sendText(sock, from, '✅ *Payment Confirmed!* Thank you for your payment.');
                    await afterQuickPaymentConfirmed(sock, from, session);
                    clearInterval(interval);
                }
            }
        } catch (e) {
            console.error('Polling error:', e);
        }
    }, 10000); // Check every 10 seconds
}

async function maybeSendBillImage(sock, from, session, order) {
    if (!order || !order.is_bill_ready || !order.bill_image_url) {
        return;
    }

    const orderId = String(order.id || '');
    if (session.bill_image_sent_for_order && session.bill_image_sent_for_order === orderId) {
        return;
    }

    try {
        await sock.sendMessage(from, {
            image: { url: order.bill_image_url },
            caption: '🧾 *Your bill is ready.*\nPlease review and proceed to payment.'
        });
        session.bill_image_sent_for_order = orderId;
    } catch (error) {
        console.error('Failed to send bill image:', error);
    }
}

module.exports = { handleMessage, extractMessageText };
