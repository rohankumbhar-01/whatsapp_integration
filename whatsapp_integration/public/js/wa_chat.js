frappe.provide('whatsapp.chat');

whatsapp.chat.Widget = class {
    constructor() {
        this.active_number = null;
        this.company = frappe.defaults.get_default('company');
        this.connection_check_interval = null;
        this.is_loading = false;
        this.retry_count = 0;
        this.max_retries = 3;

        this.render();
        this.bind_events();
        this.listen_realtime();

        // Check connection immediately and then every 45 seconds (reduced from 30)
        this.check_connection();
        this.connection_check_interval = setInterval(() => this.check_connection(), 45000);
    }

    destroy() {
        // Cleanup when widget is destroyed
        if (this.connection_check_interval) {
            clearInterval(this.connection_check_interval);
        }
    }

    render() {
        if ($('.wa-chat-widget').length) return;

        const html = `
            <div class="wa-chat-widget">
                <div class="wa-chat-window" id="waChatWindow">
                    <div class="wa-chat-header">
                        <div class="wa-back-btn" id="waBack" style="display:none; cursor:pointer; font-size:18px;"><i class="fa fa-chevron-left"></i></div>
                        <div class="wa-avatar">W</div>
                        <div class="wa-chat-header-info">
                            <div id="waHeaderTitle">WhatsApp Inbox</div>
                            <div id="waStatus">Checking...</div>
                        </div>
                        <div id="waVideoCall" title="WhatsApp Video Call" style="display:none; cursor:pointer; font-size:18px; margin-right:12px; color: #667781;"><i class="fa fa-video-camera"></i></div>
                        <div id="waVoiceCall" title="WhatsApp Voice Call" style="display:none; cursor:pointer; font-size:18px; margin-right:12px; color: #667781;"><i class="fa fa-phone"></i></div>
                        <div class="wa-close" style="cursor:pointer; font-size:20px;">&times;</div>
                    </div>
                    
                    <div id="waInboxView">
                        <div class="wa-search-bar">
                            <input type="text" id="waSearch" placeholder="Search contact or enter number...">
                        </div>
                        <div class="wa-chat-list" id="waChatList">
                            <div style="padding: 20px; text-align:center; color:#888;">No recent chats found.</div>
                        </div>
                    </div>

                    <div id="waChatView" style="display:none; flex:1; flex-direction:column; overflow:hidden;">
                        <div class="wa-chat-messages" id="waMessages"></div>
                        <div class="wa-chat-footer">
                            <input type="text" class="wa-chat-input" id="waInput" placeholder="Type a message...">
                            <button class="wa-send-btn" id="waSend"><i class="fa fa-send"></i></button>
                        </div>
                    </div>
                </div>
                <div class="wa-chat-button" id="waChatToggle">
                    <i class="fa fa-whatsapp"></i>
                </div>
            </div>
        `;
        $('body').append(html);
        this.check_connection();
        this.load_recent_chats();
    }

    bind_events() {
        $('#waChatToggle').on('click', () => {
            $('#waChatWindow').toggleClass('active');
            if ($('#waChatWindow').hasClass('active')) this.load_recent_chats();
        });

        $('.wa-close').on('click', () => $('#waChatWindow').removeClass('active'));

        $('#waBack').on('click', () => this.show_inbox());

        $('#waVoiceCall').on('click', () => {
            if (this.active_number && typeof this.init_call_overlay === 'function') {
                this.init_call_overlay('voice');
            } else if (this.active_number) {
                const phone = this.active_number.replace(/[+\-\s]/g, '');
                window.open(`https://wa.me/${phone}`, '_blank');
            }
        });

        $('#waVideoCall').on('click', () => {
            if (this.active_number && typeof this.init_call_overlay === 'function') {
                this.init_call_overlay('video');
            } else if (this.active_number) {
                const phone = this.active_number.replace(/[+\-\s]/g, '');
                window.open(`https://wa.me/${phone}`, '_blank');
            }
        });

        $('#waSend').on('click', () => this.send_message());

        $('#waInput').on('keypress', (e) => {
            if (e.which == 13) this.send_message();
        });

        $('#waSearch').on('keyup', (e) => {
            const query = $('#waSearch').val().trim();
            if (query.length < 3) {
                if (query.length === 0) this.load_recent_chats();
                return;
            }

            // Debounce search
            clearTimeout(this.search_timeout);
            this.search_timeout = setTimeout(() => {
                frappe.call({
                    method: 'whatsapp_integration.whatsapp_integration.api.search_contacts',
                    args: { query: query },
                    callback: (r) => {
                        const list = $('#waChatList');
                        list.empty();
                        if (r.message && r.message.length) {
                            r.message.forEach(res => {
                                const item = $(`
                                    <div class="wa-chat-item">
                                        <div class="wa-avatar-small" style="background:#2196F3">${res.name[0]}</div>
                                        <div class="wa-chat-item-info">
                                            <div class="wa-chat-item-name">${res.name}</div>
                                            <div class="wa-chat-item-last">${res.phone} (${res.type})</div>
                                        </div>
                                    </div>
                                `);
                                item.on('click', () => this.open_chat(res.phone, res.name));
                                list.append(item);
                            });
                        } else {
                            list.append('<div style="padding: 20px; text-align:center; color:#888;">No contacts found. Press Enter to start chat with number.</div>');
                        }
                    }
                });
            }, 500);
        });

        $('#waSearch').on('keypress', (e) => {
            if (e.which == 13) {
                const val = $('#waSearch').val().trim();
                if (/^\d+$/.test(val.replace(/[+\-\s]/g, ''))) {
                    this.open_chat(val.replace(/[+\-\s]/g, ''), 'New Chat');
                }
            }
        });
    }

    async check_connection() {
        try {
            const response = await frappe.call({
                method: 'whatsapp_integration.whatsapp_integration.api.get_system_status',
                args: { company: this.company },
                error: (r) => {
                    this.update_status('Error', '#ff4d4d');
                    this.retry_count++;
                }
            });

            if (response && response.message) {
                const status = response.message.status;
                this.retry_count = 0; // Reset on success

                switch (status) {
                    case 'Connected':
                        this.update_status('Online', '#25D366');
                        break;
                    case 'Disconnected':
                    case 'Disabled':
                        this.update_status('Offline', '#ff4d4d');
                        break;
                    case 'QR Scan Required':
                        this.update_status('Scan QR', '#FFA500');
                        break;
                    default:
                        this.update_status(status, '#888');
                }
            }
        } catch (error) {
            console.error('Connection check failed:', error);
            this.update_status('Error', '#ff4d4d');
        }
    }

    update_status(text, color) {
        $('#waStatus').text(text).css('color', color);
    }

    async load_recent_chats() {
        const list = $('#waChatList');

        // Show loading indicator
        list.html('<div style="padding: 20px; text-align:center; color:#888;"><i class="fa fa-spinner fa-spin"></i> Loading chats...</div>');

        try {
            const response = await frappe.call({
                method: 'whatsapp_integration.whatsapp_integration.api.get_recent_chats',
                args: { limit: 50 }
            });

            list.empty();

            if (response && response.message && response.message.length) {
                response.message.forEach(chat => {
                    const firstLetter = chat.sender_full_name ? chat.sender_full_name[0].toUpperCase() : '?';
                    const truncatedMsg = this.truncate_text(chat.last_msg || '', 50);

                    const item = $(`
                        <div class="wa-chat-item" data-phone="${this.escape_html(chat.phone)}">
                            <div class="wa-avatar-small">${firstLetter}</div>
                            <div class="wa-chat-item-info">
                                <div class="wa-chat-item-name">${this.escape_html(chat.sender_full_name)}</div>
                                <div class="wa-chat-item-last">${this.escape_html(truncatedMsg)}</div>
                            </div>
                            <div class="wa-chat-item-time">${comment_when(chat.time)}</div>
                        </div>
                    `);
                    item.on('click', () => this.open_chat(chat.phone, chat.sender_full_name));
                    list.append(item);
                });
            } else {
                list.html('<div style="padding: 20px; text-align:center; color:#888;">No recent chats. Start a new conversation!</div>');
            }
        } catch (error) {
            console.error('Error loading chats:', error);
            list.html('<div style="padding: 20px; text-align:center; color:#ff4d4d;"><i class="fa fa-exclamation-triangle"></i> Failed to load chats. <a href="#" onclick="window.whatsapp_widget.load_recent_chats(); return false;">Retry</a></div>');
        }
    }

    truncate_text(text, max_length) {
        if (!text) return '';
        return text.length > max_length ? text.substring(0, max_length) + '...' : text;
    }

    escape_html(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    async open_chat(phone, name) {
        this.active_number = phone;
        $('#waHeaderTitle').text(name);
        $('#waInboxView').hide();
        $('#waChatView').css('display', 'flex');
        $('#waBack').show();
        $('#waVoiceCall').show();
        $('#waVideoCall').show();

        $('#waMessages').empty();
        $('#waMessages').append('<div style="text-align:center; padding:10px; font-size:12px; color:#888;">Loading history...</div>');

        frappe.call({
            method: 'whatsapp_integration.whatsapp_integration.api.get_chat_history',
            args: { sender_phone: phone },
            callback: (r) => {
                $('#waMessages').empty();
                if (r.message && r.message.length) {
                    r.message.forEach(msg => {
                        const type = msg.message_type === 'Incoming' ? 'received' : 'sent';
                        this.add_message(msg.message, type, msg.creation, msg.media_attachment);
                    });
                }
            }
        });
    }

    show_inbox() {
        this.active_number = null;
        $('#waHeaderTitle').text('WhatsApp Inbox');
        $('#waChatView').hide();
        $('#waInboxView').show();
        $('#waBack').hide();
        $('#waVoiceCall').hide();
        $('#waVideoCall').hide();
        this.load_recent_chats();
    }

    async send_message() {
        const input = $('#waInput');
        const text = input.val().trim();
        const btn = $('#waSend');

        // Validation
        if (!text || btn.prop('disabled')) return;

        if (!this.active_number) {
            frappe.show_alert({ message: 'No active chat selected', indicator: 'red' });
            return;
        }

        // Show loading state
        input.prop('disabled', true);
        btn.prop('disabled', true).html('<i class="fa fa-spinner fa-spin"></i>');

        try {
            const response = await frappe.call({
                method: 'whatsapp_integration.whatsapp_integration.api.send_chat_message',
                args: {
                    message: text,
                    receiver: this.active_number,
                    company: this.company
                }
            });

            // Reset UI state
            input.prop('disabled', false);
            btn.prop('disabled', false).html('<i class="fa fa-send"></i>');

            if (response && response.message && response.message.status === 'sent') {
                // Add message to chat
                this.add_message(text, 'sent');
                input.val('');
                input.focus();
            } else {
                const error = response?.message?.error || "Unknown error occurred";
                frappe.show_alert({
                    message: `Failed to send: ${error}`,
                    indicator: 'red'
                });

                // Log error for debugging
                console.error('Send message error:', response);
            }
        } catch (error) {
            // Reset UI state on error
            input.prop('disabled', false);
            btn.prop('disabled', false).html('<i class="fa fa-send"></i>');

            frappe.show_alert({
                message: 'Network error. Please check your connection.',
                indicator: 'red'
            });

            console.error('Send message exception:', error);
        }
    }

    add_message(text, type, time = null, media = null) {
        const container = $('#waMessages');
        const display_time = time ? moment(time).format('HH:mm') : moment().format('HH:mm');

        // Escape text content for safety
        let safe_text = this.escape_html(text || '');

        let content = safe_text;
        if (media) {
            const safe_media = this.escape_html(media);
            const is_img = media.match(/\.(jpg|jpeg|png|gif|webp)$/i);
            if (is_img) {
                content = `<img src="${safe_media}" style="max-width:100%; border-radius:8px; margin-bottom:5px; cursor:pointer;" onclick="window.open('${safe_media}')"><br>${safe_text}`;
            } else {
                content = `<a href="${safe_media}" target="_blank" style="color:#00a884; text-decoration:underline;">📎 View Attachment</a><br>${safe_text}`;
            }
        }

        const msg_html = $(`
            <div class="wa-msg wa-msg-${type}">
                ${content}
                <div class="wa-msg-time">${display_time}</div>
            </div>
        `);

        container.append(msg_html);

        // Smooth scroll to bottom
        container.animate({
            scrollTop: container[0].scrollHeight
        }, 300);
    }

    listen_realtime() {
        frappe.realtime.on('whatsapp_incoming_message', (data) => {
            if (this.active_number && data.from === this.active_number) {
                this.add_message(data.text, 'received', null, data.media);
            } else {
                this.load_recent_chats();
                frappe.show_alert({
                    message: `New WhatsApp from ${data.sender_name || data.from}: ${data.text}`,
                    indicator: 'green'
                });
            }
        });
    }
};

// Auto-initialize when Frappe loads
$(document).on('app_ready', function () {
    if (!window.whatsapp_widget) {
        window.whatsapp_widget = new whatsapp.chat.Widget();
    }
});

$(document).on('page_change', function () {
    // Ensure widget stays visible or re-renders if destroyed by SPA navigation
    if (!$('.wa-chat-widget').length && window.whatsapp_widget) {
        window.whatsapp_widget.render();
    }
});
