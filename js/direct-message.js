const DM_PAGE_SIZE = 25;
const DM_REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

let directMessageChannel = null;
let directMessageReactionChannel = null;
let directMessageTypingChannel = null;
let activeDirectMessageContactId = null;
let activeDirectMessageProfile = null;
let activeDirectMessageConversationKey = null;
let directMessageOldestAt = null;
let directMessageHasMore = false;
let directMessageTypingSendTimer = null;
let directMessageTypingIdleTimer = null;
let directMessageTypingVisibleTimer = null;
let directMessageTypingSentOn = false;
let directMessageReactionMenuEl = null;

function applyDirectMessageHeader(displayName, avatarUrl) {
    const header = document.querySelector('.header');
    const userDisplay = document.getElementById('userDisplay');
    if (!header || !userDisplay) return;

    header.classList.add('dm-header');
    const safeName = displayName || 'Contact';
    const initial = safeName.trim().charAt(0).toUpperCase() || '?';
    const avatarHtml = avatarUrl
        ? `<img class="dm-header-avatar" src="${esc(avatarUrl)}" alt="">`
        : `<span class="dm-header-avatar dm-header-avatar-fallback">${esc(initial)}</span>`;
    userDisplay.innerHTML = `<span class="dm-header-title-wrap">${avatarHtml}<span class="dm-header-title-text">${esc(safeName)}</span></span>`;

    let backBtn = document.getElementById('dmHeaderBackBtn');
    if (!backBtn) {
        backBtn = document.createElement('button');
        backBtn.id = 'dmHeaderBackBtn';
        backBtn.type = 'button';
        backBtn.className = 'dm-header-back-btn';
        backBtn.setAttribute('aria-label', 'Back');
        backBtn.setAttribute('onclick', 'closeDirectMessageScreen()');
        backBtn.innerHTML = '<i data-lucide="chevron-left" aria-hidden="true"></i><span>Back</span>';
        header.appendChild(backBtn);
    }
    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
}

function resetDirectMessageHeader() {
    const header = document.querySelector('.header');
    const userDisplay = document.getElementById('userDisplay');
    const backBtn = document.getElementById('dmHeaderBackBtn');
    if (backBtn) backBtn.remove();
    if (header) header.classList.remove('dm-header');
    if (userDisplay) {
        userDisplay.textContent = APP_NAME;
    }
}

function getDmConversationKey(userA, userB) {
    if (!userA || !userB) return '';
    return [userA, userB].sort().join(':');
}

function openDirectMessageScreen(contactId) {
    if (!contactId) return;
    navigateTo('directMessage', contactId);
}

function closeDirectMessageScreen() {
    hideDirectMessageReactionMenu();
    stopDirectMessageTyping();
    const backId = activeDirectMessageContactId;
    activeDirectMessageContactId = null;
    activeDirectMessageProfile = null;
    activeDirectMessageConversationKey = null;
    if (backId) navigateTo('contactDetails', backId);
    else navigateTo('contacts');
}

async function renderDirectMessageScreen(contactId) {
    const screen = document.getElementById('directMessageScreen');
    if (!screen || !contactId || !currentUser) return;

    activeDirectMessageContactId = contactId;
    activeDirectMessageConversationKey = getDmConversationKey(currentUser.id, contactId);
    directMessageOldestAt = null;
    directMessageHasMore = false;
    hideDirectMessageReactionMenu();
    clearDirectMessageTypingIndicator();

    activeDirectMessageProfile = await loadDirectMessageProfile(contactId);
    const displayName = activeDirectMessageProfile?.display_name || 'Contact';
    applyDirectMessageHeader(displayName, activeDirectMessageProfile?.profile_image_url || null);

    screen.innerHTML = `
        <div class="dm-screen-shell">
            <div class="chat-container dm-chat-container">
                <div class="chat-load-more" id="dmLoadMore" style="display:none;">
                    <button class="btn btn-secondary btn-small" onclick="loadOlderDirectMessages()">Load older messages…</button>
                </div>
                <div class="chat-messages dm-chat-messages" id="dmMessages">
                    <p style="color:var(--dark-gray);text-align:center;padding:2rem 0;">Loading…</p>
                </div>
                <div class="dm-typing-indicator" id="dmTypingIndicator" hidden>${esc(displayName)} is typing…</div>
                <div class="chat-input-bar dm-input-bar">
                    <input type="text" id="dmInput" placeholder="Type a message…" maxlength="2000"
                           oninput="onDirectMessageInputChange()"
                           onkeydown="onDirectMessageInputKeydown(event)"
                           onfocus="onDirectMessageInputFocus()"
                           onblur="onDirectMessageInputBlur()">
                    <button class="btn-icon chat-image-btn" onclick="openDirectChatPhotoPicker()" title="Send photo" type="button">
                        <i data-lucide="image" aria-hidden="true"></i>
                    </button>
                    <button class="btn-icon chat-map-btn" onclick="openDirectMessageMapPicker()" title="Share location" type="button">
                        <i data-lucide="map-pin" aria-hidden="true"></i>
                    </button>
                    <button class="btn btn-primary" onclick="sendDirectMessage()">Send</button>
                </div>
            </div>
        </div>
    `;
    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();

    await buildDirectMessageProfileCache(contactId);

    const msgsEl = document.getElementById('dmMessages');
    if (msgsEl) msgsEl.innerHTML = '';
    await loadDirectMessages();
    bindDirectMessageSubscriptions();
}

