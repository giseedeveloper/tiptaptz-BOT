/**
 * Customer-facing preparation time / ETA helpers for WhatsApp menu ordering.
 */

const DEFAULT_ETA_MINUTES = 15;

function itemEtaMinutes(item) {
    if (!item || typeof item !== 'object') {
        return DEFAULT_ETA_MINUTES;
    }

    const raw = item.eta_minutes ?? item.preparation_time ?? item.preparationTime;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) {
        return Math.round(n);
    }

    return DEFAULT_ETA_MINUTES;
}

function cartEtaMinutes(cart = []) {
    if (!Array.isArray(cart) || cart.length === 0) {
        return 0;
    }

    return cart.reduce((max, item) => Math.max(max, itemEtaMinutes(item)), 0);
}

function formatEtaLabel(minutes, lang = 'en') {
    const m = Number.isFinite(Number(minutes)) && Number(minutes) > 0
        ? Math.round(Number(minutes))
        : DEFAULT_ETA_MINUTES;

    if (lang === 'sw') {
        return `Tayari baada ya ~${m} dak`;
    }

    return `Ready in ~${m} min`;
}

module.exports = {
    DEFAULT_ETA_MINUTES,
    itemEtaMinutes,
    cartEtaMinutes,
    formatEtaLabel,
};
