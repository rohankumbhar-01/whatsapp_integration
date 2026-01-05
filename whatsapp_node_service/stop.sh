#!/bin/bash

# WhatsApp Node Service - Stop Script

SERVICE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SERVICE_DIR"

echo "Stopping WhatsApp Bridge Service..."

# Stop using PID file if exists
if [ -f "whatsapp-service.pid" ]; then
    PID=$(cat whatsapp-service.pid)
    if ps -p $PID > /dev/null 2>&1; then
        echo "Stopping process $PID..."
        kill $PID
        sleep 2

        # Force kill if still running
        if ps -p $PID > /dev/null 2>&1; then
            echo "Force stopping..."
            kill -9 $PID
        fi
    fi
    rm whatsapp-service.pid
fi

# Kill any remaining processes
pkill -f "node index.js" 2>/dev/null || true

echo "WhatsApp Bridge Service stopped!"
