const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { handleMessage } = require('./handler.js');
const { startNotifyServer } = require('./notify-server.js');

console.log('╔════════════════════════════════════════════════════════════════╗');
console.log('║                      TipTap WhatsApp                             ║');
console.log('║         Restaurant Ordering System via WhatsApp                 ║');
console.log('╚════════════════════════════════════════════════════════════════╝');
console.log('');

let activeSock = null;
startNotifyServer(() => activeSock);

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version, isLatest } = await fetchLatestBaileysVersion();

    console.log(`📱 Using WhatsApp Web v${version.join('.')}, isLatest: ${isLatest}`);
    console.log(`🌐 API Base URL: ${process.env.API_BASE_URL}`);
    console.log(`🔑 BOT_TOKEN loaded: ${process.env.BOT_TOKEN ? 'Yes (starts with ' + process.env.BOT_TOKEN.substring(0, 5) + '...)' : 'No'}`);
    console.log('');

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        getMessage: async (key) => {
            return { conversation: 'hello' };
        }
    });
    activeSock = sock;

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('📲 Scan QR code below with WhatsApp (Linked Devices > Link a Device):');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            qrcode.generate(qr, { small: true });
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error instanceof Boom)
                ? lastDisconnect.error.output.statusCode
                : null;

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log('');
            console.log(`❌ Connection closed. Reason: ${lastDisconnect?.error?.message || 'Unknown'}`);

            if (shouldReconnect) {
                console.log('🔄 Reconnecting in 3 seconds...');
                setTimeout(() => connectToWhatsApp(), 3000);
            } else {
                console.log('🚪 Logged out. Please delete auth_info_baileys folder and restart.');
            }
        } else if (connection === 'open') {
            console.log('');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('✅ TipTap is now ONLINE and ready to receive messages!');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type === 'notify') {
            for (const msg of m.messages) {
                if (!msg.key.fromMe && msg.message) {
                    const from = msg.key.remoteJid;
                    const msgType = Object.keys(msg.message)[0];

                    console.log(`📩 [${new Date().toLocaleTimeString()}] Message from ${from}: ${msgType}`);

                    try {
                        await handleMessage(sock, msg);
                    } catch (error) {
                        console.error('❌ Error handling message:', error);
                    }
                }
            }
        }
    });

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n👋 Shutting down TipTap...');
        process.exit(0);
    });
}

// Start the bot
connectToWhatsApp().catch(err => {
    console.error('❌ Failed to start bot:', err);
    process.exit(1);
});