async function loadDirectMessageProfile(contactId) {
    const row = (contactsLoadedRows || []).find((r) => r.contact?.contact_id === contactId);
    if (row?.profile) return row.profile;
    const { data } = await db.from('profiles')
        .select('id, display_name, profile_image_url')
        .eq('id', contactId)
        .maybeSingle();
    return data || null;
}

async function buildDirectMessageProfileCache(contactId) {
    if (currentProfile && currentUser?.id) {
        profileCache[currentUser.id] = {
            name: currentProfile.display_name,
            avatar: currentProfile.profile_image_url || null
        };
    }
    const profile = activeDirectMessageProfile || await loadDirectMessageProfile(contactId);
    if (profile?.id) {
        profileCache[profile.id] = {
            name: profile.display_name,
            avatar: profile.profile_image_url || null
        };
    }
}

async function loadDirectMessages(beforeIso) {
    if (!activeDirectMessageConversationKey) return;

    let query = db.from('direct_messages')
        .select('*')
        .eq('conversation_key', activeDirectMessageConversationKey)
        .order('created_at', { ascending: false })
        .limit(DM_PAGE_SIZE);
    if (beforeIso) query = query.lt('created_at', beforeIso);

    const { data, error } = await query;
    if (error) {
        showToast('Could not load messages.', 'error');
        return;
    }

    const msgsEl = document.getElementById('dmMessages');
    const loadMoreEl = document.getElementById('dmLoadMore');
    if (!msgsEl) return;

    const messages = (data || [])
        .filter((m) => typeof isUserBlocked !== 'function' || !isUserBlocked(m.from_user_id))
        .reverse();

    if (!messages.length && !beforeIso) {
        msgsEl.innerHTML = '<p style="color:var(--dark-gray);text-align:center;padding:2rem 0;">No messages yet. Start the conversation!</p>';
    } else if (messages.length) {
        const prevHeight = msgsEl.scrollHeight;
        const fragment = document.createDocumentFragment();
        for (const msg of messages) {
            fragment.appendChild(await createDirectMessageElement(msg));
        }
        if (beforeIso) {
            msgsEl.insertBefore(fragment, msgsEl.firstChild);
            msgsEl.scrollTop = msgsEl.scrollHeight - prevHeight;
        } else {
            msgsEl.appendChild(fragment);
            scrollDirectMessagesToBottom();
        }
        await hydrateDirectMessageReactions(messages.map((m) => m.id));
    }

    directMessageHasMore = (data || []).length === DM_PAGE_SIZE;
    if (loadMoreEl) {
        loadMoreEl.style.display = directMessageHasMore ? 'block' : 'none';
    }
    if (messages.length) {
        directMessageOldestAt = messages[0].created_at;
    }
    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
}

async function loadOlderDirectMessages() {
    if (!directMessageOldestAt || !directMessageHasMore) return;
    await loadDirectMessages(directMessageOldestAt);
}

