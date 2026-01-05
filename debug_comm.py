import frappe

def check():
    frappe.connect()
    comms = frappe.get_all("Communication", filters={"subject": "WhatsApp Message"}, fields=["*"])
    print(f"Found {len(comms)} WhatsApp messages")
    for c in comms:
        print(f"From: {c.sender}, Content: {c.content}")
    
    logs = frappe.get_all("Error Log", filters={"method": ["like", "%WhatsApp%"]}, fields=["*"], limit=5)
    print(f"Recent WhatsApp Errors: {len(logs)}")
    for l in logs:
        print(f"Method: {l.method}, Error: {l.error[:200]}")

if __name__ == "__main__":
    check()
