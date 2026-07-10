/**
 * WhatsApp Cloud API (Meta) client.
 *
 * Outbound helpers for text, images, and native interactive UI (buttons + lists).
 */

const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v20.0';
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const USE_INTERACTIVE = process.env.USE_INTERACTIVE_MENU !== 'false';

if (!PHONE_ID || !ACCESS_TOKEN) {
    console.warn('⚠️  WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN are not set. Outbound messages will fail.');
}

const graph = axios.create({
    baseURL: `https://graph.facebook.com/${GRAPH_VERSION}`,
    headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
    },
    timeout: 30000,
});

graph.interceptors.response.use(
    (response) => response,
    (error) => {
        const body = error.response?.data;
        console.error('Graph API error:', body || error.message);
        throw error;
    },
);

function digitsOnly(value) {
    return String(value || '').replace(/\D/g, '');
}

function truncateText(value, max) {
    const cleaned = String(value || '').replace(/\s+/g, ' ').trim();
    if (cleaned.length <= max) {
        return cleaned;
    }

    return `${cleaned.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** List/button body — keep intentional line breaks (truncateText flattens \\n). */
function truncateBodyText(value, max) {
    const cleaned = String(value || '')
        .replace(/[^\S\n]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    if (cleaned.length <= max) {
        return cleaned;
    }

    return `${cleaned.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function normalizeSections(sections) {
    const normalized = [];
    let totalRows = 0;

    for (const section of sections || []) {
        const rows = [];

        for (const row of section.rows || []) {
            rows.push({
                id: String(row.id).slice(0, 200),
                title: truncateText(row.title, 24),
                ...(row.description ? { description: truncateText(row.description, 72) } : {}),
            });
            totalRows++;

            if (totalRows >= 10) {
                break;
            }
        }

        if (rows.length > 0) {
            const title = section.title != null && String(section.title).length > 0
                ? truncateText(section.title, 24)
                : 'Options';
            normalized.push({ title, rows });
        }

        if (totalRows >= 10) {
            break;
        }
    }

    return normalized.length > 0 ? normalized : [{ title: 'Options', rows: [] }];
}

async function sendRaw(payload) {
    const { data } = await graph.post(`/${PHONE_ID}/messages`, payload);
    return data;
}

async function sendText(to, body) {
    if (!body) {
        return null;
    }

    return sendRaw({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: digitsOnly(to),
        type: 'text',
        text: { body, preview_url: false },
    });
}

async function downloadMediaFromUrl(link) {
    const response = await axios.get(link, {
        responseType: 'arraybuffer',
        timeout: 45000,
        maxContentLength: 5 * 1024 * 1024,
        maxRedirects: 5,
        headers: {
            Accept: 'image/jpeg,image/png,*/*',
            'User-Agent': 'TipTapWhatsAppBot/2.0',
        },
        validateStatus: (status) => status >= 200 && status < 300,
    });

    const contentType = String(response.headers['content-type'] || 'image/jpeg').split(';')[0].trim().toLowerCase();
    const mimeType = contentType === 'image/png' ? 'image/png' : 'image/jpeg';

    return {
        buffer: Buffer.from(response.data),
        mimeType,
    };
}

async function uploadWhatsAppMedia(buffer, mimeType, filename = null) {
    const isPdf = mimeType === 'application/pdf';
    const defaultName = isPdf ? 'menu.pdf' : (mimeType === 'image/png' ? 'bill.png' : 'bill.jpg');
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeType);
    form.append('file', buffer, {
        filename: filename || defaultName,
        contentType: mimeType,
    });

    const { data } = await axios.post(
        `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_ID}/media`,
        form,
        {
            headers: {
                Authorization: `Bearer ${ACCESS_TOKEN}`,
                ...form.getHeaders(),
            },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 60000,
        },
    );

    if (!data?.id) {
        throw new Error('Media upload did not return an id');
    }

    return data.id;
}

async function sendImage(to, link, caption) {
    const { buffer, mimeType } = await downloadMediaFromUrl(link);
    const mediaId = await uploadWhatsAppMedia(buffer, mimeType);

    return sendRaw({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: digitsOnly(to),
        type: 'image',
        image: {
            id: mediaId,
            ...(caption ? { caption } : {}),
        },
    });
}

async function downloadDocumentFromUrl(link) {
    const response = await axios.get(link, {
        responseType: 'arraybuffer',
        timeout: 90000,
        maxContentLength: 16 * 1024 * 1024,
        maxRedirects: 5,
        headers: {
            Accept: 'application/pdf,*/*',
            'User-Agent': 'TipTapWhatsAppBot/2.0',
        },
        validateStatus: (status) => status >= 200 && status < 300,
    });

    return {
        buffer: Buffer.from(response.data),
        mimeType: 'application/pdf',
    };
}

async function sendDocument(to, link, fileName, caption) {
    const { buffer, mimeType } = await downloadDocumentFromUrl(link);
    const safeName = String(fileName || 'menu.pdf').replace(/[^\w.\-]+/g, '_');
    const mediaId = await uploadWhatsAppMedia(buffer, mimeType, safeName);

    return sendRaw({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: digitsOnly(to),
        type: 'document',
        document: {
            id: mediaId,
            filename: safeName,
            ...(caption ? { caption } : {}),
        },
    });
}

async function sendInteractiveButtons(to, { header, body, footer, buttons }) {
    const actionButtons = (buttons || []).slice(0, 3).map((button) => ({
        type: 'reply',
        reply: {
            id: String(button.id).slice(0, 256),
            title: truncateText(button.title || button.text, 20),
        },
    }));

    if (actionButtons.length === 0) {
        throw new Error('sendInteractiveButtons: at least one button is required');
    }

    const interactive = {
        type: 'button',
        body: { text: truncateBodyText(body, 1024) },
        action: { buttons: actionButtons },
    };

    if (header) {
        interactive.header = { type: 'text', text: truncateText(header, 60) };
    }

    if (footer) {
        interactive.footer = { text: truncateText(footer, 60) };
    }

    return sendRaw({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: digitsOnly(to),
        type: 'interactive',
        interactive,
    });
}

async function sendInteractiveList(to, { header, body, footer, buttonText, sections }) {
    const interactive = {
        type: 'list',
        body: { text: truncateBodyText(body, 1024) },
        action: {
            button: truncateText(buttonText || 'Choose', 20),
            sections: normalizeSections(sections),
        },
    };

    if (header) {
        interactive.header = { type: 'text', text: truncateText(header, 60) };
    }

    if (footer) {
        interactive.footer = { text: truncateText(footer, 60) };
    }

    return sendRaw({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: digitsOnly(to),
        type: 'interactive',
        interactive,
    });
}

/**
 * Baileys-compatible facade used by handler.js.
 */
async function sendMessage(rawTo, payload) {
    const to = digitsOnly(rawTo);
    if (!to) {
        throw new Error('sendMessage: missing recipient');
    }

    if (payload?.image?.url) {
        return await sendImage(to, payload.image.url, payload.caption);
    }

    if (payload?.document?.url) {
        return await sendDocument(
            to,
            payload.document.url,
            payload.document.fileName || payload.fileName,
            payload.caption,
        );
    }

    if (payload?.interactive?.type === 'button') {
        return await sendInteractiveButtons(to, payload.interactive);
    }

    if (payload?.interactive?.type === 'list') {
        return await sendInteractiveList(to, payload.interactive);
    }

    if (typeof payload?.text === 'string') {
        return await sendText(to, payload.text);
    }

    throw new Error(`sendMessage: unsupported payload shape (${Object.keys(payload || {}).join(',')})`);
}

async function markRead(messageId) {
    if (!messageId) {
        return;
    }

    try {
        await sendRaw({
            messaging_product: 'whatsapp',
            status: 'read',
            message_id: messageId,
        });
    } catch (_) {
        // best-effort
    }
}

module.exports = {
    sendMessage,
    sendText,
    sendImage,
    sendDocument,
    sendInteractiveButtons,
    sendInteractiveList,
    markRead,
    digitsOnly,
    truncateText,
    truncateBodyText,
    USE_INTERACTIVE,
};