async function createDirectMessageElement(msg) {
    const isMine = msg.from_user_id === currentUser?.id;
    const senderId = msg.from_user_id;
    const loc = parseLocationBody(msg.body);
    const img = parseImageBody(msg.body);
    const bubbleContent = img ? '<div class="chat-image-wrap"></div>'
        : loc ? '<div class="chat-location-wrap"></div>'
        : esc(msg.body);
    const time = formatDirectMessageTime(msg.created_at);
    const reportBtnHtml = !isMine
        ? `<button type="button" class="chat-msg-report"
                   title="Report this message"
                   aria-label="Report this message"
                   onclick="onReportDirectMessage('${esc(msg.id)}', '${esc(senderId)}')">\u22EE</button>`
        : '';

    const div = document.createElement('div');
    div.classList.add('chat-msg');
    if (isMine) div.classList.add('chat-msg-mine');
    div.dataset.msgId = msg.id;

    if (isMine) {
        div.innerHTML = `
            <div class="chat-bubble dm-reactable-bubble" onclick="openDirectMessageReactionMenu(event, '${esc(msg.id)}')">${bubbleContent}</div>
            <div class="chat-msg-time">${esc(time)}</div>
            <div class="dm-reactions" id="dm-reactions-${esc(msg.id)}"></div>
        `;
    } else {
        div.innerHTML = `
            <div class="chat-bubble dm-reactable-bubble" onclick="openDirectMessageReactionMenu(event, '${esc(msg.id)}')">${bubbleContent}</div>
            <div class="dm-msg-meta-row">
                <div class="chat-msg-time">${esc(time)}</div>
                ${reportBtnHtml}
            </div>
            <div class="dm-reactions" id="dm-reactions-${esc(msg.id)}"></div>
        `;
    }

    const bubble = div.querySelector('.chat-bubble');
    if (img && bubble) {
        bubble.classList.add('chat-bubble-image');
        const wrap = div.querySelector('.chat-image-wrap');
        if (wrap) renderChatImagePreview(wrap, img.url);
    } else if (loc) {
        if (bubble) bubble.classList.add('chat-bubble-location');
        const wrap = div.querySelector('.chat-location-wrap');
        if (wrap) renderLocationPreview(wrap, loc.lat, loc.lng, loc.radius);
    }
    return div;
}

function formatDirectMessageTime(iso) {
    const date = new Date(iso);
    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    const t = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return t;
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + t;
}

function appendDirectMessage(msg, forceScroll) {
    const msgsEl = document.getElementById('dmMessages');
    if (!msgsEl) return;
    if (msgsEl.querySelector(`[data-msg-id="${msg.id}"]`)) return;

    const placeholder = msgsEl.querySelector('p');
    if (placeholder && placeholder.textContent.includes('No messages')) placeholder.remove();

    const atBottom = forceScroll || (msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 60);
    createDirectMessageElement(msg).then(async (el) => {
        msgsEl.appendChild(el);
        await hydrateDirectMessageReactions([msg.id]);
        if (atBottom) scrollDirectMessagesToBottom();
        if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
    });
}

function scrollDirectMessagesToBottom() {
    const msgsEl = document.getElementById('dmMessages');
    if (!msgsEl) return;
    const go = () => { msgsEl.scrollTop = msgsEl.scrollHeight; };
    go();
    requestAnimationFrame(go);
    setTimeout(go, 50);
    setTimeout(go, 150);
}

async function sendDirectMessage() {
    const input = document.getElementById('dmInput');
    if (!input || !activeDirectMessageContactId || !currentUser) return;
    const body = input.value.trim();
    if (!body) return;

    input.disabled = true;
    const { data: msg, error } = await db.from('direct_messages').insert({
        conversation_key: activeDirectMessageConversationKey,
        from_user_id: currentUser.id,
        to_user_id: activeDirectMessageContactId,
        body: body
    }).select().single();
    input.disabled = false;

    if (error) {
        showToast('Failed to send message: ' + error.message, 'error');
        return;
    }
    input.value = '';
    stopDirectMessageTyping();
    if (msg) appendDirectMessage(msg, true);
}

async function sendDirectLocationMessage(lat, lng, radius) {
    if (!activeDirectMessageContactId || !currentUser) return;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        showToast('Location unavailable. Please retry after location permission is granted.', 'error');
        return;
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        showToast('Invalid location. Please pick a valid point on the map.', 'error');
        return;
    }
    const body = `📍location:${lat.toFixed(6)},${lng.toFixed(6)},${Math.round(radius)}`;
    const { data: msg, error } = await db.from('direct_messages').insert({
        conversation_key: activeDirectMessageConversationKey,
        from_user_id: currentUser.id,
        to_user_id: activeDirectMessageContactId,
        body: body
    }).select().single();
    if (error) {
        showToast('Failed to send location: ' + error.message, 'error');
        return;
    }
    if (msg) appendDirectMessage(msg, true);
}

