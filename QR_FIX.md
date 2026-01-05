# QR Code Not Connecting - Error 515 Fix

## What's Happening

Your logs show:
```
✅ QR generated successfully
✅ You scan with phone - pairing successful
❌ Status 515: Stream Errored (restart required)
❌ Status 401: Connection Failure
❌ Session cleared and starts over
```

Error **515** means: **"Too many connection attempts - WhatsApp temporarily blocked you"**

## Why This Happens

1. **Multiple QR Scans**: You scanned QR code multiple times in quick succession
2. **WhatsApp Anti-Spam**: WhatsApp thinks it's suspicious activity
3. **Rate Limiting**: WhatsApp has rate limits on new device connections

## The Fix (MUST Follow This Order)

### Step 1: WAIT 10-15 Minutes ⏰

**This is CRITICAL**. WhatsApp has temporarily rate-limited your account.

```bash
# Stop the service
cd ~/dexciss-live/apps/whatsapp_integration/whatsapp_node_service
./stop.sh

# Wait 10-15 minutes
# DO NOT try to reconnect during this time
# Go get coffee ☕
```

### Step 2: Check Linked Devices on Your Phone

While waiting, check how many devices are linked:

1. Open WhatsApp on your phone
2. Go to **Settings → Linked Devices**
3. **Remove ALL old/unused linked devices**
   - Tap each device → Unlink
   - You can have maximum 5 devices
4. Leave only your primary phone

### Step 3: Clear All Session Data

After 10+ minutes wait:

```bash
cd ~/dexciss-live/apps/whatsapp_integration/whatsapp_node_service

# Remove all session data
rm -rf sessions/*

# Verify it's clean
ls -la sessions/
# Should only show . and .. (empty)
```

### Step 4: Start Fresh (ONE TIME ONLY)

```bash
# Start service
./start.sh

# Wait 5 seconds for service to stabilize
sleep 5

# Check it's running
./status.sh
```

### Step 5: Connect in ERPNext (DO THIS ONCE)

1. Open ERPNext in browser
2. Go to **WhatsApp Settings**
3. Click **"Connect"** button
4. **QR code appears**
5. **Scan ONCE** with phone
6. **WAIT** - Don't refresh, don't click again
7. Should connect within 10-30 seconds

### Step 6: Verify Connection

```bash
# Check session status
curl http://127.0.0.1:3000/health | python3 -m json.tool

# Should show:
# "connected": 1

# Or check logs
tail -20 whatsapp-service.log | grep -i "connected\|open"
# Should show: "WhatsApp Connected: WA-Dexciss_Technology_Pvt_Ltd"
```

## If Still Failing

### Check 1: Too Many Devices

If you have 5 devices already linked:
- WhatsApp won't let you link more
- You MUST unlink one first
- Then wait 5 minutes
- Try again

### Check 2: Network Issues

```bash
# Test WhatsApp server
ping web.whatsapp.com

# Test WebSocket
curl -v https://web.whatsapp.com 2>&1 | grep -i "connected\|upgrade"
```

### Check 3: Try Different Network

If corporate network is blocking:
1. Connect to mobile hotspot
2. Clear sessions
3. Try QR scan on mobile hotspot
4. Once connected, can switch back to WiFi

## What NOT To Do

❌ **DON'T** spam QR code reconnect button
❌ **DON'T** scan multiple QR codes in row
❌ **DON'T** restart Node service repeatedly
❌ **DON'T** try to connect before 10 minute wait
❌ **DON'T** have multiple browser tabs with QR open

## What TO Do

✅ **DO** wait 10-15 minutes after getting error 515
✅ **DO** remove old linked devices first
✅ **DO** scan QR code only ONCE
✅ **DO** wait patiently after scanning (10-30 seconds)
✅ **DO** check if you're within 5 device limit

## Technical Details

### Error Code Meanings

| Code | Meaning | Action |
|------|---------|--------|
| 515 | Stream error / Too many attempts | Wait 10-15 minutes |
| 401 | Authentication failed | Session invalid, re-scan QR |
| 405 | Logged out from phone | Session cleared, re-scan QR |
| 408 | Timeout | Network issue, check connection |

### Successful Connection Logs

When it works, you'll see:
```
pair success recv
pairing configured successfully
Event buffer activated
opened connection to WA
WhatsApp Connected: WA-Dexciss_Technology_Pvt_Ltd
Webhook delivered: connection.update - Status: 200
```

### Failed Connection Pattern (Error 515)

What you're seeing now:
```
pair success recv
pairing configured successfully  ← Pairing works
stream errored out (code: 515)   ← WhatsApp blocks
Connection Failure (Status: 401)  ← Auth rejected
Logged out from phone             ← Session cleared
```

## Prevention Tips

Once connected successfully:

1. **Don't logout unless necessary**
2. **Let service run continuously**
3. **Use `bench start` for integrated startup**
4. **Backup session data weekly**:
   ```bash
   cd ~/dexciss-live/apps/whatsapp_integration/whatsapp_node_service
   tar -czf session-backup-$(date +%Y%m%d).tar.gz sessions/
   ```

5. **Monitor logs for disconnections**:
   ```bash
   tail -f whatsapp-service.log | grep -i "disconnected\|error"
   ```

## Summary

**Current Status**: WhatsApp temporarily blocked due to too many QR scans

**Solution**:
1. Wait 10-15 minutes ⏰
2. Unlink old devices 📱
3. Clear session data 🗑️
4. Scan QR ONCE ✅
5. Be patient ⏳

**Expected Time**: 15-20 minutes total (mostly waiting)

---

**If this doesn't work after 15 min wait, try tomorrow** - WhatsApp might have longer rate limit.
