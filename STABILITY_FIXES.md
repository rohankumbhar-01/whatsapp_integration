# WhatsApp Connection Stability Fixes

## Problems Fixed

### 1. ❌ Session Deleted on Every Error → ✅ Session Persists, Auto-Reconnects

**Before**:
```
Connection error (408, 405, 500, etc.)
→ Session folder deleted
→ Credentials lost
→ Need QR scan again
```

**After**:
```
Connection error (408, 405, 500, network timeout, etc.)
→ Session kept intact
→ Auto-reconnect with existing credentials
→ NO QR scan needed!
```

### 2. ❌ Rapid Reconnection Loops → ✅ Exponential Backoff

**Before**:
```
Error → Reconnect immediately
Error → Reconnect immediately
Error → Reconnect immediately (spam!)
→ WhatsApp blocks you (Error 515)
```

**After**:
```
Error → Wait 5s → Retry (attempt 1)
Error → Wait 10s → Retry (attempt 2)
Error → Wait 20s → Retry (attempt 3)
Error → Wait 40s → Retry (attempt 4)
Error → Wait 60s → Retry (attempt 5+)
→ Gentle reconnection, no spam
```

### 3. ❌ Random Numbers in Messages → ✅ Actual Phone Numbers

**Before**:
```
Incoming message from: 260477250707536 (LID - device identifier)
→ Shows random number in ERPNext
→ Can't identify sender
```

**After**:
```
Incoming message from: 919075167132 (actual phone number)
→ Shows real sender number
→ Properly extracts from participant info
```

## What Changed in Code

### Fix 1: Session Persistence (index.js:133-171)

```javascript
// OLD CODE:
if (statusCode !== 401 && statusCode !== 405) {
    reconnect();
} else {
    // Delete session for ANY error including network timeouts!
    fs.rmSync(sessionDir, { recursive: true, force: true });
}

// NEW CODE:
const shouldDeleteSession = statusCode === 401;  // Only on explicit logout
const shouldReconnect = !shouldDeleteSession;

if (shouldDeleteSession) {
    // Only delete when user explicitly logs out
    fs.rmSync(sessionDir, { recursive: true, force: true });
} else if (shouldReconnect) {
    // Keep session, retry with existing credentials
    setTimeout(() => startSession(sessionId), delayMs);
}
```

**Result**: Session survives network errors, timeouts, temporary issues.

### Fix 2: Exponential Backoff (index.js:156-171)

```javascript
// Track reconnection attempts per session
const reconnectionAttempts = new Map();

// On connection close:
const attempts = reconnectionAttempts.get(sessionId) || 0;
const nextAttempt = attempts + 1;
reconnectionAttempts.set(sessionId, nextAttempt);

// Exponential backoff: 5s, 10s, 20s, 40s, max 60s
const delayMs = Math.min(5000 * Math.pow(2, attempts), 60000);

setTimeout(() => {
    startSession(sessionId, webhookUrl, webhookToken);
}, delayMs);

// On successful connection:
reconnectionAttempts.delete(sessionId); // Reset counter
```

**Result**: Gentle reconnection pattern, prevents WhatsApp rate limiting.

### Fix 3: Phone Number Extraction (index.js:74-113, 256-271)

```javascript
// Helper function
function getPhoneNumberFromJid(jid, sock) {
    const baseJid = jid.split('@')[0];
    const serverPart = jid.split('@')[1];

    // Handle LID (Linked ID) format
    if (serverPart === 'lid') {
        // LID detected - will use participant info
        return baseJid;
    }

    // Regular phone number
    return baseJid.split(':')[0]; // Remove device ID
}

// In message handler:
let phoneNumber = getPhoneNumberFromJid(msg.key.remoteJid, sock);

// For LID messages, get actual sender from participant
if (msg.key.remoteJid.includes('@lid') && msg.key.participant) {
    const participantNumber = getPhoneNumberFromJid(msg.key.participant, sock);
    phoneNumber = participantNumber; // Use actual sender, not LID
}
```

**Result**: Shows actual phone numbers instead of device identifiers.

## When Sessions ARE Deleted

**Only delete session credentials when**:
- ✅ Status 401: Explicit authentication failure
- ✅ `DisconnectReason.loggedOut`: User logged out from phone

**Keep session for**:
- ✅ Status 408: Timeout
- ✅ Status 500: Server error
- ✅ Network errors
- ✅ Connection drops
- ✅ Service restarts

## Connection Flow Now

### Scenario 1: Network Timeout
```
1. Connection drops (408 timeout)
2. Session kept, status → Disconnected
3. Wait 5 seconds
4. Reconnect with saved credentials
5. Connection successful
6. Status → Connected
7. Reset reconnection counter
```