function onDirectMessageInputKeydown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendDirectMessage();
    }
}

function onDirectMessageInputFocus() {
    document.body.classList.add('chat-keyboard-open');
}

function onDirectMessageInputBlur() {
    setTimeout(() => {
        const input = document.getElementById('dmInput');
        if (input && document.activeElement === input) return;
        document.body.classList.remove('chat-keyboard-open');
        stopDirectMessageTyping();
    }, 150);
}

function onDirectMessageInputChange() {
    if (!activeDirectMessageContactId || !currentUser) return;
    queueDirectMessageTyping(true);
    if (directMessageTypingIdleTimer) clearTimeout(directMessageTypingIdleTimer);
    directMessageTypingIdleTimer = setTimeout(() => {
        stopDirectMessageTyping();
    }, 2200);
}

function queueDirectMessageTyping(isTyping) {
    if (!activeDirectMessageContactId || !currentUser) return;
    if (directMessageTypingSendTimer) clearTimeout(directMessageTypingSendTimer);
    directMessageTypingSendTimer = setTimeout(() => {
        directMessageTypingSendTimer = null;
        upsertDirectMessageTyping(isTyping);
    }, isTyping ? 120 : 0);
}

async function upsertDirectMessageTyping(isTyping) {
    if (!activeDirectMessageContactId || !currentUser) return;
    if (isTyping && directMessageTypingSentOn) return;
    directMessageTypingSentOn = !!isTyping;
    await db.from('direct_message_typing').upsert({
        user_id: currentUser.id,
        peer_user_id: activeDirectMessageContactId,
        is_typing: !!isTyping,
        updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,peer_user_id' });
}

function stopDirectMessageTyping() {
    if (directMessageTypingIdleTimer) {
        clearTimeout(directMessageTypingIdleTimer);
        directMessageTypingIdleTimer = null;
    }
    queueDirectMessageTyping(false);
}

function showDirectMessageTypingIndicator() {
    const el = document.getElementById('dmTypingIndicator');
    if (!el) return;
    el.hidden = false;
    if (directMessageTypingVisibleTimer) clearTimeout(directMessageTypingVisibleTimer);
    directMessageTypingVisibleTimer = setTimeout(() => {
        clearDirectMessageTypingIndicator();
    }, 4500);
}

function clearDirectMessageTypingIndicator() {
    const el = document.getElementById('dmTypingIndicator');
    if (el) el.hidden = true;
    if (directMessageTypingVisibleTimer) {
        clearTimeout(directMessageTypingVisibleTimer);
        directMessageTypingVisibleTimer = null;
    }
}

async function hydrateDirectMessageReactions(messageIds) {
    const ids = (messageIds || []).filter(Boolean);
    if (!ids.length) return;
    const { data, error } = await db.from('direct_message_reactions')
        .select('message_id, user_id, emoji')
        .in('message_id', ids);
    if (error) return;
    const grouped = {};
    (data || []).forEach((r) => {
        if (!grouped[r.message_id]) grouped[r.message_id] = [];
        grouped[r.message_id].push(r);
    });
    ids.forEach((id) => renderDirectMessageReactions(id, grouped[id] || []));
}

function renderDirectMessageReactions(messageId, rows) {
    const slot = document.getElementById('dm-reactions-' + messageId);
    if (!slot) return;
    if (!rows || !rows.length) {
        slot.innerHTML = '';
        return;
    }
    const counts = new Map();
    rows.forEach((r) => {
        const key = r.emoji || '';
        if (!key) return;
        if (!counts.has(key)) counts.set(key, { emoji: key, count: 0, mine: false });
        const item = counts.get(key);
        item.count += 1;
        if (r.user_id === currentUser?.id) item.mine = true;
    });
    slot.innerHTML = Array.from(counts.values())
        .map((item) => `<button type="button" class="dm-reaction-chip${item.mine ? ' dm-reaction-chip-mine' : ''}" onclick="onDirectMessageReactionChipClick('${esc(messageId)}','${esc(item.emoji)}')">${esc(item.emoji)} <span>${item.count}</span></button>`)
        .join('');
}

async function onDirectMessageReactionChipClick(messageId, emoji) {
    if (!messageId || !emoji || !currentUser) return;
    const { data } = await db.from('direct_message_reactions')
        .select('emoji')
        .eq('message_id', messageId)
        .eq('user_id', currentUser.id)
        .maybeSingle();
    if (data?.emoji === emoji) {
        await db.from('direct_message_reactions')
            .delete()
            .eq('message_id', messageId)
            .eq('user_id', currentUser.id);
    } else {
        await db.from('direct_message_reactions').upsert({
            message_id: messageId,
            user_id: currentUser.id,
            emoji: emoji
        }, { onConflict: 'message_id,user_id' });
    }
    await hydrateDirectMessageReactions([messageId]);
}

function openDirectMessageReactionMenu(event, messageId) {
    event.preventDefault();
    event.stopPropagation();
    if (!messageId) return;
    hideDirectMessageReactionMenu();
    const bubble = event.currentTarget;
    if (!bubble) return;

    const rect = bubble.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'dm-reaction-menu';
    menu.innerHTML = DM_REACTION_EMOJIS
        .map((emoji) => `<button type="button" class="dm-reaction-option" data-emoji="${esc(emoji)}">${esc(emoji)}</button>`)
        .join('');
    document.body.appendChild(menu);

    const menuRect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - menuRect.width - 8, rect.left));
    let top = rect.top - menuRect.height - 8;
    if (top < 8) top = rect.bottom + 8;
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';

    menu.querySelectorAll('.dm-reaction-option').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const emoji = btn.dataset.emoji;
            hideDirectMessageReactionMenu();
            if (!emoji) return;
            await onDirectMessageReactionChipClick(messageId, emoji);
        });
    });
    setTimeout(() => {
        document.addEventListener('click', hideDirectMessageReactionMenuOnce, { once: true });
    }, 0);
    directMessageReactionMenuEl = menu;
}

