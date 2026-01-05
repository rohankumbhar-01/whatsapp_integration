import frappe
import requests
from frappe.model.document import Document
from frappe import _

class WhatsAppSettings(Document):
    def validate(self):
        if not self.webhook_token:
            self.webhook_token = frappe.generate_hash(length=32)

@frappe.whitelist()
def get_qr_code(name):
    doc = frappe.get_doc("WhatsApp Settings", name)
    if not doc.integration_enabled:
        return {"error": "Integration is disabled"}

    node_url = doc.node_url or "http://127.0.0.1:3000"
    session_id = doc.name.replace(" ", "_") # Use DocName as session ID

    try:
        # Use full path for callback
        callback_method = "whatsapp_integration.whatsapp_integration.api.handle_callback"
        webhook_url = frappe.utils.get_url(f"/api/method/{callback_method}")
        
        response = requests.post(f"{node_url}/sessions/start", json={
            "sessionId": session_id,
            "webhookUrl": webhook_url,
            "webhookToken": doc.get_password("webhook_token")
        }, timeout=30)

        # Check if response is valid JSON
        try:
            res_data = response.json()
        except ValueError:
            frappe.log_error(
                title="WhatsApp QR Code Error",
                message=f"Node service returned invalid JSON. Status: {response.status_code}, Body: {response.text[:200]}"
            )
            return {"error": f"Invalid response from Node service (status {response.status_code})"}

        if res_data.get("status") == "Connected":
            doc.db_set("connection_status", "Connected")
            doc.db_set("last_connected", frappe.utils.now())
            frappe.db.commit()

        return res_data
    except Exception as e:
        frappe.log_error(title="WhatsApp Connection Error", message=frappe.get_traceback())
        return {"error": f"Could not connect to Node.js service at {node_url}. Error: {str(e)}"}

@frappe.whitelist()
def send_whatsapp_message(name, receiver, message, media=None):
    """
    Send a WhatsApp message via Node.js service.
    Handles auto-reconnection if session is disconnected.
    """
    try:
        doc = frappe.get_doc("WhatsApp Settings", name)
        node_url = doc.node_url or "http://127.0.0.1:3000"
        session_id = doc.name.replace(" ", "_")

        # Validate receiver number
        from whatsapp_integration.whatsapp_integration.api import validate_phone_number, sanitize_message
        clean_receiver = validate_phone_number(receiver)
        if not clean_receiver:
            return {"status": "error", "error": "Invalid phone number"}

        # Sanitize message
        if message:
            message = sanitize_message(message)

        payload = {
            "sessionId": session_id,
            "receiver": clean_receiver,
            "message": message or ""
        }
        if media:
            payload["media"] = media

        # Try to send message
        response = requests.post(
            f"{node_url}/sessions/send",
            json=payload,
            timeout=60
        )

        # Check if response is valid JSON
        try:
            res_data = response.json()
        except ValueError:
            # Response is not valid JSON
            frappe.log_error(
                title="WhatsApp Invalid Response",
                message=f"Node service returned invalid JSON. Status: {response.status_code}, Body: {response.text[:200]}"
            )
            return {
                "status": "error",
                "error": f"Invalid response from Node service (status {response.status_code})"
            }

        # If session is not connected, try to reconnect
        if response.status_code == 400 and res_data.get("error") == "Session not connected":
            frappe.logger().warning(f"Session {session_id} not connected, attempting to reconnect...")

            # Enqueue reconnection in background
            frappe.enqueue(
                method='whatsapp_integration.whatsapp_integration.doctype.whatsapp_settings.whatsapp_settings.get_qr_code',
                queue='short',
                timeout=300,
                is_async=True,
                name=name
            )

            return {
                "status": "error",
                "error": "WhatsApp session disconnected. Reconnecting in background. Please try again in a moment."
            }

        return res_data

    except requests.Timeout:
        frappe.log_error(
            title="WhatsApp Send Timeout",
            message=f"Timeout sending message to {receiver}"
        )
        return {"status": "error", "error": "Request timeout - Node service may be slow"}

    except requests.RequestException as e:
        frappe.log_error(
            title="WhatsApp Send Error",
            message=f"Network error: {str(e)}\n{frappe.get_traceback()}"
        )
        return {"status": "error", "error": f"Network error: {str(e)}"}

    except Exception as e:
        frappe.log_error(
            title="WhatsApp Send Error",
            message=frappe.get_traceback()
        )
        return {"status": "error", "error": str(e)}

@frappe.whitelist()
def logout_whatsapp(name):
    doc = frappe.get_doc("WhatsApp Settings", name)
    node_url = doc.node_url or "http://localhost:3000"
    session_id = doc.name.replace(" ", "_")

    try:
        response = requests.delete(f"{node_url}/sessions/{session_id}", timeout=10)
        doc.connection_status = "Disconnected"
        doc.save(ignore_permissions=True)

        # Check if response is valid JSON
        try:
            return response.json()
        except ValueError:
            return {"status": "logged out"}
    except Exception as e:
        # If node is down, just reset status anyway
        doc.connection_status = "Disconnected"
        doc.save(ignore_permissions=True)
        return {"status": "Disconnected", "info": "Node service was unreachable, status reset locally."}
