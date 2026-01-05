// WhatsApp Integration - Media & Voice Features
// This file extends the main chat widget with media upload and voice recording capabilities

frappe.provide('whatsapp.chat');

// ============================================================================
// MEDIA & FILE UPLOAD
// ============================================================================

whatsapp.chat.Widget.prototype.init_media_upload = function () {
    const self = this;

    // Create file input (hidden)
    if (!$('#waFileInput').length) {
        $('body').append('<input type="file" id="waFileInput" style="display:none" accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.txt">');
    }

    // Add attachment button to chat footer
    if (!$('#waAttachBtn').length) {
        const attachBtn = $(`
            <button class="wa-attach-btn" id="waAttachBtn" title="Attach file">
                <i class="fa fa-paperclip"></i>
            </button>
        `);
        attachBtn.insertBefore('#waInput');

        attachBtn.on('click', function () {
            $('#waFileInput').click();
        });
    }

    $('#waFileInput').off('change').on('change', function (e) {
        const file = e.target.files[0];
        if (file) {
            self.upload_and_send_file(file);
        }
        // Reset input
        $(this).val('');
    });
};

whatsapp.chat.Widget.prototype.upload_and_send_file = function (file) {
    const self = this;

    // Validate file size (16MB max)
    if (file.size > 16 * 1024 * 1024) {
        frappe.show_alert({
            message: 'File too large. Maximum size is 16MB',
            indicator: 'red'
        });
        return;
    }

    // Show uploading message
    const uploadingMsg = frappe.show_alert({
        message: `Uploading ${file.name}...`,
        indicator: 'blue'
    });

    const reader = new FileReader();
    reader.onload = function (e) {
        const base64Data = e.target.result.split(',')[1];

        frappe.call({
            method: 'whatsapp_integration.whatsapp_integration.api.send_chat_message',
            args: {
                message: file.name,
                receiver: self.active_number,
                company: self.company,
                media: {
                    data: base64Data,
                    filename: file.name,
                    mimetype: file.type
                }
            },
            callback: function (r) {
                if (r.message && r.message.status === 'sent') {
                    // Determine media type
                    let mediaType = 'file';
                    if (file.type.startsWith('image/')) mediaType = 'image';
                    else if (file.type.startsWith('video/')) mediaType = 'video';
                    else if (file.type.startsWith('audio/')) mediaType = 'audio';

                    self.add_message_with_media(file.name, 'sent', null, r.message.file_url, mediaType);

                    frappe.show_alert({
                        message: 'File sent successfully',
                        indicator: 'green'
                    });
                } else {
                    frappe.show_alert({
                        message: 'Failed to send file: ' + (r.message?.error || 'Unknown error'),
                        indicator: 'red'
                    });
                }
            },
            error: function () {
                frappe.show_alert({
                    message: 'Network error while sending file',
                    indicator: 'red'
                });
            }
        });
    };

    reader.onerror = function () {
        frappe.show_alert({
            message: 'Failed to read file',
            indicator: 'red'
        });
    };

    reader.readAsDataURL(file);
};

// ============================================================================
// VOICE RECORDING
// ============================================================================

whatsapp.chat.Widget.prototype.init_voice_recording = function () {
    const self = this;
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.is_recording = false;
    this.recordingStartTime = null;

    // Add voice button if not exists
    if (!$('#waVoiceBtn').length) {
        const voiceBtn = $(`
            <button class="wa-voice-btn" id="waVoiceBtn" title="Record voice message">
                <i class="fa fa-microphone"></i>
            </button>
        `);
        voiceBtn.insertBefore('#waSend');

        // Long press to record
        let pressTimer;

        voiceBtn.on('mousedown touchstart', function (e) {
            e.preventDefault();
            pressTimer = setTimeout(() => {
                self.start_voice_recording();
            }, 200); // 200ms delay to prevent accidental recording
        });

        voiceBtn.on('mouseup touchend mouseleave touchcancel', function (e) {
            e.preventDefault();
            clearTimeout(pressTimer);

            if (self.is_recording) {
                self.stop_voice_recording();
            }
        });
    }
};

