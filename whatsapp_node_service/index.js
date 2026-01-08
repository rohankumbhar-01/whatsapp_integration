const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    downloadMediaMessage,
    jidNormalizedUser
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
const reconnectionAttempts = new Map(); // Track reconnection attempts per session
const lidToPhoneMap = new Map(); // Map LID to actual phone numbers
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

// Helper function to load LID mappings from session directory
function loadLidMappings(sessionDir) {
    try {
        const files = fs.readdirSync(sessionDir);
        let loadedCount = 0;

        for (const file of files) {
            // Look for lid-mapping-*_reverse.json files
            if (file.startsWith('lid-mapping-') && file.endsWith('_reverse.json')) {
                const lid = file.replace('lid-mapping-', '').replace('_reverse.json', '');
                const filePath = path.join(sessionDir, file);

                try {
                    const phoneNumber = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    lidToPhoneMap.set(lid, phoneNumber);
                    loadedCount++;
                } catch (err) {
                    console.error(`Error reading LID mapping file ${file}:`, err);
                }
            }
        }

        console.log(`Loaded ${loadedCount} LID-to-phone mappings from session directory`);
    } catch (err) {
        console.error('Error loading LID mappings:', err);
    }
}

// Helper function to extract actual phone number from JID
// Handles both regular JIDs and LIDs (Linked IDs)
async function getPhoneNumberFromJid(jid, sock) {
    try {
        if (!jid) return null;

        // Remove the server part (@s.whatsapp.net or @lid)
        const baseJid = jid.split('@')[0];
        const serverPart = jid.split('@')[1];

        // For LID (Linked ID) format like 260477250707536@lid
        if (serverPart === 'lid') {
            // Check if we have this LID mapped to a phone number
            if (lidToPhoneMap.has(baseJid)) {
                return lidToPhoneMap.get(baseJid);
            }

            // Fallback: Query WhatsApp to resolve LID to JID
            try {
                // Try searching for the LID as a phone user
                const [result] = await sock.onWhatsApp(jid);
                if (result && result.jid && result.jid.includes('@s.whatsapp.net')) {
                    const resolvedPhone = result.jid.split('@')[0];
                    console.log(`Resolved LID ${baseJid} to phone ${resolvedPhone} via WhatsApp query`);

                    // Cache it in memory
                    lidToPhoneMap.set(baseJid, resolvedPhone);

                    // Also save to disk if we can find the session dir
                    const sessionId = Array.from(sessions.entries()).find(([k, v]) => v.sock === sock)?.[0];
                    if (sessionId) {
                        const sessionDir = path.join(__dirname, 'sessions', sessionId);
                        if (fs.existsSync(sessionDir)) {
                            const mappingFile = path.join(sessionDir, `lid-mapping-${baseJid}_reverse.json`);
                            fs.writeFileSync(mappingFile, JSON.stringify(resolvedPhone));
                        }
                    }

                    return resolvedPhone;
                }
            } catch (e) {
                console.error(`Error resolving LID ${baseJid} via WhatsApp:`, e.message);
            }

            console.log(`LID ${baseJid} not found in mapping - keeping LID`);
            return baseJid; // Return LID if no mapping found
        }

        // For group messages (g.us suffix)
        if (serverPart === 'g.us') {
            return baseJid;
        }

        // For regular JIDs (919075167132@s.whatsapp.net)
        // Remove device ID if present (e.g., 919075167132:15)
        const phoneNumber = baseJid.split(':')[0];

        // Basic validation - phone numbers should be numeric
        if (/^\d+$/.test(phoneNumber)) {
            return phoneNumber;
        }

        console.warn(`Unexpected JID format: ${jid}`);
        return baseJid;
    } catch (err) {
        console.error('Error extracting phone number from JID:', err);
        return jid.split('@')[0].split(':')[0]; // Fallback
    }
}

