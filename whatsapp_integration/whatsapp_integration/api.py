import frappe
import json
import requests
import re
from typing import Optional, Dict, Any, List
from frappe import _
from frappe.rate_limiter import rate_limit
from whatsapp_integration.whatsapp_integration.doctype.whatsapp_settings.whatsapp_settings import send_whatsapp_message

# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

def validate_phone_number(phone: str) -> Optional[str]:
    """
    Validate and clean phone number.
    Returns cleaned number or None if invalid.
    """
    if not phone:
        return None

    # Remove all non-digit characters
    cleaned = re.sub(r'[^\d+]', '', phone)
    cleaned = cleaned.lstrip('+')

    # Must be between 10-15 digits
    if len(cleaned) < 10 or len(cleaned) > 15:
        return None

    return cleaned

def get_customer_mobile(doc) -> Optional[str]:
    """
    Get customer mobile number from various sources.
    Tries: doc fields -> linked contact -> customer record
    """
    # Try direct fields on document
    for field in ['contact_mobile', 'mobile_no', 'phone', 'customer_mobile']:
        if hasattr(doc, field):
            mobile = getattr(doc, field)
            if mobile:
                return mobile

    # Try linked contact
    if hasattr(doc, 'customer') and doc.customer:
        # Get primary contact for customer
        contact = frappe.db.sql("""
            SELECT c.mobile_no, c.phone
            FROM `tabContact` c
            JOIN `tabDynamic Link` dl ON c.name = dl.parent
            WHERE dl.link_doctype = 'Customer'
            AND dl.link_name = %s
            AND (c.mobile_no IS NOT NULL OR c.phone IS NOT NULL)
            ORDER BY c.is_primary_contact DESC
            LIMIT 1
        """, (doc.customer,), as_dict=1)

        if contact:
            return contact[0].mobile_no or contact[0].phone

        # Fallback to customer mobile
        customer_mobile = frappe.db.get_value("Customer", doc.customer, "mobile_no")
        if customer_mobile:
            return customer_mobile

    return None

def sanitize_message(message: str) -> str:
    """Sanitize message content to prevent injection attacks."""
    if not message:
        return ""
    # Remove null bytes and control characters except newlines and tabs
    message = re.sub(r'[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f-\x9f]', '', message)
    return message.strip()

def get_default_company() -> Optional[str]:
    """Get default company for current user."""
    company = frappe.defaults.get_user_default('company')
    if not company:
        company = frappe.db.get_single_value('Global Defaults', 'default_company')
    if not company:
        company = frappe.db.get_value('Company', {}, 'name')
    return company

# ============================================================================
# INVOICE NOTIFICATION
# ============================================================================

