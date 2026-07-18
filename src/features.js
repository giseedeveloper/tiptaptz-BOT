/**
 * Feature flags — integrated payments (M-Pesa / bill / tip USSD push) are ON by default;
 * set INTEGRATED_PAYMENTS_ENABLED=false in .env to hide them again.
 *
 * BOT_ORDER_ENABLED=false (default): menu is PDF-only; waiters take orders via Live Order app.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const integratedPaymentsEnabled = process.env.INTEGRATED_PAYMENTS_ENABLED !== 'false';
const botOrderEnabled = process.env.BOT_ORDER_ENABLED === 'true';

const BOT_ORDER_DISABLED_STATES = new Set([
    'MENU_HUB',
    'CATEGORIES',
    'ITEMS_LIST',
    'ITEM_DETAIL',
    'QUANTITY',
    'QUANTITY_MORE',
    'CART',
    'CART_EDIT',
    'CONFIRM_ORDER',
    'MENU_IMAGE_ORDER',
    'MENU_SELECTION',
    'PICK_TABLE_FOR_ORDER',
]);

module.exports = {
    integratedPaymentsEnabled,
    botOrderEnabled,
    BOT_ORDER_DISABLED_STATES,
};