async function startSession(sessionId, webhookUrl, webhookToken) {
    // Check if session already exists and is connected
    if (sessions.has(sessionId)) {
        const existing = sessions.get(sessionId);
        if (existing.status === 'Connected') {
            console.log(`Session ${sessionId} already connected, skipping`);
            return { status: 'Connected' };
        }
        if (existing.qr && existing.status === 'QR Scan Required') {
            return { qr: existing.qr };
        }
        // If session exists but disconnected, close old socket first
        if (existing.sock) {
            console.log(`Closing old socket for ${sessionId} before reconnecting`);
            try {
                existing.sock.end();
            } catch (e) {
                console.error(`Error closing old socket:`, e);
            }
        }
    }

    // Prevent duplicate connection attempts
    if (startingSessions.has(sessionId)) {
        console.log(`Session ${sessionId} already starting, skipping duplicate attempt`);
        return { status: 'Initializing', message: 'Session is already starting...' };
    }

    startingSessions.add(sessionId);
    console.log(`Starting session: ${sessionId}`);

    try {
        const sessionDir = path.join(__dirname, 'sessions', sessionId);
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

        // Load LID-to-phone mappings from session directory
        loadLidMappings(sessionDir);

        // Watch for new LID mapping files and reload
        const watcher = fs.watch(sessionDir, (eventType, filename) => {
            if (filename && filename.startsWith('lid-mapping-') && filename.endsWith('_reverse.json')) {
                console.log(`New LID mapping detected: ${filename}`);
                loadLidMappings(sessionDir);
            }
        });

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

        // Save webhook config to session directory for auto-reload
        if (webhookUrl && webhookToken) {
            const webhookConfigPath = path.join(sessionDir, 'webhook-config.json');
            try {
                fs.writeFileSync(webhookConfigPath, JSON.stringify({
                    webhookUrl,
                    webhookToken
                }));
            } catch (e) {
                console.error(`Failed to save webhook config for ${sessionId}:`, e);
            }
        }

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
                const errorMessage = lastDisconnect?.error?.message || 'Unknown error';

                // Only delete session for explicit logout or authentication failure
                // Don't delete for network errors, timeouts, or temporary issues
                const shouldDeleteSession = statusCode === DisconnectReason.loggedOut || statusCode === 401;

                // Don't reconnect if:
                // - Logged out (401)
                // - Conflict (440) - multiple sessions with same credentials
                // - Already connected elsewhere
                const shouldReconnect = !shouldDeleteSession && statusCode !== 440;

                // For conflict errors, don't try to reconnect - another session is active
                if (statusCode === 440) {
                    console.warn(`Session conflict detected for ${sessionId} - another WhatsApp Web session may be active. Stopping reconnection.`);
                    sessions.delete(sessionId);
                    startingSessions.delete(sessionId);
                }

                console.log(`Connection closed for ${sessionId}. Status: ${statusCode}. Error: ${errorMessage}. Reconnecting: ${shouldReconnect}`);

                sessionObj.status = 'Disconnected';
                notifyFrappe(sessionObj, 'connection.update', { status: 'Disconnected', error: errorMessage });

                if (shouldDeleteSession) {
                    // Only delete session when explicitly logged out (401 or loggedOut reason)
                    console.log(`Session ${sessionId} logged out. Clearing credentials.`);
                    sessions.delete(sessionId);
                    reconnectionAttempts.delete(sessionId);
                    if (fs.existsSync(sessionDir)) {
                        fs.rmSync(sessionDir, { recursive: true, force: true });
                    }
                } else if (shouldReconnect) {
                    // For all other errors (network, timeout, etc), keep session and retry
                    const attempts = reconnectionAttempts.get(sessionId) || 0;
                    const nextAttempt = attempts + 1;
                    reconnectionAttempts.set(sessionId, nextAttempt);

                    // Exponential backoff: 5s, 10s, 20s, 40s, max 60s
                    const delayMs = Math.min(5000 * Math.pow(2, attempts), 60000);

                    console.log(`Attempting to reconnect ${sessionId} (attempt ${nextAttempt}) in ${delayMs / 1000}s with existing credentials...`);

                    // Wait before reconnecting to avoid rapid reconnection loops
                    setTimeout(() => {
                        startSession(sessionId, webhookUrl, webhookToken);
                    }, delayMs);
                }
            } else if (connection === 'open') {
                console.log(`WhatsApp Connected: ${sessionId}`);
                sessionObj.status = 'Connected';
                sessionObj.qr = null;

                // Reset reconnection counter on successful connection
                reconnectionAttempts.delete(sessionId);

                notifyFrappe(sessionObj, 'connection.update', { status: 'Connected' });
            }
        });

        // Listen for contacts to build LID-to-phone mapping
        sock.ev.on('contacts.upsert', (contacts) => {
            for (const contact of contacts) {
                // Store mapping: contact.lid -> contact.id (phone number)
                if (contact.lid && contact.id) {
                    const lid = contact.lid.split('@')[0];
                    const phone = contact.id.split('@')[0].split(':')[0];

                    if (lidToPhoneMap.get(lid) !== phone) {
                        lidToPhoneMap.set(lid, phone);
                        console.log(`Contact mapping stored: LID ${lid} -> Phone ${phone}`);

                        // Save to disk for persistence
                        const sessionDir = path.join(__dirname, 'sessions', sessionId);
                        if (fs.existsSync(sessionDir)) {
                            const mappingFile = path.join(sessionDir, `lid-mapping-${lid}_reverse.json`);
                            try {
                                fs.writeFileSync(mappingFile, JSON.stringify(phone));
                            } catch (e) {
                                console.error(`Failed to save LID mapping for ${lid}:`, e);
                            }
                        }
                    }
                }
            }
        });

        sock.ev.on('presence.update', async (update) => {
            const { id, presences } = update;
            const from = await getPhoneNumberFromJid(id, sock);

            // In Baileys, presences keys might be full JIDs (including device index)
            let presence = presences[id];

            // If not found by full ID, try normalized ID
            if (!presence) {
                const normalizedId = `${from}@s.whatsapp.net`;
                presence = presences[normalizedId];
            }

            // Fallback: Use the first value in presences if it's a 1:1 chat
            if (!presence && Object.keys(presences).length > 0) {
                presence = Object.values(presences)[0];
            }

            if (presence) {
                console.log(`Presence update for ${from} (${id}): ${JSON.stringify(presence)}`);
                notifyFrappe(sessionObj, 'presence.update', { from, presence });
            }
        });

        sock.ev.on('messages.upsert', async (m) => {
            if (m.type === 'notify') {
                for (const msg of m.messages) {
                    if (!msg.key.fromMe && msg.message) {
                        console.log(`Incoming message from: ${msg.key.remoteJid}`);

                        // Build LID-to-phone mapping from message metadata
                        const remoteJid = msg.key.remoteJid;
                        if (remoteJid.includes('@lid') && msg.verifiedBizName) {
                            // This is a business account, might have phone in metadata
                            const lid = remoteJid.split('@')[0];
                            // Try to extract phone from pushName or other metadata
                            console.log(`Business message - LID: ${lid}, Name: ${msg.pushName || 'Unknown'}`);
                        }

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
                            // Extract actual phone number (handles both regular JIDs and LIDs)
                            let phoneNumber = await getPhoneNumberFromJid(msg.key.remoteJid, sock);

                            // For LID messages, try multiple methods to get actual phone
                            if (msg.key.remoteJid.includes('@lid')) {
                                const lid = msg.key.remoteJid.split('@')[0];

                                // Method 1: Check participant info (for group/broadcast messages)
                                if (msg.key.participant) {
                                    const participantNumber = await getPhoneNumberFromJid(msg.key.participant, sock);
                                    console.log(`LID message - using participant: ${participantNumber} instead of LID: ${lid}`);
                                    phoneNumber = participantNumber;
                                }
                                // Method 2: Check our LID-to-phone mapping
                                else if (lidToPhoneMap.has(lid)) {
                                    phoneNumber = lidToPhoneMap.get(lid);
                                    console.log(`LID message - mapped ${lid} to ${phoneNumber} from contact store`);
                                }
                                // Method 3: Query WhatsApp for phone number using sock.onWhatsApp
                                else {
                                    console.warn(`LID ${lid} not in mapping - saving contact name: ${msg.pushName || 'Unknown'}`);
                                    // Store with pushName for future reference
                                    phoneNumber = lid; // Keep LID for now, but log it
                                }
                            }

                            // Validate phone number is numeric
                            if (!/^\d+$/.test(phoneNumber)) {
                                console.warn(`Non-numeric phone number: ${phoneNumber} from JID: ${msg.key.remoteJid}, Name: ${msg.pushName || 'Unknown'}`);
                            }

                            // Check if this is a group message
                            const isGroup = msg.key.remoteJid.endsWith('@g.us');
                            let groupId = null;
                            let groupName = null;

                            if (isGroup) {
                                groupId = msg.key.remoteJid.split('@')[0];

                                // For group messages, the actual sender is the participant JID
                                if (msg.key.participant) {
                                    phoneNumber = await getPhoneNumberFromJid(msg.key.participant, sock);
                                }

                                // Try to get group name from metadata
                                try {
                                    const groupMetadata = await sock.groupMetadata(msg.key.remoteJid);
                                    groupName = groupMetadata.subject;
                                } catch (e) {
                                    console.warn(`Could not fetch group metadata for ${groupId}`);
                                }
                            }

                            // Check for quoted/replied message
                            let replyTo = null;
                            if (msg.message.extendedTextMessage?.contextInfo?.quotedMessage) {
                                const quotedMsg = msg.message.extendedTextMessage.contextInfo.quotedMessage;
                                const quotedText = quotedMsg.conversation ||
                                    quotedMsg.extendedTextMessage?.text ||
                                    quotedMsg.imageMessage?.caption ||
                                    '[Media]';

                                replyTo = {
                                    messageId: msg.message.extendedTextMessage.contextInfo.stanzaId,
                                    text: quotedText
                                };
                            }

                            const payload = {
                                messages: [{
                                    id: msg.key.id,
                                    from: phoneNumber,
                                    text: text,
                                    timestamp: msg.messageTimestamp,
                                    pushName: msg.pushName || 'Unknown',
                                    media: mediaPayload,
                                    isGroup: isGroup,
                                    groupId: groupId,
                                    groupName: groupName,
                                    replyTo: replyTo
                                }]
                            };
                            notifyFrappe(sessionObj, 'messages.upsert', payload);
                        }
                    }
                }
            }
        });

        // Listen for message status updates (delivery/read receipts)
        sock.ev.on('messages.update', async (updates) => {
            for (const update of updates) {
                const { key, update: statusUpdate } = update;

                // statusUpdate contains: status (delivery/read), pollUpdates, reactions, etc.
                if (statusUpdate.status) {
                    const messageId = key.id;
                    const status = statusUpdate.status; // Values: 1=sent, 2=delivered, 3=read

                    let statusText = 'Sent';
                    if (status === 2) statusText = 'Delivered';
                    else if (status === 3) statusText = 'Read';

                    console.log(`Message ${messageId} status updated to: ${statusText} (${status})`);

                    // Notify Frappe about the status update
                    const payload = {
                        messageId: messageId,
                        status: statusText,
                        timestamp: Date.now()
                    };

                    notifyFrappe(sessionObj, 'message.status', payload);
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
        let cleanedReceiver = receiver.replace(/[\s\+]/g, ''); // Don't remove - for groups
        let jid;
        if (cleanedReceiver.includes('@')) {
            jid = cleanedReceiver;
        } else if (cleanedReceiver.includes('-') || cleanedReceiver.length > 15) {
            jid = `${cleanedReceiver}@g.us`;
        } else {
            jid = `${cleanedReceiver}@s.whatsapp.net`;
        }

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

        console.log(`Send Success for ${sessionId}, Message ID: ${result.key.id}`);
        res.json({
            status: 'sent',
            messageId: result.key.id,
            timestamp: result.messageTimestamp,
        });
    } catch (e) {
        console.error(`Send Exception for ${sessionId}:`, e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/sessions/group-metadata', async (req, res) => {
    const { sessionId, groupId } = req.body;
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'Connected') {
        return res.status(400).json({ error: 'Session not connected' });
    }
    try {
        const jid = groupId.includes('@') ? groupId : `${groupId}@g.us`;
        const metadata = await session.sock.groupMetadata(jid);

        // Resolve LIDs to phone numbers for all participants
        if (metadata.participants && metadata.participants.length) {
            for (let p of metadata.participants) {
                const phone = await getPhoneNumberFromJid(p.id, session.sock);
                p.phone = phone; // Add phone number field
                p.full_id = p.id; // Keep original ID
            }
        }

        res.json({ status: 'success', metadata });
    } catch (e) {
        console.error(`Metadata Error for ${sessionId}:`, e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/sessions/subscribe-presence', async (req, res) => {
    const { sessionId, phone } = req.body;
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'Connected') {
        return res.status(400).json({ error: 'Session not connected' });
    }
    try {
        let cleanedPhone = phone.replace(/[\s\+\-]/g, '');
        const jid = cleanedPhone.includes('@') ? cleanedPhone : `${cleanedPhone}@s.whatsapp.net`;
        await session.sock.presenceSubscribe(jid);
        res.json({ status: 'success', message: `Subscribed to presence of ${jid}` });
    } catch (e) {
        console.error(`Presence Subscribe Error for ${sessionId}:`, e);
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
                    // Try to load webhook config
                    let webhookUrl, webhookToken;
                    const webhookConfigPath = path.join(sessionPath, 'webhook-config.json');
                    if (fs.existsSync(webhookConfigPath)) {
                        try {
                            const webhookConfig = JSON.parse(fs.readFileSync(webhookConfigPath, 'utf8'));
                            webhookUrl = webhookConfig.webhookUrl;
                            webhookToken = webhookConfig.webhookToken;
                            console.log(`Loaded webhook config for ${sessionId}`);
                        } catch (e) {
                            console.error(`Failed to load webhook config for ${sessionId}:`, e);
                        }
                    }
                    startSession(sessionId, webhookUrl, webhookToken).catch(e => console.error(`Failed to auto-start ${sessionId}:`, e));
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