def send_invoice_notification(doc, method):
    """
    Called when a Sales Invoice is submitted.
    Sends WhatsApp notification to customer with invoice details.
    """
    try:
        # Find the WhatsApp Settings for this company
        settings_name = frappe.db.get_value(
            "WhatsApp Settings",
            {"company": doc.company, "integration_enabled": 1},
            "name"
        )

        if not settings_name:
            frappe.log_error(
                f"WhatsApp Settings not found or disabled for company {doc.company}",
                "WhatsApp Notification Skip"
            )
            return

        # Get customer mobile number - try multiple sources
        receiver_number = get_customer_mobile(doc)

        if not receiver_number:
            frappe.log_error(
                f"Mobile number not found for customer {doc.customer} in Invoice {doc.name}",
                "WhatsApp Notification Error"
            )
            return

        # Validate and clean phone number
        receiver_number = validate_phone_number(receiver_number)
        if not receiver_number:
            frappe.log_error(
                f"Invalid phone number for customer {doc.customer} in Invoice {doc.name}",
                "WhatsApp Notification Error"
            )
            return
    except Exception as e:
        frappe.log_error(
            f"Error preparing invoice notification: {str(e)}\n{frappe.get_traceback()}",
            "WhatsApp Notification Error"
        )
        return

    # Build message with sanitization
    message = sanitize_message(
        f"Hello {doc.customer_name},\n\n"
        f"Your invoice *{doc.name}* has been generated.\n"
        f"Amount: *{frappe.utils.fmt_money(doc.grand_total, currency=doc.currency)}*\n"
        f"Due Date: {frappe.format(doc.due_date, {'fieldtype': 'Date'})}\n\n"
        f"Thank you for your business!"
    )

    try:
        response = send_whatsapp_message(settings_name, receiver_number, message)

        # Log Communication
        log_communication(
            company=doc.company,
            receiver=receiver_number,
            message_type="Invoice Notification",
            status="Success" if response.get("status") == "sent" else "Error",
            error_message=response.get("error") if response.get("status") != "sent" else None
        )

        if response.get("status") == "sent":
            frappe.msgprint(_(f"WhatsApp notification sent to {receiver_number}"))
            # Save as Message for chat history
            msg_id = response.get("result", {}).get("key", {}).get("id")
            save_whatsapp_msg(receiver_number, message, "Outgoing", doc.company, msg_id)
        else:
            frappe.log_error(
                f"Failed to send WhatsApp notification: {response.get('error')}",
                "WhatsApp Notification Error"
            )
    except Exception as e:
        frappe.log_error(
            f"WhatsApp Notification Error: {str(e)}\n{frappe.get_traceback()}",
            "WhatsApp Notification Error"
        )

def log_communication(company: str, receiver: str, message_type: str, status: str, error_message: Optional[str] = None):
    """Create a communication log entry."""
    try:
        log = frappe.new_doc("WhatsApp Communication Log")
        log.company = company
        log.receiver = receiver
        log.message_type = message_type
        log.status = status
        if error_message:
            log.error_message = str(error_message)[:500]  # Limit error message length
        log.insert(ignore_permissions=True)
        frappe.db.commit()
    except Exception as e:
        frappe.log_error(
            f"Error logging communication: {str(e)}\n{frappe.get_traceback()}",
            "WhatsApp Communication Log Error"
        )

# ============================================================================
# WEBHOOK HANDLER
# ============================================================================

@frappe.whitelist(allow_guest=True)
def handle_callback():
    """
    Webhook endpoint for Node.js service to notify Frappe about WhatsApp events.
    Handles connection updates and incoming messages.
    """
    # Bypass CSRF for this specific webhook
    if frappe.request.method == "POST":
        frappe.local.flags.ignore_csrf = True

    try:
        # Parse request data
        try:
            data = json.loads(frappe.request.data) if frappe.request.data else {}
        except json.JSONDecodeError:
            data = frappe.form_dict

        # Validate required fields
        token = frappe.request.headers.get("X-Webhook-Token")
        session_id = data.get("sessionId")

        if not session_id:
            frappe.log_error("No sessionId in webhook callback", "WhatsApp Webhook Error")
            return {"status": "error", "message": "No sessionId provided"}

        if not token:
            frappe.log_error(f"No token in webhook callback for session {session_id}", "WhatsApp Webhook Error")
            return {"status": "error", "message": "No authentication token"}

        # Convert session_id back to doc name
        doc_name = session_id.replace("_", " ")

        # Verify settings exist
        if not frappe.db.exists("WhatsApp Settings", doc_name):
            frappe.log_error(f"Settings not found for {doc_name}", "WhatsApp Webhook Error")
            return {"status": "error", "message": f"Settings for {doc_name} not found"}

        # Validate webhook token
        doc = frappe.get_doc("WhatsApp Settings", doc_name)
        stored_token = doc.get_password("webhook_token")

        if not stored_token or stored_token != token:
            frappe.log_error(
                f"Webhook Token Mismatch for {doc_name}. Expected: {stored_token[:8]}..., Received: {token[:8] if token else 'None'}...",
                "WhatsApp Security Alert"
            )
            return {"status": "error", "message": "Unauthorized"}

        # Process event
        event = data.get("event")
        if not event:
            return {"status": "error", "message": "No event type specified"}

        frappe.logger().info(f"WhatsApp Webhook: {event} for {doc_name}")

        if event == "connection.update":
            handle_connection_update(doc_name, doc, data)
        elif event == "messages.upsert":
            handle_messages_upsert(doc, data)
        else:
            frappe.logger().warning(f"Unknown webhook event: {event}")

        return {"status": "success"}

    except Exception as e:
        frappe.log_error(
            f"Webhook Error: {str(e)}\n{frappe.get_traceback()}",
            "WhatsApp Webhook Error"
        )
        return {"status": "error", "message": "Internal server error"}