function hideDirectMessageReactionMenuOnce() {
    hideDirectMessageReactionMenu();
}

function hideDirectMessageReactionMenu() {
    if (!directMessageReactionMenuEl) return;
    directMessageReactionMenuEl.remove();
    directMessageReactionMenuEl = null;
}

function onReportDirectMessage(messageId, userId) {
    if (typeof openReportDialog !== 'function') return;
    openReportDialog({
        userId: userId,
        contentType: 'chat_message',
        contentId: messageId,
        contextLabel: 'message'
    });
}

function unbindDirectMessageSubscriptions() {
    if (directMessageReactionChannel) {
        db.removeChannel(directMessageReactionChannel);
        directMessageReactionChannel = null;
    }
    if (directMessageTypingChannel) {
        db.removeChannel(directMessageTypingChannel);
        directMessageTypingChannel = null;
    }
}

function bindDirectMessageSubscriptions() {
    unbindDirectMessageSubscriptions();
    if (!currentUser || !activeDirectMessageContactId) return;

    directMessageReactionChannel = db.channel('direct-message-reactions-' + currentUser.id)
        .on('postgres_changes', {
            event: '*',
            schema: 'public',
            table: 'direct_message_reactions'
        }, async (payload) => {
            const msgId = payload.new?.message_id || payload.old?.message_id;
            if (!msgId) return;
            const msgEl = document.querySelector(`#dmMessages [data-msg-id="${msgId}"]`);
            if (!msgEl) return;
            await hydrateDirectMessageReactions([msgId]);
        })
        .subscribe();

    directMessageTypingChannel = db.channel('direct-message-typing-' + currentUser.id)
        .on('postgres_changes', {
            event: '*',
            schema: 'public',
            table: 'direct_message_typing',
            filter: 'peer_user_id=eq.' + currentUser.id
        }, (payload) => {
            const row = payload.new || payload.old;
            if (!row) return;
            if (row.user_id !== activeDirectMessageContactId) return;
            if (row.is_typing) showDirectMessageTypingIndicator();
            else clearDirectMessageTypingIndicator();
        })
        .subscribe();
}

function subscribeToDirectMessages() {
    if (directMessageChannel) {
        db.removeChannel(directMessageChannel);
        directMessageChannel = null;
    }
    if (!currentUser) return;

    directMessageChannel = db.channel('direct-messages-' + currentUser.id)
        .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'direct_messages',
            filter: 'to_user_id=eq.' + currentUser.id
        }, async (payload) => {
            const msg = payload.new;
            if (!msg) return;
            if (typeof isUserBlocked === 'function' && isUserBlocked(msg.from_user_id)) return;

            const isOpenHere = activeMainView === 'directMessage'
                && activeDirectMessageContactId === msg.from_user_id;
            if (isOpenHere) {
                appendDirectMessage(msg);
                return;
            }
            const name = await getDisplayName(msg.from_user_id);
            const preview = msg.body.length > 80 ? msg.body.slice(0, 80) + '…' : msg.body;
            showToast(`💬 ${name}: ${preview}`, 'info');
        })
        .subscribe();
}

