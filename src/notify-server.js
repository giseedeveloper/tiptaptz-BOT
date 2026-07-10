/**
 * Bill-image notify endpoint — Laravel → POST /notify → Meta Cloud API.
 */

const whatsapp = require('./whatsapp');

const sentBillImageOrders = new Set();

function registerNotifyRoutes(app) {
    const secret = process.env.NOTIFY_SECRET;

    if (!secret) {
        console.warn('⚠️  NOTIFY_SECRET is not set; /notify will refuse every request.');
    }

    app.post('/notify', async (req, res) => {
        const provided = req.header('X-Bot-Secret');
        if (!secret || provided !== secret) {
            return res.status(401).json({ ok: false, error: 'unauthorized' });
        }

        const {
            event,
            jid,
            order_id: orderId,
            bill_image_url: billImageUrl,
            caption,
            force,
        } = req.body || {};

        if (event !== 'bill_image') {
            return res.status(400).json({ ok: false, error: 'unsupported_event' });
        }

        if (!jid || !orderId || !billImageUrl) {
            return res.status(422).json({ ok: false, error: 'missing_fields' });
        }

        const recipient = whatsapp.digitsOnly(jid);
        const dedupeKey = `bill:${orderId}`;
        const shouldForce = force === true || force === 'true' || force === 1 || force === '1';

        if (!shouldForce && sentBillImageOrders.has(dedupeKey)) {
            return res.json({ ok: true, deduped: true, recipient });
        }

        try {
            const graphResult = await whatsapp.sendImage(
                recipient,
                billImageUrl,
                caption || '🧾 Your bill is ready.',
            );

            sentBillImageOrders.add(dedupeKey);
            const messageId = graphResult?.messages?.[0]?.id ?? null;
            console.log(`📤 Pushed bill image to ${recipient} for order #${orderId}${messageId ? ` (msg ${messageId})` : ''}`);
            return res.json({ ok: true, recipient, message_id: messageId });
        } catch (error) {
            const raw = String(error?.response?.data?.error?.message || error?.message || 'unknown');
            console.error('Notify endpoint failed to send bill image:', raw);
            return res.status(502).json({
                ok: false,
                error: 'send_failed',
                detail: raw.replace(/\s+/g, ' ').trim().slice(0, 220),
            });
        }
    });
}

module.exports = { registerNotifyRoutes };
