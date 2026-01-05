const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.json({
        service: 'WhatsApp Bridge',
        status: 'running',
        version: '1.0.0',
        uptime: process.uptime(),
        activeSessions: sessions.size
    });
});

app.get('/health', (req, res) => {
    const sessionStats = {
        total: sessions.size,
        connected: 0,
        disconnected: 0,
        qrPending: 0
    };

    sessions.forEach(session => {
        if (session.status === 'Connected') sessionStats.connected++;
        else if (session.status === 'QR Scan Required') sessionStats.qrPending++;
        else sessionStats.disconnected++;
    });

    res.json({
        status: 'healthy',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        sessions: sessionStats,
        timestamp: new Date().toISOString()
    });
});

const sessions = new Map();
const startingSessions = new Set(); // Tracks sessions currently in progress of connecting
const logger = pino({ level: 'debug' });

let waVersion = [2, 3000, 1015901307];
// Update version in background periodically
const updateVersion = async () => {
    try {
        const { version } = await fetchLatestBaileysVersion();
        waVersion = version;
        console.log(`Baileys: Updated WhatsApp Web version to ${version.join('.')}`);
    } catch (e) {
        console.log('Baileys: Using cached/fallback version');
    }
}
updateVersion();
setInterval(updateVersion, 3600000); // Once per hour

async function startSession(sessionId, webhookUrl, webhookToken) {
    if (sessions.has(sessionId)) {
        const existing = sessions.get(sessionId);
        if (existing.status === 'Connected') return { status: 'Connected' };
        if (existing.qr && existing.status === 'QR Scan Required') return { qr: existing.qr };
    }

    if (startingSessions.has(sessionId)) {
        return { status: 'Initializing', message: 'Session is already starting...' };
    }

    startingSessions.add(sessionId);
    console.log(`Starting session: ${sessionId}`);

    try {
        const sessionDir = path.join(__dirname, 'sessions', sessionId);
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

        const sock = makeWASocket({
            version: waVersion,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            // Using a more specific browser signature to avoid linking blocks
            browser: Browsers.macOS('Desktop'),
            connectTimeoutMs: 60000,
            retryRequestDelayMs: 5000,
            // Enhanced connection settings for better stability
            keepAliveIntervalMs: 10000,
            defaultQueryTimeoutMs: 60000,
            qrTimeout: 60000,
            // Network error handling
            shouldIgnoreJid: () => false,
            markOnlineOnConnect: true,
        });

        const sessionObj = {
            sock,
            qr: null,
            status: 'Connecting',
            webhookUrl,
            webhookToken
        };
        sessions.set(sessionId, sessionObj);

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log(`New QR generated for session: ${sessionId}`);
                sessionObj.qr = await QRCode.toDataURL(qr);
                sessionObj.status = 'QR Scan Required';
                notifyFrappe(sessionObj, 'connection.update', { status: 'QR Scan Required' });
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect.error)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 401 && statusCode !== 405;
                console.log(`Connection closed for ${sessionId}. Status: ${statusCode}. Reconnecting: ${shouldReconnect}`);

                sessionObj.status = 'Disconnected';
                notifyFrappe(sessionObj, 'connection.update', { status: 'Disconnected' });

                if (shouldReconnect) {
                    startSession(sessionId, webhookUrl, webhookToken);
                } else {
                    console.log(`Logged out from phone. Clearing session ${sessionId}`);
                    sessions.delete(sessionId);
                    if (fs.existsSync(sessionDir)) {
                        fs.rmSync(sessionDir, { recursive: true, force: true });
                    }
                }
            } else if (connection === 'open') {
                console.log(`WhatsApp Connected: ${sessionId}`);
                sessionObj.status = 'Connected';
                sessionObj.qr = null;
                notifyFrappe(sessionObj, 'connection.update', { status: 'Connected' });
            }
        });

        sock.ev.on('messages.upsert', async (m) => {
            if (m.type === 'notify') {
                for (const msg of m.messages) {
                    if (!msg.key.fromMe && msg.message) {
                        const messageType = Object.keys(msg.message)[0];
                        const isMedia = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'].includes(messageType);

                        let text = msg.message.conversation ||
                            msg.message.extendedTextMessage?.text ||
                            msg.message[messageType]?.caption ||
                            msg.message.buttonsResponseMessage?.selectedButtonId ||
                            msg.message.listResponseMessage?.title || "";

                        let mediaPayload = null;

                        if (isMedia) {
                            try {
                                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger });
                                mediaPayload = {
                                    data: buffer.toString('base64'),
                                    mimetype: msg.message[messageType].mimetype,
                                    filename: msg.message[messageType].fileName || `media_${Date.now()}`
                                };
                                if (!text) text = `[Media: ${messageType.replace('Message', '')}]`;
                                console.log(`Downloaded media: ${messageType} from ${msg.key.remoteJid}`);
                            } catch (err) {
                                console.error('Error downloading media:', err);
                            }
                        }

                        if (text || mediaPayload) {
                            const payload = {
                                messages: [{
                                    id: msg.key.id,
                                    from: msg.key.remoteJid.split('@')[0],
                                    text: text,
                                    timestamp: msg.messageTimestamp,
                                    pushName: msg.pushName,
                                    media: mediaPayload
                                }]
                            };
                            notifyFrappe(sessionObj, 'messages.upsert', payload);
                        }
                    }
                }
            }
        });

        // Wait for QR or connection
        return new Promise((resolve) => {
            let attempts = 0;
            const check = setInterval(() => {
                attempts++;
                if (sessionObj.qr || sessionObj.status === 'Connected') {
                    clearInterval(check);
                    resolve({ qr: sessionObj.qr, status: sessionObj.status });
                }
                if (attempts > 40) { // 40 seconds timeout
                    clearInterval(check);
                    resolve({ error: 'Timeout waiting for QR. Session loading in background.' });
                }
            }, 1000);
        });
    } catch (err) {
        console.error(`Error starting session ${sessionId}:`, err);
        startingSessions.delete(sessionId);
        return { error: err.message };
    } finally {
        // We delay deletion slightly to avoid instant repeat-calls
        setTimeout(() => startingSessions.delete(sessionId), 10000);
    }
}