async function openPendingDirectMessageIfAny() {
    if (!pendingOpenDmContactId) return;
    const cid = pendingOpenDmContactId;
    pendingOpenDmContactId = null;
    if (typeof openContactDetailsById === 'function') {
        await openContactDetailsById(cid);
    }
    openDirectMessageScreen(cid);
}

function teardownDirectMessageView() {
    hideDirectMessageReactionMenu();
    stopDirectMessageTyping();
    clearDirectMessageTypingIndicator();
    unbindDirectMessageSubscriptions();
    resetDirectMessageHeader();
    activeDirectMessageContactId = null;
    activeDirectMessageProfile = null;
    activeDirectMessageConversationKey = null;
    directMessageTypingSentOn = false;
    document.body.classList.remove('chat-keyboard-open');
}

function openDirectMessageMapPicker() {
    if (!activeDirectMessageContactId || !currentUser) return;

    const overlay = document.createElement('div');
    overlay.className = 'map-picker-overlay';
    overlay.innerHTML = `
        <div class="map-picker-modal">
            <div class="map-picker-header">
                <h3>Share Location</h3>
                <span class="map-picker-radius" id="dmMapPickerRadius">Radius: ${formatRadius(DEFAULT_RADIUS)}</span>
            </div>
            <div id="dmMapPickerMap" class="map-picker-map"></div>
            <div class="map-picker-actions">
                <button class="btn btn-secondary" id="dmMapPickerCancel">Cancel</button>
                <button class="btn btn-primary" id="dmMapPickerSend">Send Location</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const mapEl = document.getElementById('dmMapPickerMap');
    const radiusLabel = document.getElementById('dmMapPickerRadius');

    const map = L.map(mapEl, {
        zoomControl: true,
        attributionControl: false
    }).setView([0, 0], 2);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        maxZoom: 20,
        subdomains: 'abcd'
    }).addTo(map);

    let currentLat = null;
    let currentLng = null;
    let currentRadius = DEFAULT_RADIUS;
    let marker = null;
    let circle = null;
    const sendBtn = document.getElementById('dmMapPickerSend');

    function setSendEnabled(enabled) {
        if (!sendBtn) return;
        sendBtn.disabled = !enabled;
    }

    function initMapAt(lat, lng) {
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
        currentLat = lat;
        currentLng = lng;
        map.setView([lat, lng], 15);

        circle = L.circle([lat, lng], {
            radius: currentRadius,
            color: '#3a7ca5',
            fillColor: '#3a7ca5',
            fillOpacity: 0.15,
            weight: 2
        }).addTo(map);
        marker = L.marker([lat, lng], { draggable: true }).addTo(map);

        marker.on('drag', function () {
            const pos = marker.getLatLng();
            currentLat = pos.lat;
            currentLng = pos.lng;
            circle.setLatLng(pos);
        });
        map.on('click', function (e) {
            if (!marker || !circle || currentLat == null || currentLng == null) return;
            const center = L.latLng(currentLat, currentLng);
            const dist = center.distanceTo(e.latlng);
            const clamped = Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, dist));
            currentRadius = clamped;
            circle.setRadius(clamped);
            radiusLabel.textContent = 'Radius: ' + formatRadius(clamped);
        });
        setSendEnabled(true);
    }

    setSendEnabled(false);
    getGPSLocation().then((pos) => {
        if (pos) initMapAt(pos.lat, pos.lng);
        else showToast('Could not get GPS location yet. Try again when location permission is enabled.', 'error');
    });

    document.getElementById('dmMapPickerCancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.getElementById('dmMapPickerSend').addEventListener('click', () => {
        if (!Number.isFinite(currentLat) || !Number.isFinite(currentLng)) {
            showToast('Waiting for your location fix. Please try again in a moment.', 'error');
            return;
        }
        sendDirectLocationMessage(currentLat, currentLng, currentRadius);
        overlay.remove();
    });
    setTimeout(() => map.invalidateSize(), APP_TIMING.MAP_INVALIDATE_SHORT_MS);
}
