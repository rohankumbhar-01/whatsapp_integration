# Quick Start Guide - WhatsApp Integration

Get your WhatsApp integration up and running in 10 minutes!

## Prerequisites Checklist

- [ ] Frappe/ERPNext installed and running
- [ ] Node.js v16+ installed (`node --version`)
- [ ] npm installed (`npm --version`)
- [ ] Redis running (`redis-cli ping` should return "PONG")
- [ ] WhatsApp number (not the same as your personal WhatsApp)

## Installation Steps

### 1. Install the App (2 minutes)

```bash
# Navigate to your bench
cd ~/frappe-bench

# Get the app (replace with your actual repo URL)
bench get-app whatsapp_integration

# Install on your site
bench --site your-site.local install-app whatsapp_integration

# Run migrations
bench --site your-site.local migrate
```

### 2. Start Node.js Service (1 minute)

```bash
# Navigate to Node service directory
cd ~/frappe-bench/apps/whatsapp_integration/whatsapp_node_service

# Install dependencies
npm install

# Start with PM2 (recommended)
pm2 start index.js --name whatsapp-service

# OR start manually for testing
node index.js
```

Verify it's running:
```bash
curl http://127.0.0.1:3000/health
# Should return: {"status":"healthy",...}
```

### 3. Configure WhatsApp (5 minutes)

1. Login to your ERPNext site
2. Search for "WhatsApp Settings" in the awesome bar
3. Click "New"
4. Fill in:
   - **Company**: Select your company
   - **Integration Enabled**: ✅ Check
   - **Node Service URL**: `http://127.0.0.1:3000` (leave default)
5. Click "Save"

### 4. Connect to WhatsApp (2 minutes)

1. In the WhatsApp Settings form, you'll see buttons at the top
2. Click **"Get QR Code"** or **"Connect"** button
3. A QR code will appear in a dialog
4. Open WhatsApp on your phone
5. Go to: **Settings** → **Linked Devices** → **Link a Device**
6. Scan the QR code
7. Wait for status to change to "Connected" (usually 5-10 seconds)

### 5. Test It! (1 minute)

1. In WhatsApp Settings, scroll to **"Test Messaging"** section
2. Enter your phone number: `919876543210` (with country code, no spaces)
3. Enter a message: `Hello from ERPNext! 🎉`
4. Click **"Send Test Message"**
5. Check your WhatsApp - you should receive the message!

## 🎉 You're Done!

Your WhatsApp integration is now active. Here's what you can do:

### Send Messages from Chat Widget

1. Click the green WhatsApp icon (bottom-right corner)
2. Search for a contact or enter a phone number
3. Type your message and hit send
4. Messages appear in real-time!

### Auto-Send Invoice Notifications

When you create and save a Sales Invoice:
1. Customer must have a mobile number
2. WhatsApp notification is sent automatically
3. Message includes invoice number, amount, and due date

### Send PDF Documents

1. Open any document (Sales Invoice, Quotation, etc.)
2. Click **Print** button
3. In print view, click **"Send via WhatsApp"** button
4. Confirm - PDF is sent to customer's WhatsApp

## Common Commands

### Check Node Service Status
```bash
pm2 status whatsapp-service
pm2 logs whatsapp-service
```

### Restart Services
```bash
# Restart Node service
pm2 restart whatsapp-service

# Restart Frappe
bench restart
```

### View Logs
```bash
# Node.js logs
pm2 logs whatsapp-service --lines 50

# Frappe logs
tail -f ~/frappe-bench/sites/your-site.local/logs/web.log
```

### Rebuild After Changes
```bash
bench build --app whatsapp_integration
bench clear-cache
```

## Troubleshooting Quick Fixes

### QR Code Doesn't Appear
```bash
# 1. Check if Node service is running
curl http://127.0.0.1:3000/health

# 2. If not, start it
cd ~/frappe-bench/apps/whatsapp_integration/whatsapp_node_service
pm2 start index.js --name whatsapp-service

# 3. Check firewall (if applicable)
sudo ufw allow 3000
```

### Message Not Sending
1. ✅ Check connection status is "Connected"
2. ✅ Verify phone number has country code (e.g., `919876543210`)
3. ✅ Check Error Log in ERPNext for details
4. ✅ Test with your own number first

### Connection Lost
1. Simply scan QR code again
2. Old session data is automatically reused if available
3. No need to delete anything

### "Session not connected" Error
```bash
# Reconnect automatically
# Just send a message - it will trigger auto-reconnection
# Or manually click "Get QR Code" button again
```

## Production Deployment

### Using systemd (Linux)

1. Create service file:
```bash
sudo nano /etc/systemd/system/whatsapp-bridge.service
```

2. Add content:
```ini
[Unit]
Description=WhatsApp Bridge
After=network.target

[Service]
Type=simple
User=frappe
WorkingDirectory=/home/frappe/frappe-bench/apps/whatsapp_integration/whatsapp_node_service
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

3. Enable and start:
```bash
sudo systemctl enable whatsapp-bridge
sudo systemctl start whatsapp-bridge
sudo systemctl status whatsapp-bridge
```

### Using PM2 (Recommended)

```bash
# Start
pm2 start index.js --name whatsapp-service

# Auto-start on reboot
pm2 startup
pm2 save

# Monitor
pm2 monit
```

## Security Checklist

For production deployments:

- [ ] Change default Node.js port if needed
- [ ] Use HTTPS for Frappe site
- [ ] Restrict Node.js port with firewall: `sudo ufw allow from 127.0.0.1 to any port 3000`
- [ ] Use strong webhook tokens (auto-generated)
- [ ] Regular backups of session data
- [ ] Monitor logs for suspicious activity
- [ ] Keep dependencies updated

## Performance Tips

### For High Volume (1000+ messages/day)

1. **Increase Node.js memory**:
   ```bash
   pm2 start index.js --name whatsapp-service --max-memory-restart 500M
   ```

2. **Configure Redis properly**:
   ```bash
   # In site_config.json
   {
       "background_workers": 4,
       "gunicorn_workers": 4
   }
   ```

3. **Use message queuing**:
   ```python
   # Queue messages instead of sending immediately
   frappe.enqueue(
       'whatsapp_integration.whatsapp_integration.api.send_chat_message',
       message=message,
       receiver=receiver,
       company=company
   )
   ```

## Next Steps

1. **Customize Message Templates**: Edit `api.py` to change invoice notification messages
2. **Add More Triggers**: Hook into other doctypes (Delivery Note, Payment Entry, etc.)
3. **Enable for Multiple Companies**: Create separate WhatsApp Settings for each company
4. **Monitor Performance**: Set up monitoring with PM2 or New Relic
5. **Read Full Documentation**: See [README.md](README.md) for advanced features

## Getting Help

- **Error Logs**: ERPNext → Error Log
- **Node Logs**: `pm2 logs whatsapp-service`
- **Health Check**: `curl http://127.0.0.1:3000/health`
- **Community**: Frappe Forum
- **Issues**: GitHub Issues

## Quick Reference

| Task | Command |
|------|---------|
| Start Node Service | `pm2 start index.js --name whatsapp-service` |
| View Logs | `pm2 logs whatsapp-service` |
| Restart Service | `pm2 restart whatsapp-service` |
| Check Health | `curl http://127.0.0.1:3000/health` |
| Rebuild Frontend | `bench build --app whatsapp_integration` |
| Clear Cache | `bench clear-cache` |
| Run Migrations | `bench migrate` |

---

**Need more help?** Check the full [README.md](README.md) or [IMPROVEMENTS.md](IMPROVEMENTS.md) for detailed documentation.

🚀 Happy WhatsApping!
