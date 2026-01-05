#!/bin/bash

# WhatsApp Node Service - Auto-Start Script
# This script starts the WhatsApp bridge service and keeps it running

SERVICE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SERVICE_DIR"

echo "Starting WhatsApp Bridge Service..."
echo "Service Directory: $SERVICE_DIR"

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed"
    exit 1
fi

# Check if dependencies are installed
if [ ! -d "node_modules" ]; then
    echo "Installing Node.js dependencies..."
    npm install
fi

# Kill existing process if running
pkill -f "node index.js" 2>/dev/null || true
sleep 1

# Start the service in background
echo "Starting Node.js service on port 3000..."
nohup node index.js > whatsapp-service.log 2>&1 &

# Save PID
echo $! > whatsapp-service.pid

echo "WhatsApp Bridge Service started!"
echo "PID: $(cat whatsapp-service.pid)"
echo "Logs: $SERVICE_DIR/whatsapp-service.log"
echo ""
echo "To view logs: tail -f $SERVICE_DIR/whatsapp-service.log"
echo "To stop: kill \$(cat $SERVICE_DIR/whatsapp-service.pid)"