async function notifyFrappe(session, event, data) {
    if (!session.webhookUrl) return;
    const sessionId = Array.from(sessions.entries()).find(([k, v]) => v === session)?.[0];

    if (!sessionId) {
        console.error('Could not find sessionId for webhook notification');
        return;
    }

    const maxRetries = 3;
    let attempt = 0;

    while (attempt < maxRetries) {
        try {
            const payload = {
                sessionId: sessionId,
                event,
                ...data
            };

            const headers = {
                'X-Webhook-Token': session.webhookToken,
                'X-Requested-With': 'XMLHttpRequest',
                'Content-Type': 'application/json'
            };

            const response = await axios.post(session.webhookUrl, payload, {
                headers,
                timeout: 10000,  // 10 second timeout
                maxRedirects: 5
            });

            console.log(`[${sessionId}] Webhook delivered: ${event} - Status: ${response.status}`);
            return response.data;

        } catch (e) {
            attempt++;
            console.error(`[${sessionId}] Webhook failed (attempt ${attempt}/${maxRetries}): ${e.message}`);

            if (e.response) {
                console.error(`  Response Status: ${e.response.status}`);
                console.error(`  Response Data:`, JSON.stringify(e.response.data).substring(0, 200));

                // Don't retry on 4xx errors (client errors)
                if (e.response.status >= 400 && e.response.status < 500) {
                    console.error(`  Client error - not retrying`);
                    break;
                }
            } else if (e.request) {
                console.error(`  No response received - server may be down`);
            } else {
                console.error(`  Error setting up request:`, e.message);
            }

            // Wait before retry (exponential backoff)
            if (attempt < maxRetries) {
                const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
                console.log(`  Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    console.error(`[${sessionId}] Webhook failed after ${maxRetries} attempts - giving up`);
}

// API Endpoints
app.post('/sessions/start', async (req, res) => {
    const { sessionId, webhookUrl, webhookToken } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
    const result = await startSession(sessionId, webhookUrl, webhookToken);
    res.json(result);
});

app.post('/sessions/send', async (req, res) => {
    const { sessionId, receiver, message, media } = req.body;
    console.log(`Send Request: Session=${sessionId}, To=${receiver}, HasMedia=${!!media}`);
    const session = sessions.get(sessionId);

    if (!session || session.status !== 'Connected') {
        return res.status(400).json({ error: 'Session not connected' });
    }

    try {
        let cleanedReceiver = receiver.replace(/[\s\+\-]/g, '');
        const jid = cleanedReceiver.includes('@') ? cleanedReceiver : `${cleanedReceiver}@s.whatsapp.net`;

        let result;
        if (media && media.data) {
            const buffer = Buffer.from(media.data, 'base64');
            const mimetype = media.mimetype || 'application/pdf';
            const filename = media.filename || 'file';
            const options = {};

            if (mimetype.startsWith('image/')) {
                options.image = buffer;
                if (message && message !== filename) {
                    options.caption = message;
                }
            } else if (mimetype.startsWith('video/')) {
                options.video = buffer;
                if (message && message !== filename) {
                    options.caption = message;
                }
            } else if (mimetype.startsWith('audio/')) {
                options.audio = buffer;
                options.mimetype = mimetype;
                // Check if this is a voice note (PTT)
                if (filename.includes('voice_note') || message.includes('🎤')) {
                    options.ptt = true;  // Mark as Push-To-Talk voice message
                }
            } else {
                options.document = buffer;
                options.mimetype = mimetype;
                options.fileName = filename;
                if (message && message !== filename) {
                    options.caption = message;
                }
            }
            result = await session.sock.sendMessage(jid, options);
        } else {
            result = await session.sock.sendMessage(jid, { text: message });
        }

        console.log(`Send Success for ${sessionId}`);
        res.json({ status: 'sent', result });
    } catch (e) {
        console.error(`Send Exception for ${sessionId}:`, e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/sessions/:sessionId/status', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({ status: session.status });
});

app.delete('/sessions/:sessionId', async (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (session) {
        await session.sock.logout();
        sessions.delete(req.params.sessionId);
        const sessionDir = path.join(__dirname, 'sessions', req.params.sessionId);
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
    }
    res.json({ status: 'logged out' });
});

const PORT = 3000;
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`WhatsApp Bridge running on port ${PORT}`);

    // Auto-load existing sessions from disk
    const sessionsDir = path.join(__dirname, 'sessions');
    if (fs.existsSync(sessionsDir)) {
        const folders = fs.readdirSync(sessionsDir);
        for (const sessionId of folders) {
            const sessionPath = path.join(sessionsDir, sessionId);
            if (fs.lstatSync(sessionPath).isDirectory()) {
                console.log(`Auto-starting session: ${sessionId}`);
                try {
                    startSession(sessionId).catch(e => console.error(`Failed to auto-start ${sessionId}:`, e));
                } catch (err) {
                    console.error(`Error starting session ${sessionId}:`, err);
                }
            }
        }
    }
});

// Anti-Crash Insurance: Log errors instead of stopping the process
process.on('uncaughtException', (err) => {
    console.error('CRITICAL ERROR: Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('CRITICAL ERROR: Unhandled Rejection at:', promise, 'reason:', reason);
});

// ============================================================================
// ENHANCED MEDIA & CONTACT APIs
// ============================================================================

// Get contact information including profile picture
app.post('/sessions/contact-info', async (req, res) => {
    const { sessionId, phone } = req.body;
    const session = sessions.get(sessionId);

    if (!session || session.status !== 'Connected') {
        return res.status(400).json({ error: 'Session not connected' });
    }

    try {
        let cleanedPhone = phone.replace(/[\s\+\-]/g, '');
        const jid = cleanedPhone.includes('@') ? cleanedPhone : `${cleanedPhone}@s.whatsapp.net`;

        // Get profile picture
        let profilePicUrl = null;
        try {
            profilePicUrl = await session.sock.profilePictureUrl(jid, 'image');
        } catch (e) {
            console.log(`No profile picture for ${phone}`);
        }

        // Get status/about
        let status = null;
        try {
            const statusInfo = await session.sock.fetchStatus(jid);
            status = statusInfo?.status;
        } catch (e) {
            console.log(`Could not fetch status for ${phone}`);
        }

        // Check if number exists on WhatsApp
        const [exists] = await session.sock.onWhatsApp(jid);

        res.json({
            status: 'success',
            exists: !!exists,
            profilePicture: profilePicUrl,
            about: status,
            jid: jid
        });

    } catch (e) {
        console.error(`Error getting contact info: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// Check if number is on WhatsApp
app.post('/sessions/check-number', async (req, res) => {
    const { sessionId, phone } = req.body;
    const session = sessions.get(sessionId);

    if (!session || session.status !== 'Connected') {
        return res.status(400).json({ error: 'Session not connected' });
    }

    try {
        let cleanedPhone = phone.replace(/[\s\+\-]/g, '');
        const jid = cleanedPhone.includes('@') ? cleanedPhone : `${cleanedPhone}@s.whatsapp.net`;

        const [result] = await session.sock.onWhatsApp(jid);

        res.json({
            status: 'success',
            exists: !!result,
            jid: result?.jid || jid
        });

    } catch (e) {
        console.error(`Error checking number: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// Get session info
app.get('/sessions/:sessionId', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    res.json({
        status: session.status,
        qr: session.qr,
        hasWebhook: !!session.webhookUrl
    });
});

console.log('Enhanced WhatsApp Bridge APIs loaded successfully');
