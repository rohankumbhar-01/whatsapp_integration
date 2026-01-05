// Robust injection for Print View
$(document).on('app_ready page_change', function () {
    check_and_add_button();
    // Keep checking for a few seconds as Print View renders asynchronously
    const interval = setInterval(check_and_add_button, 1000);
    setTimeout(() => clearInterval(interval), 10000);
});

function check_and_add_button() {
    if ($('.btn-wa-send-pdf').length) return;

    // Check if we are in a print view context (standard or new print designer)
    const route = frappe.get_route();
    if (!route || route.length === 0) return;

    const is_print_view = route[0] === 'print';
    const has_print_actions = $('.print-view-actions').length > 0;

    if (is_print_view || has_print_actions) {
        add_whatsapp_button();
    }
}

function add_whatsapp_button() {
    if ($('.btn-wa-send-pdf').length) return;

    const print_view = frappe.ui.form.print_view;
    if (!print_view) return;

    const $btn_group = $('.print-view-actions .btn-group, .print-view-actions');
    if (!$btn_group.length) return;

    const $wa_btn = $(`
        <button class="btn btn-default btn-sm btn-wa-send-pdf" style="margin-left: 5px; background-color: #25D366; color: white; border-color: #25D366;">
            <i class="fa fa-whatsapp"></i> Send via WhatsApp
        </button>
    `);

    $wa_btn.on('click', function () {
        const doc = frappe.ui.form.print_view.doc;
        const print_format = frappe.ui.form.print_view.print_format_selector.val();
        const letterhead = frappe.ui.form.print_view.letterhead_selector.val();

        frappe.confirm('Send this PDF via WhatsApp to the customer?', () => {
            frappe.dom.freeze('Sending PDF...');
            frappe.call({
                method: 'whatsapp_integration.whatsapp_integration.api.send_print_as_pdf',
                args: {
                    doctype: doc.doctype,
                    name: doc.name,
                    print_format: print_format,
                    letterhead: letterhead
                },
                callback: function (r) {
                    frappe.dom.unfreeze();
                    if (!r.exc) {
                        frappe.show_alert({
                            message: __('PDF sent successfully via WhatsApp'),
                            indicator: 'green'
                        });
                    }
                }
            });
        });
    });

    if ($btn_group.find('.btn-print-print').length) {
        $wa_btn.insertAfter($btn_group.find('.btn-print-print'));
    } else {
        $btn_group.append($wa_btn);
    }
}
