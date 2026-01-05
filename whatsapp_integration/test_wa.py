import frappe
from whatsapp_integration.whatsapp_integration.doctype.whatsapp_settings.whatsapp_settings import send_whatsapp_message

def test_send_message(name, receiver, message):
    res = send_whatsapp_message(name, receiver, message)
    print(res)

# Usage: bench execute whatsapp_integration.test.test_send_message --args "WA-MyCompany, 919876543210, Hello from Frappe!"