def handle_connection_update(doc_name: str, doc, data: Dict[str, Any]):
    """Handle connection status update from Node.js service."""
    status = data.get("status")
    if not status:
        return

    try:
        # Update connection status
        update_data = {"connection_status": status}
        if status == "Connected":
            update_data["last_connected"] = frappe.utils.now()

        frappe.db.set_value("WhatsApp Settings", doc_name, update_data)
        frappe.db.commit()

        # Publish real-time event for UI update
        frappe.publish_realtime("whatsapp_connection_update", {
            "status": status,
            "doc_name": doc_name
        })

        frappe.logger().info(f"Connection status updated for {doc_name}: {status}")
    except Exception as e:
        frappe.log_error(
            f"Error updating connection status: {str(e)}\n{frappe.get_traceback()}",
            "WhatsApp Connection Update Error"
        )

def handle_messages_upsert(doc, data: Dict[str, Any]):
    """Handle incoming messages from Node.js service."""
    messages = data.get("messages", [])
    if not messages:
        return

    for msg in messages:
        try:
            wm = handle_incoming_message(doc, msg)

            # Notify UI in real-time
            if wm:
                frappe.publish_realtime("whatsapp_incoming_message", {
                    "from": msg.get("from"),
                    "text": msg.get("text", ""),
                    "sender_name": msg.get("pushName"),
                    "media": wm.media_attachment if wm.media_attachment else None
                })
        except Exception as e:
            frappe.log_error(
                f"Error handling incoming message: {str(e)}\n{frappe.get_traceback()}",
                "WhatsApp Incoming Message Error"
            )

# ============================================================================
# API ENDPOINTS - SYSTEM STATUS & CHAT
# ============================================================================

@frappe.whitelist()
def get_system_status(company: Optional[str] = None) -> Dict[str, Any]:
    """
    Get WhatsApp connection status for a company.
    Returns status from database and optionally syncs with Node.js service.
    """
    try:
        if not company:
            company = get_default_company()

        if not company:
            return {"status": "Disconnected", "error": "No company found"}

        # Check if integration is enabled
        doc_name = frappe.db.get_value(
            "WhatsApp Settings",
            {"company": company, "integration_enabled": 1},
            "name"
        )

        if not doc_name:
            return {"status": "Disabled", "message": "WhatsApp integration is not enabled"}

        # Get current status from database
        doc = frappe.get_doc("WhatsApp Settings", doc_name)
        status = doc.connection_status or "Disconnected"

        # Try to sync with Node.js service (non-blocking)
        node_url = doc.node_url or "http://127.0.0.1:3000"
        session_id = doc_name.replace(" ", "_")

        try:
            res = requests.get(
                f"{node_url}/sessions/{session_id}/status",
                timeout=3
            )
            if res.status_code == 200:
                try:
                    node_status = res.json().get("status")
                    if node_status and node_status != status:
                        # Update status if different
                        frappe.db.set_value("WhatsApp Settings", doc_name, "connection_status", node_status)
                        frappe.db.commit()
                        status = node_status
                except ValueError:
                    # Invalid JSON response, use DB status
                    frappe.logger().debug("Node service returned invalid JSON")
        except requests.RequestException as e:
            # Node service might be down, use DB status
            frappe.logger().debug(f"Could not reach Node.js service: {str(e)}")

        return {
            "status": status,
            "company": company,
            "last_connected": doc.last_connected
        }

    except Exception as e:
        frappe.log_error(
            f"Error getting system status: {str(e)}\n{frappe.get_traceback()}",
            "WhatsApp Status Error"
        )
        return {"status": "Error", "error": str(e)}

