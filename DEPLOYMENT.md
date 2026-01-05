# WhatsApp Integration - Deployment Guide

## Quick Deployment Steps

### 1. Update Code
```bash
cd ~/frappe-bench/apps/whatsapp_integration
git pull origin main
```

### 2. Install/Update Node Dependencies
```bash
cd whatsapp_node_service
npm install
```

### 3. Run Database Migrations
```bash
cd ~/frappe-bench
bench --site your-site.local migrate
```

### 4. Clear Cache
```bash
bench --site your-site.local clear-cache
bench build --app whatsapp_integration
```

### 5. Restart Services
```bash
# Restart Frappe
bench restart

# Restart Node.js service (if using PM2)
pm2 restart whatsapp-service

# OR restart systemd service
sudo systemctl restart whatsapp-bridge
```

### 6. Verify Deployment
```bash
# Check Node.js service health
curl http://127.0.0.1:3000/health

# Check Frappe site
bench --site your-site.local console
```

In the console:
```python
import frappe
frappe.get_all("WhatsApp Message", limit=1)
```

## Configuration Checklist

### WhatsApp Settings
1. Log into ERPNext
2. Go to **WhatsApp Settings**
3. Verify/update:
   - ✅ Company is set
   - ✅ Integration is enabled
   - ✅ Node URL is correct (`http://127.0.0.1:3000`)
   - ✅ Webhook token is generated
4. Click **Connect** to get QR code
5. Scan QR code with WhatsApp mobile app

### Test the Integration
1. Go to WhatsApp Settings
2. Scroll to **Test Messaging** section
3. Enter your phone number (with country code)
4. Enter a test message
5. Click **Send Test Message**
6. Verify message received on WhatsApp

## Troubleshooting

### Issue: QR Code Not Appearing
**Solution**:
```bash
# Check if Node service is running
curl http://127.0.0.1:3000/health

# Check Node service logs
pm2 logs whatsapp-service
# OR
sudo journalctl -u whatsapp-bridge -f
```

### Issue: Messages Not Sending
**Solution**:
1. Check connection status in WhatsApp Settings
2. Verify phone number format (no spaces, include country code)
3. Check Error Log in ERPNext (Search → Error Log)
4. Verify Node service is connected:
   ```bash
   curl http://127.0.0.1:3000/health
   ```

### Issue: Performance is Slow
**Solution**:
```bash
# Run the index patch manually
bench --site your-site.local console

# In console:
import frappe
frappe.db.sql("SHOW INDEX FROM `tabWhatsApp Message`")
```

If indexes are missing, run:
```bash
bench --site your-site.local migrate --skip-search-index
```

## Production Optimization

### 1. Enable Background Workers
```bash
# In site_config.json, add:
{
    "background_workers": 1,
    "gunicorn_workers": 4
}
```

### 2. Configure Redis
Ensure Redis is running for background jobs:
```bash
redis-cli ping
# Should return: PONG
```

### 3. Monitor Performance
```bash
# Check Node.js service stats
curl http://127.0.0.1:3000/health | jq

# Check Frappe queue
bench doctor

# Monitor error logs
tail -f ~/frappe-bench/logs/your-site.local/error.log
```

### 4. Set Up Monitoring (Optional)
Consider using:
- **PM2 Plus** for Node.js monitoring
- **New Relic** or **DataDog** for APM
- **Sentry** for error tracking

## Security Checklist

Before going live:

- [ ] HTTPS enabled on Frappe site
- [ ] Firewall rules: Block external access to port 3000
- [ ] Strong webhook tokens (auto-generated)
- [ ] Rate limiting enabled (default: yes)
- [ ] Error logs reviewed for security issues
- [ ] User permissions configured correctly
- [ ] No hardcoded credentials in code

## Backup & Recovery

### Backup WhatsApp Sessions
```bash
# Sessions are stored in:
cd ~/frappe-bench/apps/whatsapp_integration/whatsapp_node_service/sessions

# Backup
tar -czf whatsapp-sessions-$(date +%Y%m%d).tar.gz sessions/

# Restore (if needed)
tar -xzf whatsapp-sessions-YYYYMMDD.tar.gz
pm2 restart whatsapp-service
```

### Backup Database
```bash
bench --site your-site.local backup --with-files
```

## Rollback Procedure

If something goes wrong:

```bash
# 1. Stop services
pm2 stop whatsapp-service
bench restart

# 2. Restore previous code
cd ~/frappe-bench/apps/whatsapp_integration
git log --oneline  # Find previous commit
git checkout <previous-commit-hash>

# 3. Restore database from backup
bench --site your-site.local restore backup-file.sql.gz

# 4. Restart services
pm2 start whatsapp-service
bench restart
```

## Post-Deployment Validation

Run these tests after deployment:

```bash
# 1. Test API endpoint
curl -X POST http://your-site.local/api/method/whatsapp_integration.whatsapp_integration.api.get_system_status \
  -H "Content-Type: application/json" \
  -d '{"company": "Your Company"}'

# 2. Test Node service
curl http://127.0.0.1:3000/health

# 3. Test webhook
# (Send a WhatsApp message to the connected number and check if it appears in ERPNext)
```

## Support

If you encounter issues:

1. **Check logs**: `~/frappe-bench/logs/your-site.local/error.log`
2. **Check Error Log doctype**: In ERPNext, search for "Error Log"
3. **GitHub Issues**: Open an issue with logs and error details
4. **Community**: Post in Frappe Forum with tag `whatsapp-integration`

---

**Deployment completed successfully!** 🚀

Your WhatsApp Integration is now live and ready to use.
