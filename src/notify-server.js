/**
 * Internal HTTP endpoint that receives push notifications from the
 * Laravel backend (e.g. when an order reaches the "served" stage)
 * so the bot can deliver an image/message to the customer's WhatsApp
 * without relying on in-memory polling.
 *
 * Routes:
 * - GET /health — public (no `X-Bot-Secret`); for Nginx / load balancers / probes.
 * - POST /notify — requires `X-Bot-Secret` matching `NOTIFY_SECRET`; body JSON.
 *
 * Responses from this app are JSON (401, 400, 422, 502, 503, etc.). If you see
 * HTML such as "Cannot POST /notify" with HTTP 404, that is Express’s default
 * page: another process or an old image is bound to the port — not this server.
 * On the VPS: check `docker compose logs bot` for "Notify server listening",
 * `ss -tlnp` for port conflicts. If PM2 `whatsapp-service` (or similar) uses host :3001,
 * publish TipTap notify as host :3002→container NOTIFY_PORT in docker-compose.yml and point
 * Nginx at 127.0.0.1:3002 — do not kill other bots. Then `git pull` (or sync) and
 * `docker compose build --no-cache bot && docker compose up -d bot`.
 */

const express = require('express');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const sentBillImageOrders = new Set();

function startNotifyServer(getSock) {
    const port = parseInt(process.env.NOTIFY_PORT, 10) || 3001;
    /** Bind address: 127.0.0.1 = only same machine (default). Use 0.0.0.0 in Docker when Laravel calls from another host/IP. */
    const bind = process.env.NOTIFY_BIND || '127.0.0.1';
    const secret = process.env.NOTIFY_SECRET;

    if (!secret) {
        console.warn('⚠️  NOTIFY_SECRET is not set; refusing to start notify endpoint.');
        return;
    }

    const app = express();
    app.use(express.json({ limit: '256kb' }));

    // Public: load balancers / Nginx health checks (no secret).
    app.get('/health', (_req, res) => {
        res.json({ ok: true, ready: Boolean(getSock()) });
    });

    app.use((req, res, next) => {
        const provided = req.header('X-Bot-Secret');
        if (!provided || provided !== secret) {
            return res.status(401).json({ ok: false, error: 'unauthorized' });
        }
        next();
    });

    app.post('/notify', async (req, res) => {
        const sock = getSock();
        if (!sock) {
            return res.status(503).json({ ok: false, error: 'whatsapp_not_connected' });
        }

        const { event, jid, order_id: orderId, bill_image_url: billImageUrl, caption } = req.body || {};

        if (event !== 'bill_image') {
            return res.status(400).json({ ok: false, error: 'unsupported_event' });
        }

        if (!jid || !orderId || !billImageUrl) {
            return res.status(422).json({ ok: false, error: 'missing_fields' });
        }

        const dedupeKey = `bill:${orderId}`;
        if (sentBillImageOrders.has(dedupeKey)) {
            return res.json({ ok: true, deduped: true });
        }

        try {
            await sock.sendMessage(jid, {
                image: { url: billImageUrl },
                caption: caption || '🧾 Your bill is ready.'
            });

            sentBillImageOrders.add(dedupeKey);
            console.log(`📤 Pushed bill image to ${jid} for order #${orderId}`);

            return res.json({ ok: true });
        } catch (error) {
            const raw = String(error?.message || error || 'unknown');
            console.error('Notify endpoint failed to send bill image:', raw);
            const detail = raw.replace(/\s+/g, ' ').trim().slice(0, 220);
            return res.status(502).json({
                ok: false,
                error: 'send_failed',
                detail,
                hint: 'Often: invalid jid for this chat (use the same @lid / @s.whatsapp.net the customer uses), or the bill_image_url cannot be fetched by this server (SSL/firewall/403).'
            });
        }
    });

    app.listen(port, bind, () => {
        console.log(`🛎️  Notify server listening on http://${bind}:${port}`);
    });
}

module.exports = { startNotifyServer };
