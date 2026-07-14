const axios = require('axios');
const https = require('https');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const api = axios.create({
    baseURL: process.env.API_BASE_URL,
    headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${process.env.BOT_TOKEN}`
    },
    timeout: 30000,
    httpsAgent: new https.Agent({
        rejectUnauthorized: false
    })
});

// Add response interceptor for error handling
api.interceptors.response.use(
    response => response,
    error => {
        console.error('API Error:', error.response?.data || error.message);
        throw error;
    }
);

module.exports = {
    /**
     * 1. QR Scan / Entry (Verify Restaurant)
     * GET /api/bot/verify-restaurant?restaurant_id=1&table_number=5
     * Response: { success, data: { id, name, location, table_number } }
     */
    verifyRestaurant: async (restaurantId, tableNumber) => {
        const response = await api.get('/verify-restaurant', {
            params: { restaurant_id: restaurantId, table_number: tableNumber }
        });
        return response.data;
    },

    /**
     * 2. Search Restaurant (Backup Entry)
     * GET /api/bot/search-restaurant?query=Samaki
     * Response: { success, count, data: [{ id, name, location }] }
     */
    searchRestaurant: async (query) => {
        const response = await api.get('/search-restaurant', {
            params: { query }
        });
        return response.data;
    },

    /**
     * 3. Get Full Menu (Categories + Items)
     * GET /api/bot/restaurant/{id}/full-menu
     * Response: { success, data: [{ id, name, menu_items: [{ id, name, price, is_available }] }] }
     */
    getFullMenu: async (restaurantId) => {
        const response = await api.get(`/restaurant/${restaurantId}/full-menu`);
        return response.data;
    },

    /**
     * 4. Get Item Detail
     * GET /api/bot/item/{id}
     * Response: { success, data: { id, name, price, description, image } }
     */
    getItemDetail: async (itemId) => {
        const response = await api.get(`/item/${itemId}`);
        return response.data;
    },

    /**
     * 5. Create Order (Tuma Oda)
     * POST /api/bot/order
     * Body: { restaurant_id, table_number, customer_phone, items: [{ menu_item_id, quantity }] }
     * Response: { success, order_id, total, message }
     */
    createOrder: async (orderData) => {
        const totalAmount = orderData.items.reduce((sum, item) => sum + (item.price * item.qty), 0);
        const payload = {
            restaurant_id: orderData.restaurant_id,
            table_number: orderData.table_number,
            customer_phone: orderData.customer_phone,
            waiter_id: orderData.waiter_id,
            customer_name: orderData.customer_name,
            total: totalAmount,
            items: orderData.items.map(item => ({
                menu_item_id: item.menu_id,
                quantity: item.qty,
                price: parseFloat(item.price),
                total: parseFloat(item.price) * item.qty,
                subtotal: parseFloat(item.price) * item.qty
            }))
        };

        if (orderData.table_id) payload.table_id = orderData.table_id;
        payload.whatsapp_jid = orderData.whatsapp_jid ?? null;

        const response = await api.post('/order', payload);
        return response.data;
    },

    /**
     * 5b. Create Order via Text (Smart Matching)
     * POST /api/bot/order/text
     * Body: { restaurant_id, table_number, customer_phone, order_text }
     */
    createOrderText: async (data) => {
        try {
            const payload = {
                restaurant_id: data.restaurant_id,
                customer_phone: data.customer_phone,
                order_text: data.order_text
            };

            if (data.table_id) payload.table_id = data.table_id;
            if (data.table_number) payload.table_number = data.table_number;
            if (data.waiter_id) payload.waiter_id = data.waiter_id;
            if (data.customer_name) payload.customer_name = data.customer_name;
            payload.whatsapp_jid = data.whatsapp_jid ?? null;

            const response = await api.post('/order/text', payload);
            return response.data;
        } catch (error) {
            if (error.response && error.response.data) {
                return error.response.data;
            }
            throw error;
        }
    },

    /**
     * Get Tables for a specific restaurant (Bot API)
     * GET /api/bot/restaurant/{id}/tables
     */
    getRestaurantTables: async (restaurantId) => {
        try {
            // Try variation 1: /restaurant/{id}/tables
            const res1 = await api.get(`/restaurant/${restaurantId}/tables`);
            if (res1.data && res1.data.success) return res1.data;

            // Try variation 2: /tables?restaurant_id={id}
            const res2 = await api.get('/tables', { params: { restaurant_id: restaurantId } });
            return res2.data;
        } catch (e) {
            console.log('TipTap tables API failed, falling back to manager API...');
            return module.exports.getManagerTables();
        }
    },

    /**
     * 6. Polling Status (Check Order & Payment)
     * GET /api/bot/order/{id}/status
     * Response: { success, status, payment_status, total, items }
     */
    getOrderStatus: async (orderId) => {
        const response = await api.get(`/order/${orderId}/status`);
        return response.data;
    },

    /**
     * 7. Initiate USSD Payment
     * POST /api/bot/payment/ussd
     * Body: { order_id, phone_number, amount }
     * Response: { success, payment_id, message }
     */
    initiateUssdPayment: async (paymentData) => {
        console.log('🚀 [USSD] Requesting push for Order:', paymentData.order_id);
        console.log('📱 [USSD] Data:', {
            phone: paymentData.phone,
            amount: paymentData.amount,
            network: paymentData.network
        });

        const response = await api.post('/payment/ussd', {
            order_id: paymentData.order_id,
            phone_number: paymentData.phone,
            amount: paymentData.amount,
            network: paymentData.network
        });

        console.log('✅ [USSD] API Response:', JSON.stringify(response.data, null, 2));
        return response.data;
    },

    /**
     * 8. Submit Feedback
     * POST /api/bot/feedback
     * Body: { restaurant_id, customer_phone, rating, comment }
     * Response: { success, message }
     */
    submitFeedback: async (feedbackData) => {
        const response = await api.post('/feedback', feedbackData);
        return response.data;
    },

    /**
     * 9. Submit Tip
     * POST /api/bot/tip
     * Body: { order_id, amount }
     * Response: { success, message }
     */
    submitTip: async (tipData) => {
        const response = await api.post('/tip', {
            restaurant_id: tipData.restaurant_id,
            order_id: tipData.order_id,
            amount: tipData.amount
        });
        return response.data;
    },

    /**
     * Check if waiter is online (before call-waiter).
     * GET /api/bot/waiter/{waiterId}/status
     * Response: { success, data: { waiter_id, name, is_online, last_online_at } }
     */
    getWaiterStatus: async (waiterId) => {
        const response = await api.get(`/waiter/${waiterId}/status`);
        return response.data;
    },

    /**
     * 10. Call Waiter / Request Bill
     * POST /api/bot/call-waiter
     * Body: { restaurant_id, table_number, request_type }
     * Response: { success, message }
     */
    callWaiter: async (data) => {
        const payload = {
            restaurant_id: data.restaurant_id,
            type: data.request_type, // 'call_waiter' or 'request_bill'
            table_number: data.table_number || ""
        };

        if (data.waiter_id) payload.waiter_id = data.waiter_id;
        if (data.table_id) payload.table_id = data.table_id;

        const response = await api.post('/call-waiter', payload);
        return response.data;
    },

    /**
     * 11. Get Active Order (Bill)
     * GET /api/bot/active-order?restaurant_id=2&table_number=1
     */
    getActiveOrder: async (restaurantId, tableNumber) => {
        const response = await api.get('/active-order', {
            params: { restaurant_id: restaurantId, table_number: tableNumber }
        });
        return response.data;
    },

    /**
     * 12. List Waiters
     * GET /api/bot/restaurant/{id}/waiters
     */
    getWaiters: async (restaurantId, options = {}) => {
        const params = {};
        if (options.tippableOnly) {
            params.tippable_only = 1;
        }
        if (options.role) {
            params.role = options.role;
        }
        const response = await api.get(`/restaurant/${restaurantId}/waiters`, { params });
        return response.data;
    },

    /**
     * Active tip pools (e.g. kitchen) customers can tip.
     * GET /api/bot/restaurant/{id}/tip-pools
     */
    getTipPools: async (restaurantId) => {
        const response = await api.get(`/restaurant/${restaurantId}/tip-pools`);
        return response.data;
    },

    /**
     * Post-payment tipping options (Waiter / Barista / Kitchen / Split + amounts).
     * GET /api/bot/restaurant/{id}/post-payment-tip-options
     */
    getPostPaymentTipOptions: async (restaurantId, waiterId = null) => {
        const params = {};
        if (waiterId) {
            params.waiter_id = waiterId;
        }
        const response = await api.get(`/restaurant/${restaurantId}/post-payment-tip-options`, { params });
        return response.data;
    },

    /**
     * 13. Get Menu PDF (WhatsApp document)
     * GET /api/bot/restaurant/{restaurantId}/menu-pdf
     */
    getMenuPdf: async (restaurantId, context = {}) => {
        try {
            const response = await api.get(`/restaurant/${restaurantId}/menu-pdf`, {
                params: {
                    wa_id: context.wa_id,
                    customer_phone: context.customer_phone,
                    table_id: context.table_id,
                    table_number: context.table_number,
                },
            });
            return response.data;
        } catch (error) {
            console.error('Get menu PDF error:', error.response?.data || error.message);
            return { success: false, message: 'No menu PDF available' };
        }
    },

    /** @deprecated Use getMenuPdf */
    getMenuImage: async (restaurantId) => api.getMenuPdf(restaurantId),

    /**
     * 14. Initiate Quick Payment (Payment bila Order, or Tip kwa waiter)
     * POST /api/bot/payment/quick
     * When waiter_id is sent, backend creates a Tip record when payment is confirmed.
     */
    initiateQuickPayment: async (paymentData) => {
        const payload = {
            restaurant_id: paymentData.restaurant_id,
            phone_number: paymentData.phone_number,
            amount: parseInt(paymentData.amount),
            description: paymentData.description,
            network: paymentData.network
        };
        if (paymentData.waiter_id) payload.waiter_id = paymentData.waiter_id;
        if (paymentData.tip_pool_id) payload.tip_pool_id = paymentData.tip_pool_id;
        const response = await api.post('/payment/quick', payload);
        return response.data;
    },

    /**
     * 15. Check Quick Payment Status
     * GET /api/bot/payment/quick/{paymentId}/status
     */
    checkQuickPaymentStatus: async (paymentId) => {
        const response = await api.get(`/payment/quick/${paymentId}/status`);
        return response.data;
    },

    /**
     * 16. Parse Entry (Identify QR/Tag)
     * POST /api/bot/parse-entry
     * Body: { entry: "SMK-W01" }
     */
    parseEntry: async (entry, context = {}) => {
        try {
            // Reverted to POST because server returned MethodNotAllowed for GET.
            // Using 'input' as the key as per instructions.
            const response = await api.post('/parse-entry', {
                input: entry,
                wa_id: context.wa_id,
                customer_phone: context.customer_phone,
            });
            return response.data;
        } catch (error) {
            console.error('Parse entry error:', error.response?.data || error.message);
            return { success: false, message: 'Invalid entry' };
        }
    },

    // ═══════════════════════════════════════════════════════════════
    // MANAGER APIs (Dynamic Data Fetching)
    // ═══════════════════════════════════════════════════════════════

    /**
     * Get Tables from Manager API
     * GET /api/v1/manager/tables
     */
    getManagerTables: async () => {
        const baseUrl = process.env.API_BASE_URL.replace('/bot', '');
        const response = await axios.get(`${baseUrl}/v1/manager/tables`, {
            headers: {
                'Authorization': `Bearer ${process.env.BOT_TOKEN}`,
                'Accept': 'application/json'
            }
        });
        return response.data;
    },

    /**
     * Get Categories from Manager API
     * GET /api/v1/manager/categories
     */
    getManagerCategories: async () => {
        const baseUrl = process.env.API_BASE_URL.replace('/bot', '');
        const response = await axios.get(`${baseUrl}/v1/manager/categories`, {
            headers: {
                'Authorization': `Bearer ${process.env.BOT_TOKEN}`,
                'Accept': 'application/json'
            }
        });
        return response.data;
    },

    /**
     * Get Menu Items from Manager API
     * GET /api/v1/manager/menu
     */
    getManagerMenu: async () => {
        const baseUrl = process.env.API_BASE_URL.replace('/bot', '');
        const response = await axios.get(`${baseUrl}/v1/manager/menu`, {
            headers: {
                'Authorization': `Bearer ${process.env.BOT_TOKEN}`,
                'Accept': 'application/json'
            }
        });
        return response.data;
    },

    /**
     * Global welcome card branding (logo + title + optional body).
     * GET /api/bot/branding
     */
    getBranding: async () => {
        const response = await api.get('/branding');
        return response.data;
    },
};
