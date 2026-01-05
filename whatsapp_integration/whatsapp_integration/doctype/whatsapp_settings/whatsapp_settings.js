frappe.ui.form.on('WhatsApp Settings', {
    setup: function (frm) {
        frappe.realtime.on('whatsapp_connection_update', function (data) {
            if (data.doc_name === frm.doc.name) {
                if (data.status === 'Connected') {
                    frappe.show_alert({
                        message: __('WhatsApp Connected Successfully!'),
                        indicator: 'green'
                    });
                    frm.reload_doc();
                    // Close any open dialogs
                    if (cur_dialog && cur_dialog.title === 'Scan QR Code') {
                        cur_dialog.hide();
                    }
                } else if (data.status === 'Disconnected') {
                    frm.reload_doc();
                }
            }
        });
    },
    refresh: function (frm) {
        if (frm.doc.integration_enabled) {
            if (frm.doc.connection_status === 'Connected') {
                frm.add_custom_button(__('Disconnect WhatsApp'), function () {
                    frm.trigger('disconnect_whatsapp');
                }, __('Actions'));

                frm.add_custom_button(__('Send Test Message'), function () {
                    frm.trigger('send_test_message');
                }, __('Actions'));
            } else {
                frm.add_custom_button(__('Connect WhatsApp'), function () {
                    frm.trigger('connect_whatsapp');
                }, __('Actions'));
            }
        }
    },

    disconnect_whatsapp: function (frm) {
        frappe.confirm(__('Are you sure you want to disconnect? This will clear the session.'), () => {
            frappe.call({
                method: 'whatsapp_integration.whatsapp_integration.doctype.whatsapp_settings.whatsapp_settings.logout_whatsapp',
                args: { name: frm.doc.name },
                callback: function (r) {
                    frappe.msgprint(__('Logged out successfully'));
                    frm.reload_doc();
                }
            });
        });
    },

    connect_whatsapp: function (frm) {
        let d = new frappe.ui.Dialog({
            title: 'Scan QR Code',
            fields: [
                {
                    fieldtype: 'HTML',
                    fieldname: 'qr_code',
                    label: 'QR Code'
                },
                {
                    fieldtype: 'HTML',
                    fieldname: 'status',
                    label: 'Status'
                }
            ]
        });

        d.show();

        let fetch_qr = () => {
            frappe.call({
                method: 'whatsapp_integration.whatsapp_integration.doctype.whatsapp_settings.whatsapp_settings.get_qr_code',
                args: { name: frm.doc.name },
                callback: function (r) {
                    if (r.message && r.message.qr) {
                        d.get_field('qr_code').$wrapper.html(`
							<div style="text-align: center; padding: 20px;">
								<img src="${r.message.qr}" style="width: 250px; height: 250px;">
							</div>
						`);
                        d.get_field('status').$wrapper.html('<p style="text-align: center;">Scan this QR code with your WhatsApp app.</p>');
                    } else if (r.message && (r.message.status === 'Connected' || r.message.status === 'success')) {
                        d.hide();
                        frappe.msgprint(__('WhatsApp Connected Successfully!'));
                        frm.reload_doc();
                    } else {
                        d.get_field('status').$wrapper.html(`<p style="text-align: center;">${r.message.error || 'Waiting for QR...'}</p>`);
                        if (!r.message.error) {
                            setTimeout(fetch_qr, 5000);
                        }
                    }
                }
            });
        };

        fetch_qr();
    },

    send_test_message: function (frm) {
        if (!frm.doc.test_receiver || !frm.doc.test_message) {
            frappe.msgprint(__('Please enter receiver and message in the Test Messaging section below.'));
            return;
        }

        frappe.call({
            method: 'whatsapp_integration.whatsapp_integration.doctype.whatsapp_settings.whatsapp_settings.send_whatsapp_message',
            args: {
                name: frm.doc.name,
                receiver: frm.doc.test_receiver,
                message: frm.doc.test_message
            },
            callback: function (r) {
                if (r.message && r.message.status === 'sent') {
                    frappe.msgprint(__('Message Sent!'));
                } else {
                    frappe.msgprint(__('Error: ' + JSON.stringify(r.message)));
                }
            }
        });
    }
});
