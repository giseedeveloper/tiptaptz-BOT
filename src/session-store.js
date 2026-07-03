/**
 * Persistent session storage backed by Laravel's `/api/bot/session` endpoint.
 *
 * Hydrates from MySQL at the start of each message and write-through on save.
 * Idle sessions (no chat for BOT_SESSION_IDLE_HOURS on Laravel) are cleared by
 * the API and flagged so the bot can notify the customer.
 */

const axios = require('axios');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const cache = new Map();

const api = axios.create({
    baseURL: process.env.API_BASE_URL,
    headers: {
        Authorization: `Bearer ${process.env.BOT_TOKEN}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
    },
    timeout: 10000,
});

function defaultSession() {
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
        feedback_waiter_id: null,
        feedback_waiter_name: null,
        bill_image_sent_for_order: null,
        pending_order_lines: null,
    };
}

/**
 * Load session for a WhatsApp id. Always hits the API so idle expiry is accurate.
 */
async function load(waId) {
    try {
        const { data } = await api.get('/session', { params: { wa_id: waId } });

        if (data?.expired) {
            cache.delete(waId);

            return {
                ...defaultSession(),
                lang: data.lang || 'en',
                _justExpired: true,
                _expiredRestaurantName: data.expired_restaurant_name || null,
            };
        }

        const remote = data?.data || {};
        const session = {
            ...defaultSession(),
            ...(remote.data || {}),
            state: remote.state || 'START',
            lang: remote.lang || 'en',
            _lastMessageAt: remote.last_message_at || null,
        };
        cache.set(waId, session);

        return session;
    } catch (error) {
        console.error('Session load failed, using cache or fresh defaults:', error.response?.data || error.message);

        if (cache.has(waId)) {
            return cache.get(waId);
        }

        const session = defaultSession();
        cache.set(waId, session);

        return session;
    }
}

async function save(waId, session) {
    if (!session || session._justExpired) {
        return;
    }

    cache.set(waId, session);

    const { state, lang, _lastMessageAt, _justExpired, _expiredRestaurantName, ...rest } = session;

    try {
        await api.put('/session', {
            wa_id: waId,
            state: state || 'START',
            lang: lang || 'en',
            data: rest,
        });
        session._lastMessageAt = new Date().toISOString();
    } catch (error) {
        console.error('Session save failed:', error.response?.data || error.message);
    }
}

async function clear(waId) {
    cache.delete(waId);

    try {
        await api.delete('/session', { params: { wa_id: waId } });
    } catch (error) {
        console.error('Session clear failed:', error.response?.data || error.message);
    }
}

module.exports = { load, save, clear, defaultSession };
