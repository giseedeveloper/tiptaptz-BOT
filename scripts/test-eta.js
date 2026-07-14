#!/usr/bin/env node
/**
 * Unit checks for WhatsApp customer ETA helpers.
 */
const assert = require('assert');
const { itemEtaMinutes, cartEtaMinutes, formatEtaLabel, DEFAULT_ETA_MINUTES } = require('../src/eta');

assert.strictEqual(DEFAULT_ETA_MINUTES, 15);
assert.strictEqual(itemEtaMinutes(null), 15);
assert.strictEqual(itemEtaMinutes({}), 15);
assert.strictEqual(itemEtaMinutes({ preparation_time: 25 }), 25);
assert.strictEqual(itemEtaMinutes({ eta_minutes: 18 }), 18);
assert.strictEqual(itemEtaMinutes({ preparation_time: 0 }), 15);

assert.strictEqual(cartEtaMinutes([]), 0);
assert.strictEqual(cartEtaMinutes([
    { preparation_time: 10 },
    { preparation_time: 30 },
    { preparation_time: 12 },
]), 30);

assert.strictEqual(formatEtaLabel(22, 'en'), 'Ready in ~22 min');
assert.strictEqual(formatEtaLabel(22, 'sw'), 'Tayari baada ya ~22 dak');

console.log('eta helpers OK');