@frappe.whitelist()
@rate_limit(limit=30, seconds=60)
def get_recent_chats(limit: int = 50) -> List[Dict[str, Any]]:
    """
    Get recent unique chat conversations.
    Returns list of contacts with their last message.
    """
    try:
        limit = min(int(limit), 100)  # Cap at 100

        # Optimized query to get unique contacts with their last message
        messages = frappe.db.sql("""
            WITH RankedMessages AS (
                SELECT
                    sender,
                    sender_name,
                    message as last_msg,
                    creation as time,
                    receiver,
                    message_type,
                    ROW_NUMBER() OVER (
                        PARTITION BY CASE
                            WHEN sender = 'Me' THEN receiver
                            ELSE sender
                        END
                        ORDER BY creation DESC
                    ) as rn
                FROM `tabWhatsApp Message`
                WHERE sender IS NOT NULL
                AND receiver IS NOT NULL
            )
            SELECT
                sender,
                sender_name,
                last_msg,
                time,
                receiver,
                message_type
            FROM RankedMessages
            WHERE rn = 1
            ORDER BY time DESC
            LIMIT %(limit)s
        """, {"limit": limit}, as_dict=1)

        unique_chats = []
        for m in messages:
            # Determine the other party's phone number
            phone = m.receiver if m.sender == "Me" else m.sender
            if not phone or phone == "Me":
                continue

            # Clean phone number
            clean_phone = phone.split('@')[0].replace('+', '')

            # Get display name
            display_name = m.sender_name if m.sender != "Me" else None
            if not display_name:
                # Try to find contact by phone
                contact = frappe.db.get_value(
                    "Contact",
                    {"mobile_no": ["like", f"%{clean_phone}%"]},
                    ["full_name", "name"],
                    as_dict=1
                )
                display_name = contact.full_name if contact else clean_phone

            unique_chats.append({
                "phone": clean_phone,
                "sender_full_name": display_name,
                "last_msg": m.last_msg[:100] if m.last_msg else "",  # Truncate long messages
                "time": m.time,
                "message_type": m.message_type
            })

        return unique_chats

    except Exception as e:
        frappe.log_error(
            f"Error fetching recent chats: {str(e)}\n{frappe.get_traceback()}",
            "WhatsApp Recent Chats Error"
        )
        return []

