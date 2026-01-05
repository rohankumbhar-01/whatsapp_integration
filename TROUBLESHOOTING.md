# WhatsApp Integration - Troubleshooting Guide

## Issue 1: WhatsApp Not Connecting After QR Scan

### Symptoms
- QR code appears and you scan it
- WhatsApp shows "Connected" on phone
- But ERPNext shows "Disconnected" or keeps reconnecting
- Logs show: `getaddrinfo ENOTFOUND web.whatsapp.com` or `Connection was lost`

### Root Causes
1. **Network/DNS Issues**: Your network can't reach WhatsApp servers
2. **Firewall Blocking WebSockets**: Corporate firewall blocking port 443 WebSocket connections
3. **Proxy/VPN Interference**: VPN or proxy preventing direct WhatsApp connection
4. **Timeout Due to Slow Network**: High latency causing connection timeouts

### Solutions

#### Solution 1: Check Network Connectivity
```bash
# Test if WhatsApp servers are reachable
ping web.whatsapp.com

# Should show responses like:
# 64 bytes from web.whatsapp.com (157.240.x.x)

# If "unknown host" or timeout, you have DNS/network issues
```

#### Solution 2: Check Proxy Settings
```bash
# Check if proxy is set
echo $HTTP_PROXY
echo $HTTPS_PROXY

# If set, try disabling temporarily
unset HTTP_PROXY
unset HTTPS_PROXY
unset http_proxy
unset https_proxy

# Restart Node service
cd ~/dexciss-live/apps/whatsapp_integration/whatsapp_node_service
./stop.sh && ./start.sh
```

#### Solution 3: Disable VPN Temporarily
If you're using a VPN:
1. Disconnect VPN
2. Restart Node service
3. Scan QR code again
4. Once connected, you can reconnect VPN (connection usually persists)

#### Solution 4: Check Firewall
```bash
# Test WebSocket connection
curl -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==" \
  https://web.whatsapp.com/ws

# Should show "101 Switching Protocols" or "426 Upgrade Required"
# If connection refused or timeout, firewall is blocking
```

#### Solution 5: Use Mobile Hotspot
If corporate network is blocking:
1. Connect your computer to mobile hotspot
2. Restart Node service
3. Scan QR code
4. Once connected, can switch back to regular WiFi

#### Solution 6: Increase Timeouts
Already applied in latest update. The service now has:
- Connection timeout: 60 seconds
- Keep-alive interval: 10 seconds
- Retry delay: 5 seconds

---

## Issue 2: Voice Messages Not Sending

### Symptoms
- Voice recording works (red mic icon shows)
- But message fails to send
- Or receives error after sending

### Solutions

#### Solution 1: Check Session Connection
```bash
# Check if WhatsApp is connected
curl http://127.0.0.1:3000/health

# Look for "connected": 1 in the output
# If 0, need to reconnect WhatsApp first
```

#### Solution 2: Check Media Parameter Type
The recent fix handles this automatically. Media is now converted from string to dict if needed.

#### Solution 3: Test with Simple Text Message First
Before sending voice:
1. Open WhatsApp chat widget
2. Send simple text message
3. If text works, voice should work
4. If text doesn't work, WhatsApp session is disconnected

#### Solution 4: Check Browser Microphone Permission
```
1. In browser, go to Settings → Privacy → Microphone
2. Ensure ERPNext site has microphone permission
3. Reload page and try again
```

#### Solution 5: Check Audio Format
Voice messages need to be in OGG/Opus or WebM format. The code now auto-detects:
- OGG files (most browsers): Marked as PTT with proper MIME type
- WebM files (Chrome): Converted with proper codec

---

## Issue 3: "This audio not available" Error in WhatsApp

### Cause
Voice message sent without PTT (Push-To-Talk) flag.

### Solution
**Already Fixed!** The latest update adds `ptt: true` flag for voice messages.

To apply the fix:
```bash
cd ~/dexciss-live/apps/whatsapp_integration/whatsapp_node_service
./stop.sh
./start.sh
```

---

## General Debugging Steps

### Step 1: Check Service Status
```bash
cd ~/dexciss-live/apps/whatsapp_integration/whatsapp_node_service
./status.sh
```

### Step 2: View Live Logs
```bash
tail -f whatsapp-service.log
```

### Step 3: Check ERPNext Error Logs
1. In ERPNext, search for "Error Log"
2. Look for WhatsApp-related errors
3. Check timestamp to find recent errors

### Step 4: Test API Endpoints
```bash
# Health check
curl http://127.0.0.1:3000/health

# Session status
curl http://127.0.0.1:3000/sessions/WA-Dexciss_Technology_Pvt_Ltd
```

### Step 5: Fresh Start
If all else fails, fresh reconnection:
```bash
# Stop service
cd ~/dexciss-live/apps/whatsapp_integration/whatsapp_node_service
./stop.sh

# Clear session data
rm -rf sessions/*

# Start service
./start.sh

# Go to ERPNext → WhatsApp Settings → Click "Connect"
# Scan QR code again
```

---

## Common Error Messages

### Error: `getaddrinfo ENOTFOUND web.whatsapp.com`
**Meaning**: Can't resolve WhatsApp domain
**Fix**: Check DNS settings, try `ping web.whatsapp.com`

### Error: `Connection was lost (Status 408)`
**Meaning**: Request timeout
**Fix**: Network too slow or firewall blocking

### Error: `Logged out from phone (Status 405)`
**Meaning**: WhatsApp session invalidated
**Fix**: Scan QR code again

### Error: `Session not connected`
**Meaning**: WhatsApp not authenticated
**Fix**: Reconnect via QR code

### Error: `Expecting value: line 1 column 1 (char 0)`
**Meaning**: Node service returned invalid response
**Fix**: Already fixed with JSON validation

### Error: `Input should be a valid dictionary`
**Meaning**: Media parameter type mismatch
**Fix**: Already fixed with automatic JSON parsing

---

## Performance Tips

### Tip 1: Keep Node Service Running
Don't restart Node service frequently. WhatsApp doesn't like frequent reconnections.

### Tip 2: Use `bench start` for Production
Instead of manual start, use integrated approach:
```bash
cd ~/dexciss-live
bench start
```

### Tip 3: Monitor Logs Regularly
```bash
# Add to crontab for daily log rotation
0 0 * * * cd ~/dexciss-live/apps/whatsapp_integration/whatsapp_node_service && mv whatsapp-service.log whatsapp-service-$(date +\%Y\%m\%d).log
```

### Tip 4: Backup Session Data
```bash
# Weekly backup of session
tar -czf sessions-backup-$(date +\%Y\%m\%d).tar.gz sessions/
```

---

## Getting Help

If issues persist:

1. **Collect Information**:
   ```bash
   # System info
   node --version
   npm --version

   # Service status
   ./status.sh

   # Recent logs
   tail -100 whatsapp-service.log > debug.log
   ```

2. **Check Documentation**:
   - [NEW_FEATURES.md](NEW_FEATURES.md) - Feature documentation
   - [IMPROVEMENTS.md](IMPROVEMENTS.md) - Changelog
   - [AUTO_START.md](whatsapp_node_service/AUTO_START.md) - Auto-start guide

3. **GitHub Issues**:
   - Create issue with logs and error details
   - Include steps to reproduce
   - Mention your environment (macOS/Linux/Docker)

---

**Last Updated**: 2026-01-03
**Version**: 2.0.1
**Maintainer**: Claude Code Assistant
