frappe.provide('whatsapp.chat');

whatsapp.chat.Widget = class {
    constructor() {
        console.log("WhatsApp Widget v2.2 - Group Fix - HARD RELOAD DONE");
        this.active_number = null;
        this.company = frappe.defaults.get_default('company');
        this.connection_check_interval = null;
        this.is_loading = false;
        this.retry_count = 0;
        this.max_retries = 3;
        this.is_active_group = false;

        this.render();
        this.bind_events();
        this.listen_realtime();

        this.check_connection();
        this.connection_check_interval = setInterval(() => this.check_connection(), 45000);
    }

    destroy() {
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

                    <div id="waGroupInfo" class="wa-group-info">
                        <div class="wa-group-info-header">
                            <i class="fa fa-arrow-left" id="waGroupInfoBack" style="cursor:pointer"></i>
                            <span style="font-weight:bold; margin-left:15px;">Group Info</span>
                        </div>
                        <div class="wa-group-member-list" id="waMemberList"></div>
                    </div>
                </div>
                <div class="wa-chat-button" id="waChatToggle">
                    <i class="fa fa-whatsapp"></i>
                </div>
            </div>
        `;
        $('body').append(html);
    }

    bind_events() {
        $('#waChatToggle').on('click', () => {
            $('#waChatWindow').toggleClass('active');
        });

        $('.wa-close').on('click', (e) => {
            e.stopPropagation();
            $('#waChatWindow').removeClass('active');
        });

        $('#waBack').on('click', () => this.show_inbox());

        $('.wa-chat-header').on('click', (e) => {
            if ($(e.target).closest('.wa-close, .wa-back-btn, #waVideoCall, #waVoiceCall').length) return;
            if (this.is_active_group && this.active_number) {
                this.show_group_info();
            }
        });

        $('#waGroupInfoBack').on('click', () => {
            $('#waGroupInfo').hide();
        });

        $('#waSend').on('click', () => this.send_message());
        $('#waInput').on('keypress', (e) => {
            if (e.which == 13) this.send_message();
        });

        $('#waSearch').on('input', (e) => {
            const query = $(e.target).val();
            if (query.length < 2) {
                if (query.length === 0) this.load_recent_chats();
                return;
            }

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
                                item.on('click', () => {
                                    const isGroup = res.phone.includes('-') || res.phone.length >= 15;
                                    this.open_chat(res.phone, res.name, isGroup);
                                });
                                list.append(item);
                            });
                        } else {
                            list.append('<div style="padding: 20px; text-align:center; color:#888;">No contacts found.</div>');
                        }
                    }
                });
            }, 500);
        });
    }

    async check_connection() {
        try {
            const response = await frappe.call({
                method: 'whatsapp_integration.whatsapp_integration.api.get_system_status',
                args: { company: this.company }
            });

            if (response && response.message) {
                const status = response.message.status;
                const statusEl = $('#waStatus');

                if (statusEl.attr('data-is-group') === '1' || this.active_number) {
                    if (statusEl.attr('data-is-group') === '1') {
                        statusEl.html('<span style="color:#25D366; font-weight:bold;">● Group Chat (v2)</span>');
                    }
                    return;
                }

                switch (status) {
                    case 'Connected':
                        this.update_status('Online', '#25D366');
                        break;
                    case 'Disconnected':
                        this.update_status('Offline', '#ff4d4d');
                        break;
                    default:
                        this.update_status(status, '#888');
                }
            }
        } catch (error) {
            console.error('Connection check failed:', error);
        }
    }

    update_status(text, color) {
        $('#waStatus').text(text).css('color', color);
    }

    escape_html(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    truncate_text(text, max_length) {
        if (!text) return '';
        return text.length > max_length ? text.substring(0, max_length) + '...' : text;
    }

    async load_recent_chats() {
        const list = $('#waChatList');
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
                    const isGroup = chat.is_group;
                    const avatarBg = isGroup ? '#00a884' : '#2196F3';

                    const item = $(`
                        <div class="wa-chat-item ${isGroup ? 'wa-group-item' : ''}" data-phone="${chat.phone}">
                            <div class="wa-avatar-small" style="background:${avatarBg}">${isGroup ? '<i class="fa fa-users"></i>' : firstLetter}</div>
                            <div class="wa-chat-item-info">
                                <div class="wa-chat-item-name">${chat.sender_full_name}</div>
                                <div class="wa-chat-item-last">${chat.last_msg}</div>
                            </div>
                            <div class="wa-chat-item-time">${comment_when(chat.time)}</div>
                        </div>
                    `);
                    item.on('click', () => this.open_chat(chat.phone, chat.sender_full_name, isGroup));
                    list.append(item);
                });
            }
        } catch (e) {
            console.error(e);
        }
    }

    async open_chat(phone, name, isGroup = false) {
        const phoneStr = String(phone || '');
        if (!isGroup && (phoneStr.includes('-') || phoneStr.length >= 15)) {
            isGroup = true;
        }

        this.active_number = phoneStr;
        this.is_active_group = isGroup;

        $('#waHeaderTitle').text(name);
        $('#waStatus').html(isGroup ? '<span style="color:#25D366; font-weight:bold;">● Group Chat (v2)</span>' : 'Checking...');
        $('#waStatus').attr('data-is-group', isGroup ? '1' : '0');

        // Safety fallback if presence event doesn't arrive
        if (!isGroup) {
            setTimeout(() => {
                const statusEl = $('#waStatus');
                if (statusEl.text() === 'Checking...' && this.active_number === phoneStr) {
                    statusEl.text('Offline').css('color', '#888');
                }
            }, 4000);
        }

        $('#waInboxView').hide();
        $('#waChatView').css('display', 'flex').show();
        $('#waBack').show();
        $('#waGroupInfo').hide();

        if (isGroup) {
            $('#waVoiceCall, #waVideoCall').hide();
        } else {
            $('#waVoiceCall, #waVideoCall').show();
            // Subscribe to presence for individual chat
            frappe.call({
                method: 'whatsapp_integration.whatsapp_integration.api.subscribe_contact_presence',
                args: { phone: phoneStr }
            });
        }

        frappe.call({
            method: 'whatsapp_integration.whatsapp_integration.api.get_chat_history',
            args: { sender_phone: phoneStr },
            callback: (r) => {
                $('#waMessages').empty();
                if (r.message) {
                    r.message.forEach(msg => {
                        this.add_message(
                            msg.message,
                            msg.message_type === 'Incoming' ? 'received' : 'sent',
                            msg.creation,
                            msg.media_attachment,
                            msg.message_status,
                            msg.message_id,
                            msg.reply_to_message_id,
                            msg.reply_to_message_text,
                            msg.sender_name,
                            msg.sender,
                            msg.is_group_message
                        );
                    });
                }
            }
        });
    }

    show_inbox() {
        this.active_number = null;
        this.is_active_group = false;
        $('#waStatus').attr('data-is-group', '0');
        $('#waChatView').hide();
        $('#waInboxView').show();
        $('#waBack').hide();
        $('#waHeaderTitle').text('WhatsApp Inbox');
        this.load_recent_chats();
    }

    show_group_info() {
        const list = $('#waMemberList');
        list.html('<div style="padding:20px; text-align:center;"><i class="fa fa-spinner fa-spin"></i> Loading...</div>');
        $('#waGroupInfo').css('display', 'flex').show();

        frappe.call({
            method: 'whatsapp_integration.whatsapp_integration.api.get_group_metadata',
            args: { group_id: this.active_number },
            callback: (r) => {
                if (r.message && r.message.status === 'success') {
                    const metadata = r.message.metadata;
                    list.empty();
                    list.append(`<div style="padding:10px 20px; font-weight:bold;">${metadata.participants.length} Participants</div>`);
                    metadata.participants.forEach(p => {
                        const displayName = p.name || p.phone || p.id.split('@')[0];
                        const displaySub = p.phone && p.phone !== displayName ? p.phone : '';

                        list.append(`
                            <div class="wa-member-item">
                                <div class="wa-member-avatar">${displayName[0].toUpperCase()}</div>
                                <div class="wa-member-name">
                                    <div style="font-weight:500;">${this.escape_html(displayName)}</div>
                                    ${displaySub ? `<div style="font-size:11px; color:#666;">${this.escape_html(displaySub)}</div>` : ''}
                                </div>
                                ${p.admin ? '<span class="wa-member-admin">Admin</span>' : ''}
                            </div>
                        `);
                    });
                }
            }
        });
    }

    add_message(text, type, time = null, media = null, status = null, messageId = null, replyTo = null, replyToText = null, senderName = null, senderId = null, isGroupMsg = null) {
        const container = $('#waMessages');
        const display_time = time ? moment(time).format('HH:mm') : moment().format('HH:mm');
        const safe_text = this.escape_html(text || '');
        let content = '';

        if (replyTo || replyToText) {
            content += `<div class="wa-msg-reply" style="border-left:3px solid #00a884; background:#f0f0f0; border-radius:5px; padding:5px 8px; font-size:12px; margin-bottom:5px;">${this.escape_html(replyToText || 'Media')}</div>`;
        }

        const phoneStr = String(this.active_number || '');
        const isActuallyGroup = isGroupMsg === 1 || this.is_active_group || phoneStr.includes('-') || phoneStr.length >= 15;

        if (isActuallyGroup && type === 'received') {
            const name = senderName || senderId || 'Member';
            content += `<div class="wa-msg-sender" style="font-weight:bold; color:#356de4; font-size:12px; margin-bottom:4px;">${name}</div>`;
        }

        content += safe_text;
        if (media) {
            content += `<br><img src="${media}" style="max-width:100%; border-radius:8px; margin-top:5px;">`;
        }

        const msg_html = $(`<div class="wa-msg wa-msg-${type}">${content}<div class="wa-msg-time">${display_time}</div></div>`);
        container.append(msg_html);
        container.scrollTop(container[0].scrollHeight);
    }

    async send_message() {
        const input = $('#waInput');
        const text = input.val().trim();
        if (!text || !this.active_number) return;

        input.val('').prop('disabled', true);
        const response = await frappe.call({
            method: 'whatsapp_integration.whatsapp_integration.api.send_chat_message',
            args: { receiver: this.active_number, message: text }
        });

        input.prop('disabled', false).focus();
        if (response.message && response.message.status === 'sent') {
            this.add_message(text, 'sent');
        }
    }

    listen_realtime() {
        frappe.realtime.on('whatsapp_incoming_message', (data) => {
            const isGroup = !!data.group_id;
            const chatMatch = isGroup ? (this.active_number === data.group_id) : (this.active_number === data.from);
            if (this.active_number && chatMatch) {
                this.add_message(data.text, 'received', null, data.media, null, data.message_id, data.reply_to_id, data.reply_to_text, data.sender_name, data.from, isGroup ? 1 : 0);
            } else {
                this.load_recent_chats();
            }
        });

        frappe.realtime.on('whatsapp_presence_update', (data) => {
            if (this.active_number && data.from === this.active_number) {
                this.handle_presence(data.presence);
            }
        });
    }

    handle_presence(presences) {
        if (!presences) return;
        const statusEl = $('#waStatus');

        // Baileys sends it as { lastKnownPresence: 'available', lastSeen?: number }
        const p = presences.lastKnownPresence;
        const lastSeen = presences.lastSeen;

        let text = 'Offline';
        let color = '#888';

        if (p === 'composing') {
            text = 'Typing...';
            color = '#25D366';
        } else if (p === 'recording') {
            text = 'Recording audio...';
            color = '#25D366';
        } else if (p === 'available') {
            text = 'Online';
            color = '#25D366';
        } else if (lastSeen) {
            text = `Last seen ${moment.unix(lastSeen).fromNow()}`;
            color = '#888';
        }

        statusEl.text(text).css({
            'color': color,
            'font-weight': (text === 'Online' || text === 'Typing...' || text === 'Recording audio...') ? 'bold' : 'normal'
        });
    }
};

$(document).on('app_ready', () => {
    if (!window.whatsapp_widget) window.whatsapp_widget = new whatsapp.chat.Widget();
});
$(document).on('page_change', () => {
    if (!$('.wa-chat-widget').length && window.whatsapp_widget) window.whatsapp_widget.render();
});
