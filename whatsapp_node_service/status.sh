#!/bin/bash

# WhatsApp Node Service - Status Check Script

SERVICE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SERVICE_DIR"

echo "========================================="
echo "WhatsApp Bridge Service Status"
echo "========================================="
echo ""

# Check if process is running
if [ -f "whatsapp-service.pid" ]; then
    PID=$(cat whatsapp-service.pid)
    if ps -p $PID > /dev/null 2>&1; then
        echo "Status: RUNNING ✓"
        echo "PID: $PID"

        # Get process info
        ps -p $PID -o pid,vsz,rss,etime,command

        # Check service health via HTTP
        echo ""
        echo "Service Health:"
        if command -v curl &> /dev/null; then
            curl -s http://127.0.0.1:3000/health | python3 -m json.tool 2>/dev/null || echo "Service responding but invalid JSON"
        else
            echo "curl not available - install to check health endpoint"
        fi
    else
        echo "Status: STOPPED ✗"
        echo "PID file exists but process not running"
    fi
else
    # Check if any node index.js is running
    RUNNING_PID=$(pgrep -f "node index.js" | head -1)
    if [ -n "$RUNNING_PID" ]; then
        echo "Status: RUNNING (no PID file) ⚠"
        echo "PID: $RUNNING_PID"
        echo "Warning: Service running but no PID file found"
    else
        echo "Status: STOPPED ✗"
    fi
fi

echo ""
echo "========================================="
echo ""

# Show recent logs if available
if [ -f "whatsapp-service.log" ]; then
    echo "Recent Logs (last 10 lines):"
    echo "-----------------------------------------"
    tail -10 whatsapp-service.log
fi
