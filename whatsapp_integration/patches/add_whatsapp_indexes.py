import frappe
from frappe.model.utils.index import add_index


def execute():
    """
    Add database indexes for WhatsApp Message table to improve query performance.
    """
    frappe.logger().info("Adding indexes to WhatsApp Message table")

    try:
        # Index on sender for faster lookups
        add_index("WhatsApp Message", ["sender"])

        # Index on receiver for faster lookups
        add_index("WhatsApp Message", ["receiver"])

        # Index on message_id for faster duplicate checks
        add_index("WhatsApp Message", ["message_id"])

        # Composite index on sender + creation for chat history queries
        add_index("WhatsApp Message", ["sender", "creation"])

        # Composite index on receiver + creation for chat history queries
        add_index("WhatsApp Message", ["receiver", "creation"])

        # Index on company for multi-company filtering
        add_index("WhatsApp Message", ["company"])

        # Index on contact for contact-based queries
        add_index("WhatsApp Message", ["contact"])

        frappe.logger().info("WhatsApp Message indexes added successfully")

    except Exception as e:
        frappe.log_error(
            f"Error adding WhatsApp indexes: {str(e)}",
            "WhatsApp Index Patch Error"
        )
