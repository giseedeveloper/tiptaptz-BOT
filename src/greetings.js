/**
 * Detect casual greetings (EN, SW, ZA) including common typos.
 * Used before restaurant search so "hellow" gets the welcome card, not "not found".
 */

const EXACT_GREETINGS = new Set([
    // English
    'hi', 'hii', 'hiii', 'hie', 'hey', 'heya', 'heyy', 'heyyy',
    'hello', 'hellow', 'helo', 'hallo', 'halo',
    'whats', 'wassup', 'sup', 'yo', 'yoh', 'howdy',
    'what\'s up', 'whats up', 'what up', 'wassup',
    'good morning', 'good afternoon', 'good evening', 'good day', 'good night',
    'gm', 'morning', 'afternoon', 'evening',
  // Swahili (TZ / East Africa)
    'mambo', 'habari', 'habari yako', 'habari gani', 'niaje', 'sasa', 'hujambo',
    'salama', 'salamu', 'vipi', 'shwari', 'poa', 'jambo', 'shikamoo',
  // South Africa
    'howzit', 'howsit', 'howzit my bru', 'heita', 'aweh', 'awe', 'sawubona',
    'molo', 'dumela', 'hallo daar', 'how are you', 'how you', 'howz u',
]);

/**
 * @param {unknown} text
 * @returns {boolean}
 */
function normalizeGreetingText(text) {
    return String(text || '')
        .toLowerCase()
        .trim()
        .replace(/[!?.。,;:]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * @param {unknown} text
 * @returns {boolean}
 */
function isGreeting(text) {
    const normalized = normalizeGreetingText(text);

    if (!normalized || normalized.length > 48) {
        return false;
    }

    if (EXACT_GREETINGS.has(normalized)) {
        return true;
    }

    const compact = normalized.replace(/\s/g, '');

    if (/^h+i+$/.test(compact)) {
        return true;
    }

    if (/^h+e+y+$/.test(compact)) {
        return true;
    }

    if (/^h+e+l+o+w*$/.test(compact)) {
        return true;
    }

    if (/^howz?it$/.test(compact) || /^howsit$/.test(compact)) {
        return true;
    }

    const shortPhrase = normalized.length <= 32 && /^(hi|hey|hello|hallo|mambo|habari|howzit|heita|good morning|good afternoon|good evening|what'?s up|whats up|salama|niaje|hujambo|sawubona|dumela|molo)\b/.test(normalized);

    return shortPhrase;
}

/**
 * QR scan / waiter tag / START payload — must bypass welcome card and go to handleEntry.
 *
 * @param {unknown} text
 * @returns {boolean}
 */
function isEntryCode(text) {
    const value = String(text || '').trim();

    if (!value) {
        return false;
    }

    if (value.startsWith('START|') || value.startsWith('START_')) {
        return true;
    }

    return /^[A-Z0-9]+-[A-Z0-9]+$/i.test(value);
}

/**
 * Show welcome card before a restaurant is chosen (fresh chat, after Leave, or casual openers).
 *
 * @param {{ state?: string, restaurant_id?: unknown }} session
 * @param {unknown} text
 * @returns {boolean}
 */
function shouldOfferWelcome(session, text) {
    if (session?.restaurant_id || isEntryCode(text)) {
        return false;
    }

    if (session?.state === 'START') {
        return true;
    }

    return isGreeting(text);
}

module.exports = {
    isGreeting,
    isEntryCode,
    normalizeGreetingText,
    shouldOfferWelcome,
};
