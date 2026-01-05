# WhatsApp Integration for Frappe/ERPNext

Comprehensive WhatsApp integration for Frappe/ERPNext using the Baileys library. Connect your system directly to WhatsApp to send messages, receive replies, manage conversations, and streamline document sharing.

## 🌟 Key Features

### 💬 Advanced Messaging
- **Real-time Two-Way Chat**: Send and receive messages instantly via a native WhatsApp-style floating widget.
- **Voice Notes (PTT)**: Record and send voice messages directly from the browser with proper WhatsApp Push-To-Talk (PTT) status.
- **Media Support**: Seamlessly send/receive images, videos, audio files, and any document format (PDF, DOCX, XLSX, etc.).
- **Message Status**: Real-time updates for sent and received messages.

### 📞 Calling Features
- **Integrated Calling UI**: Premium calling overlay in the chat widget.
- **WhatsApp Voice/Video Calls**: One-click bridging to WhatsApp native calling functionality.

### 📄 Document & Print Integration
- **Direct PDF Sharing**: Add a "Send via WhatsApp" button directly to the Frappe Print View.
- **Smart Recipient Detection**: Automatically finds customer phone numbers from Linked Contacts or Document fields.
- **Automated Workflow**: Send automated notifications for Sales Invoices, Quotations, or any custom DocType.

### 👤 User Experience
- **Contact Sync**: View profile pictures and WhatsApp "About" status directly in the desk.
- **Searchable Inbox**: Quickly find chats by contact name or phone number.
- **Rich Media Preview**: In-chat previews for images, videos, and audio messages.

---

## 🏗️ Architecture

```
┌─────────────────┐         ┌──────────────────┐         ┌─────────────┐
│  Frappe/ERPNext │ ◄─────► │ Node.js Service  │ ◄─────► │  WhatsApp   │
│   (Python API)  │  HTTP   │   (Baileys.js)   │   WS    │  Web Servers│
└─────────────────┘         └──────────────────┘         └─────────────┘
        │                            │
        ▼                            ▼
  ┌──────────┐              ┌─────────────────┐
  │ Database │              │ Session Storage │
  │ (MariaDB)│              │  (File System)  │
  └──────────┘              └─────────────────┘
```

---

## 🛠️ Installation

### Prerequisites
- **Frappe/ERPNext**: v13, v14, or v15
- **Node.js**: v18.x or higher
- **PDF Engine**: `wkhtmltopdf` (Required for sending print documents as PDF)

### Step 1: Install the Frappe App
```bash
# Get the app
bench get-app https://github.com/rohankumbhar-01/whatsapp_integration

# Install on your site
bench --site your-site.local install-app whatsapp_integration

# Migrate
bench --site your-site.local migrate
```

### Step 2: Set up Node.js Service
```bash
cd apps/whatsapp_integration/whatsapp_node_service
npm install
```

### Step 3: Run the Service
For production, we recommend using PM2:
```bash
npm install -g pm2
pm2 start index.js --name whatsapp-integration
pm2 save
```

---

## ⚙️ Configuration

1. **WhatsApp Settings**: Go to the "WhatsApp Settings" DocType.
2. **Company**: Select the company associated with this account.
3. **Connection**: Click the "Connect" button. A QR Code will appear.
4. **Link Device**: Scan the QR code using your WhatsApp mobile app (Linked Devices).
5. **Auto-heal**: The service is built to automatically reconnect and "heal" sessions if the connection drops.

---

## 🔓 Security & Performance

- **Webhook Tokens**: All communication between the Node service and Frappe is secured via unique, auto-generated tokens.
- **Rate Limiting**: Built-in rate limiting prevents your WhatsApp account from being flagged for spam.
- **Background Jobs**: Heavy tasks like PDF generation are handled via Frappe's background workers to ensure smooth UI performance.
- **Payload Sanitization**: Automatic cleaning of phone numbers and message content.

---

## 💻 Technical APIs

Developers can easily integrate WhatsApp into their own custom workflows:

### Send Message from Python
```python
from whatsapp_integration.whatsapp_integration.api import send_chat_message

send_chat_message(
    message="Your order is ready!",
    receiver="919876543210",
    company="My Company"
)
```

### Send Media from JavaScript
```javascript
frappe.call({
    method: 'whatsapp_integration.whatsapp_integration.api.send_chat_message',
    args: {
        message: 'Check out this report',
        receiver: '919876543210',
        media: {
            data: 'base64_string',
            filename: 'report.pdf',
            mimetype: 'application/pdf'
        }
    }
});
```

---

## 🤝 Contributing
Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License
This project is licensed under the MIT License.

---
Made with ❤️ by [Rohan Kumbhar](https://github.com/rohankumbhar-01)