### Scenario 2: Multiple Failures
```
1. Connection drops (network issue)
2. Reconnect attempt 1: Wait 5s → Failed
3. Reconnect attempt 2: Wait 10s → Failed
4. Reconnect attempt 3: Wait 20s → Failed
5. Reconnect attempt 4: Wait 40s → Success!
6. Connected, reset counter
```

### Scenario 3: Service Restart
```
1. Service stops
2. Service starts
3. Auto-loads session from disk
4. Reconnects with saved credentials
5. Connected!
6. NO QR SCAN NEEDED!
```

### Scenario 4: Explicit Logout
```
1. User logs out from phone (401)
2. Session credentials deleted
3. Status → Logged out
4. QR scan required (expected behavior)
```

## Benefits

### For Users
✅ **No more constant QR scanning**
✅ **Connection survives restarts**
✅ **See real phone numbers in messages**
✅ **Stable, reliable connection**

### For System
✅ **Survives network hiccups**
✅ **Handles server restarts gracefully**
✅ **Prevents WhatsApp rate limiting**
✅ **Proper error handling**

## Testing the Fixes

### Test 1: Service Restart
```bash
# Before: QR scan needed after every restart
# After: Auto-reconnects with saved credentials

cd ~/dexciss-live/apps/whatsapp_integration/whatsapp_node_service
./stop.sh
./start.sh

# Wait 5-10 seconds
# Check status - should reconnect automatically
curl http://127.0.0.1:3000/health
```

### Test 2: Network Interruption
```bash
# Before: Session deleted, QR scan needed
# After: Auto-reconnects after network returns

# Disconnect WiFi for 30 seconds
# Reconnect WiFi
# Service will auto-reconnect within 60 seconds
```

### Test 3: Incoming Message from Linked Device
```bash
# Before: Shows random number like 260477250707536
# After: Shows actual sender phone number like 919075167132

# Send message from phone with linked devices
# Check in ERPNext - should show real number
```

## Monitoring Connection

### View Live Logs
```bash
cd ~/dexciss-live/apps/whatsapp_integration/whatsapp_node_service
tail -f whatsapp-service.log | grep -i "reconnect\|connected\|error"
```

### Check Reconnection Attempts
Look for lines like:
```
Attempting to reconnect WA-Dexciss_Technology_Pvt_Ltd (attempt 2) in 10s with existing credentials...
```

### Successful Connection
Look for:
```
WhatsApp Connected: WA-Dexciss_Technology_Pvt_Ltd
```

## Configuration

### Auto-Start on Boot

Session is automatically loaded when service starts:
```javascript
// In index.js - auto-loads existing sessions
const sessionsDir = path.join(__dirname, 'sessions');
if (fs.existsSync(sessionsDir)) {
    const folders = fs.readdirSync(sessionsDir);
    for (const sessionId of folders) {
        startSession(sessionId); // Auto-reconnect!
    }
}
```

### Reconnection Settings

Current settings:
- **Initial delay**: 5 seconds
- **Max delay**: 60 seconds
- **Backoff multiplier**: 2x each attempt
- **Pattern**: 5s → 10s → 20s → 40s → 60s → 60s...

To adjust, edit `index.js` line 163:
```javascript
// Change base delay (currently 5000ms = 5s)
const delayMs = Math.min(5000 * Math.pow(2, attempts), 60000);
//                       ^^^^                          ^^^^^
//                       Base delay                    Max delay
```

## Troubleshooting

### Session Still Getting Deleted?

Check the error status code:
```bash
tail -f whatsapp-service.log | grep "Connection closed"
```

If you see `Status: 401`, that's an explicit logout - session SHOULD be deleted.
Any other status (408, 500, etc.) keeps the session.

### Connection Not Auto-Recovering?

1. **Check session files exist**:
   ```bash
   ls sessions/WA-Dexciss_Technology_Pvt_Ltd/
   # Should show creds.json and other files
   ```

2. **Check logs for reconnection attempts**:
   ```bash
   tail -50 whatsapp-service.log | grep "Attempting to reconnect"
   ```

3. **If still failing after 5 attempts (5min)**:
   - Might be a permanent network block
   - Try different network (mobile hotspot)
   - May need to scan QR again (rare)

### LID Numbers Still Showing?

Check if messages have participant info:
```bash
tail -f whatsapp-service.log | grep -i "LID message"
```

Should see:
```
LID message - using participant: 919075167132 instead of LID: 260477250707536
```

## Summary

**What you get now**:
- ✅ Stable WhatsApp connection that survives restarts
- ✅ Auto-reconnection with saved credentials
- ✅ No more constant QR scanning
- ✅ Proper phone numbers in messages
- ✅ Intelligent reconnection with exponential backoff

**When you still need QR scan**:
- ❌ Only when explicitly logged out (Status 401)
- ❌ First time connecting
- ❌ After manually deleting session folder

---

**Version**: 2.1.0
**Date**: 2026-01-07
**Status**: All fixes applied and tested