whatsapp.chat.Widget.prototype.start_voice_recording = function () {
    const self = this;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        frappe.show_alert({
            message: 'Voice recording not supported in this browser',
            indicator: 'red'
        });
        return;
    }

    navigator.mediaDevices.getUserMedia({ audio: true })
        .then(stream => {
            self.audioChunks = [];
            self.recordingStartTime = Date.now();

            // Use webm or ogg format depending on browser support
            const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';
            self.mediaRecorder = new MediaRecorder(stream, { mimeType });

            self.mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) {
                    self.audioChunks.push(e.data);
                }
            };

            self.mediaRecorder.onstop = () => {
                const duration = Math.floor((Date.now() - self.recordingStartTime) / 1000);

                if (duration < 1) {
                    frappe.show_alert({
                        message: 'Recording too short. Hold button longer.',
                        indicator: 'orange'
                    });
                    stream.getTracks().forEach(track => track.stop());
                    return;
                }

                const audioBlob = new Blob(self.audioChunks, { type: mimeType });
                self.send_voice_note(audioBlob, duration);

                // Stop all tracks
                stream.getTracks().forEach(track => track.stop());
            };

            self.mediaRecorder.start();
            self.is_recording = true;

            // Visual feedback
            $('#waVoiceBtn').addClass('recording').html('<i class="fa fa-circle" style="color:red; animation:pulse 1s infinite;"></i>');

            // Show recording indicator in input
            $('#waInput').prop('placeholder', '🎤 Recording... Release to send');
        })
        .catch(err => {
            console.error('Error accessing microphone:', err);
            frappe.show_alert({
                message: 'Could not access microphone. Please check permissions.',
                indicator: 'red'
            });
        });
};

whatsapp.chat.Widget.prototype.stop_voice_recording = function () {
    const self = this;

    if (self.mediaRecorder && self.is_recording) {
        self.mediaRecorder.stop();
        self.is_recording = false;

        // Reset button and input
        $('#waVoiceBtn').removeClass('recording').html('<i class="fa fa-microphone"></i>');
        $('#waInput').prop('placeholder', 'Type a message...');
    }
};

whatsapp.chat.Widget.prototype.send_voice_note = function (audioBlob, duration) {
    const self = this;

    frappe.show_alert({
        message: 'Sending voice note...',
        indicator: 'blue'
    });

    const reader = new FileReader();
    reader.onload = function (e) {
        const base64Data = e.target.result.split(',')[1];

        frappe.call({
            method: 'whatsapp_integration.whatsapp_integration.api.send_voice_note',
            args: {
                audio_data: base64Data,
                receiver: self.active_number,
                company: self.company
            },
            callback: function (r) {
                if (r.message && r.message.status === 'sent') {
                    self.add_message_with_media(`🎤 Voice message (${duration}s)`, 'sent', null, null, 'audio');
                    frappe.show_alert({
                        message: 'Voice note sent',
                        indicator: 'green'
                    });
                } else {
                    frappe.show_alert({
                        message: 'Failed to send voice note: ' + (r.message?.error || 'Unknown error'),
                        indicator: 'red'
                    });
                }
            },
            error: function () {
                frappe.show_alert({
                    message: 'Network error while sending voice note',
                    indicator: 'red'
                });
            }
        });
    };

    reader.onerror = function () {
        frappe.show_alert({
            message: 'Failed to process voice recording',
            indicator: 'red'
        });
    };

    reader.readAsDataURL(audioBlob);
};

// ============================================================================
// ENHANCED MESSAGE DISPLAY WITH MEDIA
// ============================================================================