@frappe.whitelist()
@rate_limit(limit=60, seconds=60)
def search_contacts(query: str, limit: int = 20) -> List[Dict[str, Any]]:
    """
    Search for contacts and customers by name or phone number.
    """
    if not query or len(query) < 2:
        return []

    try:
        # Sanitize query
        query = sanitize_message(query)
        limit = min(int(limit), 50)  # Cap at 50
        search_pattern = f"%{query}%"

        # Search in Contacts
        contacts = frappe.db.sql("""
            SELECT
                name as contact_id,
                full_name as name,
                mobile_no as phone,
                'Contact' as type,
                email_id
            FROM `tabContact`
            WHERE (full_name LIKE %(query)s OR mobile_no LIKE %(query)s)
            AND mobile_no IS NOT NULL AND mobile_no != ''
            LIMIT %(limit)s
        """, {"query": search_pattern, "limit": limit // 2}, as_dict=1)

        # Search in Customers
        customers = frappe.db.sql("""
            SELECT
                name as contact_id,
                customer_name as name,
                mobile_no as phone,
                'Customer' as type,
                NULL as email_id
            FROM `tabCustomer`
            WHERE (customer_name LIKE %(query)s OR mobile_no LIKE %(query)s)
            AND mobile_no IS NOT NULL AND mobile_no != ''
            LIMIT %(limit)s
        """, {"query": search_pattern, "limit": limit // 2}, as_dict=1)

        # Combine and deduplicate by phone
        all_results = contacts + customers
        seen_phones = set()
        unique_results = []

        for result in all_results:
            clean_phone = validate_phone_number(result.get("phone", ""))
            if clean_phone and clean_phone not in seen_phones:
                result["phone"] = clean_phone
                unique_results.append(result)
                seen_phones.add(clean_phone)

        return unique_results[:limit]

    except Exception as e:
        frappe.log_error(
            f"Error searching contacts: {str(e)}\n{frappe.get_traceback()}",
            "WhatsApp Contact Search Error"
        )
        return []

@frappe.whitelist()
@rate_limit(limit=60, seconds=60)
def get_chat_history(sender_phone: str, limit: int = 100, offset: int = 0) -> List[Dict[str, Any]]:
    """
    Get chat history with a specific contact.
    Supports pagination via limit and offset.
    """
    try:
        if not sender_phone:
            return []

        # Validate and clean phone number
        search_term = sender_phone.split("@")[0] if "@" in sender_phone else sender_phone
        search_term = validate_phone_number(search_term)

        if not search_term:
            return []

        # Cap limits
        limit = min(int(limit), 500)
        offset = max(int(offset), 0)

        # Optimized query with proper indexing hints
        messages = frappe.db.sql("""
            SELECT
                sender,
                sender_name,
                receiver,
                message,
                creation,
                message_type,
                media_attachment,
                message_id
            FROM `tabWhatsApp Message`
            WHERE (sender LIKE %(search)s OR receiver LIKE %(search)s)
            ORDER BY creation ASC
            LIMIT %(limit)s OFFSET %(offset)s
        """, {
            "search": f"%{search_term}%",
            "limit": limit,
            "offset": offset
        }, as_dict=1)

        return messages

    except Exception as e:
        frappe.log_error(
            f"Error fetching chat history: {str(e)}\n{frappe.get_traceback()}",
            "WhatsApp Chat History Error"
        )
        return []

@frappe.whitelist()
@rate_limit(limit=60, seconds=60)
def send_chat_message(message: str, receiver: str, company: Optional[str] = None, media: Optional[Dict] = None) -> Dict[str, Any]:
    """
    Send a WhatsApp message to a contact.
    Supports text messages and media attachments.
    """
    try:
        # Handle media parameter - it might come as JSON string from frontend
        if media and isinstance(media, str):
            import json
            try:
                media = json.loads(media)
            except (json.JSONDecodeError, ValueError):
                frappe.log_error(f"Invalid media JSON: {media[:100]}", "WhatsApp Media Parse Error")
                return {"status": "error", "error": "Invalid media format"}

        # Validate inputs
        if not message or not receiver:
            return {"status": "error", "error": "Message and receiver are required"}

        # Sanitize message
        message = sanitize_message(message)
        if not message:
            return {"status": "error", "error": "Invalid message content"}

        # Validate phone number
        receiver = validate_phone_number(receiver)
        if not receiver:
            return {"status": "error", "error": "Invalid phone number"}

        # Get company
        if not company:
            company = get_default_company()

        if not company:
            return {"status": "error", "error": "No company found"}

        # Get WhatsApp settings
        settings_name = frappe.db.get_value(
            "WhatsApp Settings",
            {"company": company, "integration_enabled": 1},
            "name"
        )

        if not settings_name:
            return {
                "status": "error",
                "error": f"WhatsApp Integration not enabled for company: {company}"
            }

        # Send message
        response = send_whatsapp_message(settings_name, receiver, message, media=media)

        # Log communication
        log_communication(
            company=company,
            receiver=receiver,
            message_type="Chat",
            status="Success" if response.get("status") == "sent" else "Error",
            error_message=response.get("error") if response.get("status") != "sent" else None
        )

        # Save message in chat history
        if response.get("status") == "sent":
            msg_id = response.get("result", {}).get("key", {}).get("id")
            save_whatsapp_msg(receiver, message, "Outgoing", company, msg_id, media=media)

        frappe.db.commit()
        return response

    except Exception as e:
        frappe.log_error(
            f"Error sending chat message: {str(e)}\n{frappe.get_traceback()}",
            "WhatsApp Send Message Error"
        )
        return {"status": "error", "error": str(e)}

# ============================================================================
# MESSAGE HANDLING
# ============================================================================

def save_whatsapp_msg(
    phone: str,
    text: str,
    msg_type: str,
    company: str,
    msg_id: Optional[str] = None,
    sender_name: Optional[str] = None,
    media: Optional[Dict] = None
):
    """
    Save a WhatsApp message to database.
    Handles deduplication, contact linking, and media attachments.
    """
    try:
        # Check if message already exists (prevent duplicates)
        if msg_id and frappe.db.exists("WhatsApp Message", {"message_id": msg_id}):
            return frappe.get_doc("WhatsApp Message", {"message_id": msg_id})

        # Clean and validate phone number
        real_phone = validate_phone_number(phone.split('@')[0] if '@' in phone else phone)
        if not real_phone:
            frappe.logger().warning(f"Invalid phone number: {phone}")
            return None

        # Resolve contact if we have a sender name
        contact_name = None
        if sender_name and msg_type == "Incoming":
            contact_name = frappe.db.get_value(
                "Contact",
                {"full_name": ["like", f"%{sender_name}%"]},
                "name"
            )
            if not contact_name:
                # Try by phone number
                contact_name = frappe.db.get_value(
                    "Contact",
                    {"mobile_no": ["like", f"%{real_phone}%"]},
                    "name"
                )

        # Create message document
        wm = frappe.new_doc("WhatsApp Message")
        wm.company = company
        wm.message = sanitize_message(text) if text else ""
        wm.message_type = msg_type
        wm.message_id = msg_id

        if msg_type == "Incoming":
            wm.sender = real_phone
            wm.sender_name = sender_name or real_phone
            wm.receiver = "Me"
        else:
            wm.sender = "Me"
            wm.sender_name = frappe.session.user
            wm.receiver = real_phone

        # Link to contact if found
        if contact_name:
            wm.contact = contact_name

        wm.insert(ignore_permissions=True)

        # Handle media attachments
        if media and media.get("data"):
            try:
                from frappe.utils.file_manager import save_file
                import base64

                file_data = base64.b64decode(media.get("data"))
                file_name = media.get("filename") or f"whatsapp_{frappe.generate_hash(length=8)}"

                # Ensure safe filename
                file_name = re.sub(r'[^\w\s.-]', '', file_name)

                saved_file = save_file(
                    file_name,
                    file_data,
                    "WhatsApp Message",
                    wm.name,
                    decode=False,
                    is_private=0
                )
                wm.db_set("media_attachment", saved_file.file_url)
            except Exception as e:
                frappe.log_error(
                    f"Error saving media attachment: {str(e)}\n{frappe.get_traceback()}",
                    "WhatsApp Media Error"
                )

        return wm

    except Exception as e:
        frappe.log_error(
            f"Error saving WhatsApp message: {str(e)}\n{frappe.get_traceback()}",
            "WhatsApp Message Save Error"
        )
        return None

def handle_incoming_message(settings_doc, msg: Dict[str, Any]):
    """
    Process incoming WhatsApp message from webhook.
    Creates message record and handles media attachments.
    """
    try:
        msg_id = msg.get("id")
        sender_phone = msg.get("from")
        content = msg.get("text", "")
        sender_name = msg.get("pushName") or sender_phone
        media = msg.get("media")

        if not sender_phone:
            frappe.logger().warning("Incoming message without sender phone")
            return None

        wm = save_whatsapp_msg(
            phone=sender_phone,
            text=content,
            msg_type="Incoming",
            company=settings_doc.company,
            msg_id=msg_id,
            sender_name=sender_name,
            media=media
        )

        frappe.db.commit()
        return wm

    except Exception as e:
        frappe.log_error(
            f"Error handling incoming message: {str(e)}\n{frappe.get_traceback()}",
            "WhatsApp Incoming Message Error"
        )
        return None

# ============================================================================
# PDF SENDING
# ============================================================================

@frappe.whitelist()
@rate_limit(limit=20, seconds=60)
def send_print_as_pdf(doctype: str, name: str, print_format: Optional[str] = None, letterhead: Optional[str] = None) -> Dict[str, Any]:
    """
    Generate PDF from a document and send it via WhatsApp.
    Automatically resolves recipient phone number from document.
    """
    try:
        import base64

        # Validate permissions
        if not frappe.has_permission(doctype, "read", name):
            frappe.throw(_("You don't have permission to access this document"))

        # Get the document
        doc = frappe.get_doc(doctype, name)

        # Generate PDF content
        try:
            pdf_content = frappe.get_print(
                doctype,
                name,
                print_format=print_format,
                as_pdf=True,
                no_letterhead=(0 if letterhead else 1)
            )
        except Exception as e:
            if "wkhtmltopdf" in str(e).lower():
                frappe.throw(_(
                    "PDF Generation Failed: 'wkhtmltopdf' is missing on the server. "
                    "Please ask the administrator to install it."
                ))
            else:
                frappe.throw(_(f"PDF Generation Failed: {str(e)}"))

        # Resolve receiver phone number
        receiver = get_customer_mobile(doc)

        # Additional fallback fields
        if not receiver:
            for field in ['mobile_no', 'phone', 'custom_mobile_phone', 'contact_phone']:
                if hasattr(doc, field):
                    mobile = getattr(doc, field)
                    if mobile:
                        receiver = mobile
                        break

        if not receiver:
            frappe.throw(_(
                "Could not find a mobile number for this document. "
                "Please add a mobile number to the customer or contact."
            ))

        # Validate phone number
        receiver = validate_phone_number(receiver)
        if not receiver:
            frappe.throw(_("Invalid mobile number found: {0}").format(receiver))

        # Prepare media attachment
        safe_filename = re.sub(r'[^\w\s.-]', '_', name)
        media = {
            "data": base64.b64encode(pdf_content).decode('utf-8'),
            "filename": f"{safe_filename}.pdf",
            "mimetype": "application/pdf"
        }

        # Prepare message
        company = getattr(doc, 'company', None)
        doc_label = _(doctype)
        message = _(f"Hello, please find the attached PDF for {doc_label}: {name}")

        # Send via WhatsApp
        result = send_chat_message(message, receiver, company, media=media)

        if result.get("status") == "sent":
            frappe.msgprint(_("PDF sent successfully via WhatsApp to {0}").format(receiver))

        return result

    except Exception as e:
        frappe.log_error(
            f"Error sending PDF via WhatsApp: {str(e)}\n{frappe.get_traceback()}",
            "WhatsApp PDF Send Error"
        )
        frappe.throw(_("Failed to send PDF: {0}").format(str(e)))
# New media and voice features

# ============================================================================
# MEDIA & FILE HANDLING
# ============================================================================

@frappe.whitelist()
@rate_limit(limit=30, seconds=60)
def upload_media(file_data: str, filename: str, mimetype: str) -> Dict[str, Any]:
    """
    Upload media file for sending via WhatsApp.
    Accepts base64 encoded file data.
    """
    try:
        import base64
        from frappe.utils.file_manager import save_file

        # Decode base64 data
        file_content = base64.b64decode(file_data)

        # Validate file size (max 16MB for WhatsApp)
        max_size = 16 * 1024 * 1024  # 16MB
        if len(file_content) > max_size:
            return {
                "status": "error",
                "error": "File too large. Maximum size is 16MB"
            }

        # Validate MIME type
        allowed_types = [
            'image/', 'video/', 'audio/', 'application/pdf',
            'application/vnd.openxmlformats', 'application/msword',
            'application/vnd.ms-excel', 'text/plain'
        ]

        if not any(mimetype.startswith(t) for t in allowed_types):
            return {
                "status": "error",
                "error": f"File type {mimetype} not supported"
            }

        # Sanitize filename
        safe_filename = re.sub(r'[^\w\s.-]', '_', filename)

        # Save file temporarily
        saved_file = save_file(
            safe_filename,
            file_content,
            "WhatsApp Message",
            None,
            decode=False,
            is_private=0
        )

        return {
            "status": "success",
            "file_url": saved_file.file_url,
            "filename": safe_filename,
            "mimetype": mimetype,
            "size": len(file_content)
        }

    except Exception as e:
        frappe.log_error(
            f"Error uploading media: {str(e)}\n{frappe.get_traceback()}",
            "WhatsApp Media Upload Error"
        )
        return {"status": "error", "error": str(e)}

@frappe.whitelist()
@rate_limit(limit=20, seconds=60)
def send_voice_note(audio_data: str, receiver: str, company: Optional[str] = None) -> Dict[str, Any]:
    """
    Send voice note (audio message) via WhatsApp.
    Audio should be in OGG/Opus or WebM format.
    """
    try:
        import base64

        # Validate receiver
        receiver = validate_phone_number(receiver)
        if not receiver:
            return {"status": "error", "error": "Invalid phone number"}

        # Get company
        if not company:
            company = get_default_company()

        # Decode audio data to validate it
        try:
            audio_bytes = base64.b64decode(audio_data)
        except Exception as e:
            frappe.log_error(f"Invalid base64 audio data: {str(e)}", "Voice Note Error")
            return {"status": "error", "error": "Invalid audio data format"}

        # Detect audio format from data
        # OGG files start with 'OggS', WebM files start with different signature
        mimetype = "audio/ogg; codecs=opus"
        extension = "ogg"

        if audio_bytes[:4] == b'OggS':
            mimetype = "audio/ogg; codecs=opus"
            extension = "ogg"
        elif audio_bytes[:4] == b'\x1a\x45\xdf\xa3':  # WebM signature
            mimetype = "audio/webm; codecs=opus"
            extension = "webm"

        # Prepare media object
        media = {
            "data": audio_data,
            "filename": f"voice_note_{frappe.generate_hash(length=8)}.{extension}",
            "mimetype": mimetype
        }

        # Send via WhatsApp with voice message indicator
        result = send_chat_message(
            message="🎤 Voice message",
            receiver=receiver,
            company=company,
            media=media
        )

        return result

    except Exception as e:
        frappe.log_error(
            f"Error sending voice note: {str(e)}\n{frappe.get_traceback()}",
            "WhatsApp Voice Note Error"
        )
        return {"status": "error", "error": str(e)}

@frappe.whitelist()
def get_contact_info(phone: str) -> Dict[str, Any]:
    """
    Get contact information including profile picture and status.
    """
    try:
        # Validate phone number
        phone = validate_phone_number(phone)
        if not phone:
            return {"status": "error", "error": "Invalid phone number"}

        company = get_default_company()
        settings_name = frappe.db.get_value(
            "WhatsApp Settings",
            {"company": company, "integration_enabled": 1},
            "name"
        )

        if not settings_name:
            return {"status": "error", "error": "WhatsApp not configured"}

        doc = frappe.get_doc("WhatsApp Settings", settings_name)
        node_url = doc.node_url or "http://127.0.0.1:3000"
        session_id = doc.name.replace(" ", "_")

        # Request contact info from Node service
        response = requests.post(
            f"{node_url}/sessions/contact-info",
            json={
                "sessionId": session_id,
                "phone": phone
            },
            timeout=10
        )

        # Check if response is valid JSON
        try:
            return response.json()
        except ValueError:
            frappe.log_error(
                f"Node service returned invalid JSON. Status: {response.status_code}, Body: {response.text[:200]}",
                "WhatsApp Contact Info Invalid Response"
            )
            return {"status": "error", "error": f"Invalid response from Node service (status {response.status_code})"}

    except Exception as e:
        frappe.log_error(
            f"Error getting contact info: {str(e)}\n{frappe.get_traceback()}",
            "WhatsApp Contact Info Error"
        )
        return {"status": "error", "error": str(e)}
