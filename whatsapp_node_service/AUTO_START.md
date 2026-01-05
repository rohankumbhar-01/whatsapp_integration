# WhatsApp Node Service - Auto-Start Guide

## Why Manual Start?

The WhatsApp Node.js service runs separately from Frappe because:

1. **Different Technologies**: Frappe (Python) vs WhatsApp Bridge (Node.js)
2. **Real-time WebSockets**: Node.js handles WhatsApp connections better than Python
3. **Process Independence**: If one crashes, the other keeps running

## Quick Commands

I've created 3 convenient scripts for you:

### Start Service
```bash
cd ~/dexciss-live/apps/whatsapp_integration/whatsapp_node_service
./start.sh
```

### Stop Service
```bash
cd ~/dexciss-live/apps/whatsapp_integration/whatsapp_node_service
./stop.sh
```

### Check Status
```bash
cd ~/dexciss-live/apps/whatsapp_integration/whatsapp_node_service
./status.sh
```

---

## Option 1: Auto-Start with PM2 (Recommended)

PM2 is a production-grade process manager that auto-restarts services.

### Install PM2
```bash
npm install -g pm2
```

### Setup WhatsApp Service
```bash
cd ~/dexciss-live/apps/whatsapp_integration/whatsapp_node_service

# Start with PM2
pm2 start index.js --name whatsapp-service

# Save configuration
pm2 save

# Setup auto-start on boot
pm2 startup
# Follow the instructions shown (usually requires sudo)
```

### PM2 Commands
```bash
pm2 status                    # Check status
pm2 logs whatsapp-service     # View logs
pm2 restart whatsapp-service  # Restart
pm2 stop whatsapp-service     # Stop
pm2 delete whatsapp-service   # Remove from PM2
```

---

## Option 2: Auto-Start with Bench (Development)

Add to your bench start command using Procfile.

### Create Procfile Entry

Add this to `~/dexciss-live/Procfile`:

```
whatsapp: cd apps/whatsapp_integration/whatsapp_node_service && node index.js
```

Then when you run `bench start`, it will start automatically!

### How to Add It

```bash
cd ~/dexciss-live

# Edit Procfile
nano Procfile

# Add this line at the end:
# whatsapp: cd apps/whatsapp_integration/whatsapp_node_service && node index.js

# Save and exit (Ctrl+X, Y, Enter)

# Now bench start will include WhatsApp service
bench start
```

---

## Option 3: System Service with Launchd (macOS Production)

For production on macOS, create a LaunchAgent.

### Create Launch Agent

```bash
# Create plist file
cat > ~/Library/LaunchAgents/com.dexciss.whatsapp.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.dexciss.whatsapp</string>

    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>index.js</string>
    </array>

    <key>WorkingDirectory</key>
    <string>/Users/rohankumbhar/dexciss-live/apps/whatsapp_integration/whatsapp_node_service</string>

    <key>StandardOutPath</key>
    <string>/Users/rohankumbhar/dexciss-live/apps/whatsapp_integration/whatsapp_node_service/whatsapp-service.log</string>

    <key>StandardErrorPath</key>
    <string>/Users/rohankumbhar/dexciss-live/apps/whatsapp_integration/whatsapp_node_service/whatsapp-service-error.log</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
EOF

# Load the service
launchctl load ~/Library/LaunchAgents/com.dexciss.whatsapp.plist

# Check status
launchctl list | grep whatsapp
```

### Launchd Commands
```bash
# Start
launchctl start com.dexciss.whatsapp

# Stop
launchctl stop com.dexciss.whatsapp

# Unload (disable auto-start)
launchctl unload ~/Library/LaunchAgents/com.dexciss.whatsapp.plist

# Reload after changes
launchctl unload ~/Library/LaunchAgents/com.dexciss.whatsapp.plist
launchctl load ~/Library/LaunchAgents/com.dexciss.whatsapp.plist
```

---

## Recommended Setup by Environment

| Environment | Recommended Option | Why |
|-------------|-------------------|-----|
| **Development** | Option 2 (Bench Procfile) | Integrated with `bench start` |
| **Production** | Option 1 (PM2) | Best monitoring, auto-restart, logs |
| **macOS Server** | Option 3 (Launchd) | Native macOS service, runs on boot |

---

## Quick Start (Right Now)

**Just want it running?** Use this:

```bash
cd ~/dexciss-live/apps/whatsapp_integration/whatsapp_node_service
./start.sh
```

Service will run in background and create logs at `whatsapp-service.log`.

---

## Troubleshooting

### Service Won't Start
```bash
# Check if port 3000 is already in use
lsof -i :3000

# Kill existing process
pkill -f "node index.js"

# Try starting again
./start.sh
```

### Check Logs
```bash
cd ~/dexciss-live/apps/whatsapp_integration/whatsapp_node_service
tail -f whatsapp-service.log
```

### Check if Running
```bash
./status.sh
# OR
curl http://127.0.0.1:3000/health
```

---

## My Recommendation for You

**For Development (Current Setup):**
```bash
# Option 2 - Add to Procfile
cd ~/dexciss-live
echo "whatsapp: cd apps/whatsapp_integration/whatsapp_node_service && node index.js" >> Procfile
bench start
```

**For Production:**
```bash
# Option 1 - Use PM2
npm install -g pm2
cd ~/dexciss-live/apps/whatsapp_integration/whatsapp_node_service
pm2 start index.js --name whatsapp-service
pm2 save
pm2 startup
```

Choose based on your needs!