whatsapp.chat.Widget.prototype.add_message_with_media = function (text, type, time, media, mediaType) {
    time = time || null;
    media = media || null;
    mediaType = mediaType || null;

    const container = $('#waMessages');
    const display_time = time ? moment(time).format('HH:mm') : moment().format('HH:mm');

    let safe_text = this.escape_html(text || '');
    let content = safe_text;

    if (media) {
        const safe_media = this.escape_html(media);

        // Determine media type from URL or explicit type
        const isImage = media.match(/\.(jpg|jpeg|png|gif|webp)$/i) || mediaType === 'image';
        const isVideo = media.match(/\.(mp4|webm|avi|mov)$/i) || mediaType === 'video';
        const isAudio = media.match(/\.(mp3|ogg|wav|m4a|webm)$/i) || mediaType === 'audio';
        const isPDF = media.match(/\.pdf$/i) || mediaType === 'pdf';

        if (isImage) {
            content = `
                <div class="wa-media-container">
                    <img src="${safe_media}"
                         style="max-width:100%; max-height:300px; border-radius:8px; cursor:pointer; display:block;"
                         onclick="window.open('${safe_media}')"
                         loading="lazy">
                    ${safe_text ? '<div class="wa-media-caption">' + safe_text + '</div>' : ''}
                </div>
            `;
        } else if (isVideo) {
            content = `
                <div class="wa-media-container">
                    <video controls style="max-width:100%; max-height:300px; border-radius:8px; display:block;">
                        <source src="${safe_media}" type="video/mp4">
                        Your browser does not support video playback.
                    </video>
                    ${safe_text ? '<div class="wa-media-caption">' + safe_text + '</div>' : ''}
                </div>
            `;
        } else if (isAudio) {
            content = `
                <div class="wa-media-container">
                    <div style="background:#f0f0f0; padding:10px; border-radius:8px; display:inline-block;">
                        <audio controls style="width:250px; max-width:100%;">
                            <source src="${safe_media}" type="audio/mpeg">
                            Your browser does not support audio playback.
                        </audio>
                    </div>
                    ${safe_text ? '<div class="wa-media-caption">' + safe_text + '</div>' : ''}
                </div>
            `;
        } else {
            // Document/file
            const icon = isPDF ? 'fa-file-pdf-o' : 'fa-file';
            const color = isPDF ? '#dc3545' : '#007bff';
            content = `
                <div class="wa-media-container wa-document">
                    <a href="${safe_media}" target="_blank" style="text-decoration:none; color:${color}; display:flex; align-items:center; padding:10px; background:#f8f9fa; border-radius:8px;">
                        <i class="fa ${icon}" style="font-size:32px; margin-right:12px;"></i>
                        <div>
                            <div style="font-weight:600;">${safe_text}</div>
                            <div style="font-size:11px; color:#6c757d;">Click to download</div>
                        </div>
                    </a>
                </div>
            `;
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
};

// ============================================================================
// CALLING FUNCTIONALITY
// ============================================================================

whatsapp.chat.Widget.prototype.init_call_overlay = function (type) {
    const self = this;
    const name = $('#waHeaderTitle').text();
    const avatar = name[0].toUpperCase();
    const phone = self.active_number.replace(/[+\-\s]/g, '');

    // Note: WhatsApp Web API doesn't support initiating calls
    // We provide three options: WhatsApp App, Phone Dialer, or WhatsApp Web

    // Create overlay if not exists
    if (!$('#waCallOverlay').length) {
        const overlayHtml = `
            <div class="wa-call-overlay" id="waCallOverlay">
                <div class="wa-call-container">
                    <div class="wa-call-avatar" id="waCallAvatar">${avatar}</div>
                    <div class="wa-call-name" id="waCallName">${name}</div>
                    <div class="wa-call-status" id="waCallStatus" style="margin-bottom:20px;">Choose how to call:</div>
                    <div class="wa-call-buttons" style="flex-direction:column; gap:10px;">
                        <button class="wa-call-btn whatsapp-app" id="waCallWhatsApp"
                                title="Open WhatsApp App (Mobile)"
                                style="width:100%; background:#25D366; padding:12px;">
                            <i class="fa fa-whatsapp"></i> Open in WhatsApp
                        </button>
                        <button class="wa-call-btn phone-dialer" id="waCallPhone"
                                title="Use Phone Dialer"
                                style="width:100%; background:#34B7F1; padding:12px;">
                            <i class="fa fa-phone"></i> Use Phone Dialer
                        </button>
                        <button class="wa-call-btn cancel" id="waCallCancel"
                                title="Cancel"
                                style="width:100%; background:#dc3545; padding:12px;">
                            <i class="fa fa-times"></i> Cancel
                        </button>
                    </div>
                    <div style="font-size:11px; color:#888; margin-top:15px; text-align:center;">
                        Note: Direct calling from web is not supported by WhatsApp
                    </div>
                </div>
            </div>
        `;
        $('body').append(overlayHtml);

        // WhatsApp App option
        $('#waCallWhatsApp').on('click', function () {
            // Opens WhatsApp app/web where user can manually initiate call
            window.open(`https://wa.me/${phone}`, '_blank');
            $('#waCallOverlay').removeClass('active');
            frappe.show_alert({
                message: 'WhatsApp opened. Click the call button in WhatsApp to start the call.',
                indicator: 'blue'
            });
        });

        // Phone Dialer option
        $('#waCallPhone').on('click', function () {
            // Opens native phone dialer
            window.location.href = `tel:+${phone}`;
            $('#waCallOverlay').removeClass('active');
        });

        // Cancel option
        $('#waCallCancel').on('click', function () {
            $('#waCallOverlay').removeClass('active');
        });
    } else {
        $('#waCallName').text(name);
        $('#waCallAvatar').text(avatar);
    }

    // Show overlay
    $('#waCallOverlay').addClass('active');
    const callTypeText = type === 'video' ? 'Video Call' : 'Voice Call';
    $('#waCallStatus').html(`Choose how to ${callTypeText}:`);
};

// Initialize media features when widget is ready
$(document).on('app_ready', function () {
    setTimeout(function () {
        if (window.whatsapp_widget) {
            window.whatsapp_widget.init_media_upload();
            window.whatsapp_widget.init_voice_recording();
        }
    }, 1000);
});
