/**
 * Inbound webhook from Meta Cloud API.
 *
 *   GET  /webhook   — verification handshake
 *   POST /webhook   — message callbacks
 *   POST /inbound   — Laravel forward (signature verified upstream)
 */

const crypto = require('crypto');
const { handleMessage } = require('./handler');

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const APP_SECRET = process.env.WHATSAPP_APP_SECRET;
const NOTIFY_SECRET = process.env.NOTIFY_SECRET;

function verifySignature(req) {
    if (!APP_SECRET) {
        return true;
    }

    const header = req.header('X-Hub-Signature-256') || '';
    if (!header.startsWith('sha256=')) return false;

    const raw = req.rawBody || JSON.stringify(req.body || {});
    const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');

    try {
        return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
    } catch (_) {
        return false;
    }
}

async function handleEvent(payload) {
    const entries = Array.isArray(payload?.entry) ? payload.entry : [];

    for (const entry of entries) {
        const changes = Array.isArray(entry?.changes) ? entry.changes : [];

        for (const change of changes) {
            const value = change?.value || {};
            const messages = Array.isArray(value.messages) ? value.messages : [];
            const contacts = Array.isArray(value.contacts) ? value.contacts : [];

            for (const message of messages) {
                const contact = contacts.find((c) => c?.wa_id === message?.from) || null;

                try {
                    await handleMessage(message, contact);
                } catch (error) {
                    console.error('handleMessage failed:', error.response?.data || error.message);
                }
            }

            const statuses = Array.isArray(value.statuses) ? value.statuses : [];
            for (const status of statuses) {
                const state = status?.status;
                const recipient = status?.recipient_id;
                const messageId = status?.id;
                const errors = status?.errors;

                if (state === 'failed') {
                    console.error('❌ WhatsApp delivery failed:', {
                        recipient,
                        messageId,
                        errors,
                        details: errors?.[0]?.error_data?.details ?? null,
                    });
                } else if (state === 'delivered' || state === 'read') {
                    console.log(`✅ WhatsApp ${state}: ${recipient} (${messageId || 'no id'})`);
                }
            }
        }
    }
}

function registerWebhookRoutes(app) {
    app.get('/webhook', (req, res) => {
        const mode = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];

        if (mode === 'subscribe' && VERIFY_TOKEN && token === VERIFY_TOKEN) {
            console.log('✅ Webhook verified by Meta.');
            return res.status(200).send(challenge);
        }

        console.warn('❌ Webhook verification failed.', { mode, tokenMatch: token === VERIFY_TOKEN });
        return res.sendStatus(403);
    });

    app.post('/webhook', async (req, res) => {
        if (!verifySignature(req)) {
            console.warn('❌ Invalid X-Hub-Signature-256.');
            return res.status(401).json({ ok: false, error: 'invalid_signature' });
        }

        res.status(200).json({ ok: true });
        await handleEvent(req.body || {});
    });

    app.post('/inbound', async (req, res) => {
        const provided = req.header('X-Bot-Secret');
        if (!NOTIFY_SECRET || provided !== NOTIFY_SECRET) {
            return res.status(401).json({ ok: false, error: 'unauthorized' });
        }

        res.status(200).json({ ok: true });
        await handleEvent(req.body || {});
    });
}

module.exports = { registerWebhookRoutes, handleEvent };
