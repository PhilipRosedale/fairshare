const CHAT_PAGE_SIZE = 25;

/** Bottom Y of the visible layout viewport (accounts for on-screen keyboard on Android WebView). */
function getVisibleViewportBottom() {
    if (window.visualViewport) {
        return window.visualViewport.offsetTop + window.visualViewport.height;
    }
    return window.innerHeight;
}

let _chatLayoutTimer = null;
let _chatViewportCleanup = null;
let _chatInputCleanup = null;
let _chatKeyboardBaseline = null;
let _cachedBottomBarHeight = 0;

function scheduleLayoutChatPanel() {
    clearTimeout(_chatLayoutTimer);
    _chatLayoutTimer = setTimeout(() => {
        _chatLayoutTimer = null;
        layoutChatPanel();
    }, 80);
}

function unbindChatViewportListeners() {
    if (typeof _chatViewportCleanup === 'function') {
        _chatViewportCleanup();
        _chatViewportCleanup = null;
    }
}

function unbindChatInputListeners() {
    if (typeof _chatInputCleanup === 'function') {
        _chatInputCleanup();
        _chatInputCleanup = null;
    }
}

function bindChatViewportListeners() {
    unbindChatViewportListeners();
    const onLayout = () => {
        if (activeTab === 'chat') scheduleLayoutChatPanel();
    };
    window.addEventListener('resize', onLayout);
    const vv = window.visualViewport;
    if (vv) {
        vv.addEventListener('resize', onLayout);
        vv.addEventListener('scroll', onLayout);
    }
    _chatViewportCleanup = () => {
        window.removeEventListener('resize', onLayout);
        if (vv) {
            vv.removeEventListener('resize', onLayout);
            vv.removeEventListener('scroll', onLayout);
        }
    };
}

function bindChatInputListeners() {
    unbindChatInputListeners();
    const input = document.getElementById('chatInput');
    if (!input) return;
    const onFocus = () => onChatInputFocus();
    const onBlur = () => onChatInputBlur();
    input.addEventListener('focus', onFocus);
    input.addEventListener('blur', onBlur);
    _chatInputCleanup = () => {
        input.removeEventListener('focus', onFocus);
        input.removeEventListener('blur', onBlur);
    };
}

function setChatKeyboardOpen(open) {
    document.body.classList.toggle('chat-keyboard-open', !!open);
    if (!open) _chatKeyboardBaseline = null;
}

function onChatInputFocus() {
    _chatKeyboardBaseline = window.innerHeight;
    setChatKeyboardOpen(true);
    scheduleLayoutChatPanel();
}

function onChatInputBlur() {
    setTimeout(() => {
        const input = document.getElementById('chatInput');
        if (input && document.activeElement === input) return;
        setChatKeyboardOpen(false);
        scheduleLayoutChatPanel();
    }, 150);
}

async function renderChatTab() {
    if (!selectedGroup) return;
    unbindChatViewportListeners();
    unbindChatInputListeners();
    setChatKeyboardOpen(false);
    const content = document.getElementById('tabContent');

    content.innerHTML = `
        <div class="chat-container" id="chatContainer">
            <div class="chat-load-more" id="chatLoadMore" style="display:none;">
                <button class="btn btn-secondary btn-small" onclick="loadOlderMessages()">Load older messages…</button>
            </div>
            <div class="chat-messages" id="chatMessages">
                <p style="color:var(--dark-gray);text-align:center;padding:2rem 0;">Loading…</p>
            </div>
            <div class="chat-input-bar">
                <input type="text" id="chatInput" placeholder="Type a message…" maxlength="2000"
                       onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendChatMessage();}">
                <button class="btn-icon chat-image-btn" onclick="openGroupChatPhotoPicker()" title="Send photo" type="button">
                    <i data-lucide="image" aria-hidden="true"></i>
                </button>
                <button class="btn-icon chat-map-btn" onclick="openMapPicker()" title="Share location" type="button">
                    <i data-lucide="map-pin" aria-hidden="true"></i>
                </button>
                <button class="btn btn-primary" onclick="sendChatMessage()">Send</button>
            </div>
        </div>
    `;

    bindChatViewportListeners();
    bindChatInputListeners();
    layoutChatPanel();
    requestAnimationFrame(() => scheduleLayoutChatPanel());

    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();

    // Build profile cache from current members
    await buildProfileCache();

    // Load initial messages
    const msgsEl = document.getElementById('chatMessages');
    msgsEl.innerHTML = '';
    await loadChatMessages();
    scheduleLayoutChatPanel();
}

function getBottomBarHeightFallback() {
    const style = getComputedStyle(document.documentElement);
    const safe = parseFloat(style.getPropertyValue('--app-chrome-bottom-safe')) || 0;
    return 62 + safe;
}

function getBottomBarHeight() {
    const bar = document.getElementById('bottomBar');
    if (bar) {
        const h = bar.getBoundingClientRect().height;
        if (h > 0) {
            _cachedBottomBarHeight = h;
            return h;
        }
    }
    if (_cachedBottomBarHeight > 0) return _cachedBottomBarHeight;
    return getBottomBarHeightFallback();
}

/** Pixels of the layout viewport covered by the on-screen keyboard (iOS/Android). */
function getKeyboardObscuredHeight() {
    if (!window.visualViewport) return 0;
    const vv = window.visualViewport;
    return Math.max(0, window.innerHeight - (vv.offsetTop + vv.height));
}

function isChatKeyboardOpen() {
    return document.body.classList.contains('chat-keyboard-open');
}

/** Bottom offset for the fixed chat input bar (above nav or above keyboard). */
function getChatInputBottomInset(bottomBarH) {
    const chromeH = bottomBarH || getBottomBarHeight();
    if (!isChatKeyboardOpen()) return chromeH;

    const baseline = _chatKeyboardBaseline || window.innerHeight;
    const viewportShrunk = window.innerHeight < baseline - 50;
    const vv = window.visualViewport;

    if (vv) {
        const obscured = getKeyboardObscuredHeight();
        if (obscured >= 50) return obscured;

        if (viewportShrunk && Math.abs(window.innerHeight - vv.height) < 80 && vv.offsetTop < 80) {
            return 0;
        }
    }

    if (_chatKeyboardBaseline && !viewportShrunk) {
        const shrink = _chatKeyboardBaseline - window.innerHeight;
        if (shrink >= 50) return shrink;
    }

    if (viewportShrunk) return 0;

    return chromeH;
}

/** Pin the input bar above the bottom nav, or flush above the keyboard when it is open. */
function layoutChatInputBar(bottomBarH) {
    const inputBar = document.querySelector('.chat-input-bar');
    if (!inputBar) return;
    inputBar.style.bottom = `${getChatInputBottomInset(bottomBarH)}px`;
}

/** Size the scroll area to the gap between message list top and input bar top. */
function layoutChatMessagesScrollArea() {
    const msgsEl = document.getElementById('chatMessages');
    const inputBar = document.querySelector('.chat-input-bar');
    if (!msgsEl || !inputBar) return;

    const msgsTop = msgsEl.getBoundingClientRect().top;
    const inputTop = inputBar.getBoundingClientRect().top;
    const h = Math.floor(inputTop - msgsTop);
    if (h > 0) {
        msgsEl.style.flex = 'none';
        msgsEl.style.height = `${h}px`;
        msgsEl.style.maxHeight = `${h}px`;
    }
}

function scrollChatToBottom() {
    const msgsEl = document.getElementById('chatMessages');
    if (!msgsEl) return;
    const go = () => { msgsEl.scrollTop = msgsEl.scrollHeight; };
    go();
    requestAnimationFrame(go);
    // iOS keyboard dismiss / layout pass
    setTimeout(go, 50);
    setTimeout(go, 150);
}

function resetChatLayoutStyles() {
    unbindChatInputListeners();
    unbindChatViewportListeners();
    setChatKeyboardOpen(false);
    document.body.classList.remove('chat-tab-active');
    const main = document.querySelector('.main-content');
    if (main) {
        main.style.height = '';
        main.style.overflow = '';
    }
    const inputBar = document.querySelector('.chat-input-bar');
    const msgsEl = document.getElementById('chatMessages');
    if (inputBar) inputBar.style.bottom = '';
    if (msgsEl) {
        msgsEl.style.paddingBottom = '';
        msgsEl.style.height = '';
        msgsEl.style.maxHeight = '';
        msgsEl.style.flex = '';
    }
}

/** Re-apply chat layout after leaving and returning (e.g. Contacts → Groups). */
function restoreChatLayoutIfNeeded() {
    if (activeTab !== 'chat' || !selectedGroup) return;
    const groupView = document.getElementById('groupView');
    if (!groupView || groupView.classList.contains('hidden')) return;

    if (!document.getElementById('chatMessages')) {
        renderChatTab();
        return;
    }

    document.body.classList.add('chat-tab-active');
    bindChatViewportListeners();
    bindChatInputListeners();
    layoutChatPanel();
    requestAnimationFrame(() => scheduleLayoutChatPanel());
}

/** Fit the groups main column to the visible viewport so only .chat-messages scrolls. */
function layoutChatPanel() {
    if (activeTab !== 'chat') return;
    const main = document.querySelector('.main-content');
    const groupsContent = document.getElementById('groupsContent');
    if (!main || !groupsContent || groupsContent.classList.contains('hidden')) return;

    const bottomBarH = getBottomBarHeight();
    const top = main.getBoundingClientRect().top;
    const bottom = getVisibleViewportBottom();
    const available = bottom - top;
    main.style.height = Math.max(available, 200) + 'px';
    main.style.overflow = 'hidden';
    layoutChatInputBar(bottomBarH);
    requestAnimationFrame(() => {
        layoutChatMessagesScrollArea();
    });
}

async function buildProfileCache() {
    if (!selectedGroup) return;
    const { data } = await db
        .from('members')
        .select('user_id, profiles(display_name, profile_image_url)')
        .eq('group_id', selectedGroup.id);
    if (data) {
        data.forEach(m => {
            if (m.profiles) {
                profileCache[m.user_id] = {
                    name: m.profiles.display_name,
                    avatar: m.profiles.profile_image_url || null
                };
            }
        });
    }
    // Always include current user
    if (currentProfile && currentUser) {
        profileCache[currentUser.id] = {
            name: currentProfile.display_name,
            avatar: currentProfile.profile_image_url || null
        };
    }
}

async function getDisplayName(userId) {
    if (profileCache[userId]) return profileCache[userId].name;
    // Fetch on demand for former members
    const { data } = await db.from('profiles').select('display_name, profile_image_url').eq('id', userId).single();
    if (data) {
        profileCache[userId] = { name: data.display_name, avatar: data.profile_image_url || null };
        return data.display_name;
    }
    return 'Unknown';
}

function getAvatarUrl(userId) {
    return profileCache[userId]?.avatar || null;
}

async function loadChatMessages(before) {
    if (!selectedGroup) return;
    let query = db
        .from('chat_messages')
        .select('*')
        .eq('group_id', selectedGroup.id)
        .order('created_at', { ascending: false })
        .limit(CHAT_PAGE_SIZE);

    if (before) {
        query = query.lt('created_at', before);
    }

    const { data, error } = await query;
    if (error) { console.error('loadChatMessages error:', error); return; }

    const msgsEl = document.getElementById('chatMessages');
    const loadMoreEl = document.getElementById('chatLoadMore');
    if (!msgsEl) return;

    // Messages come newest-first; reverse so oldest is at top.
    // Drop any messages from users the current user has blocked — Apple
    // requires that blocked-user content not be visible.
    const messages = (data || [])
        .filter(m => typeof isUserBlocked !== 'function' || !isUserBlocked(m.user_id))
        .reverse();

    if (messages.length > 0) {
        // Remember scroll position to restore after prepending
        const prevScrollHeight = msgsEl.scrollHeight;

        const fragment = document.createDocumentFragment();
        for (const msg of messages) {
            fragment.appendChild(await createMessageElement(msg));
        }

        if (before) {
            // Prepending older messages — insert at top
            msgsEl.insertBefore(fragment, msgsEl.firstChild);
            // Restore scroll position so the view doesn't jump
            msgsEl.scrollTop = msgsEl.scrollHeight - prevScrollHeight;
        } else {
            // Initial load — append and scroll to bottom
            msgsEl.appendChild(fragment);
            scheduleLayoutChatPanel();
            scrollChatToBottom();
        }
    } else if (!before) {
        // No messages at all
        msgsEl.innerHTML = '<p style="color:var(--dark-gray);text-align:center;padding:2rem 0;">No messages yet. Start the conversation!</p>';
    }

    // Show/hide "Load older" button
    if (loadMoreEl) {
        loadMoreEl.style.display = (data && data.length === CHAT_PAGE_SIZE) ? 'block' : 'none';
        // Store the oldest message timestamp for next page
        if (messages.length > 0) {
            loadMoreEl.dataset.before = messages[0].created_at;
        }
    }

    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
}

async function loadOlderMessages() {
    const loadMoreEl = document.getElementById('chatLoadMore');
    if (!loadMoreEl || !loadMoreEl.dataset.before) return;
    await loadChatMessages(loadMoreEl.dataset.before);
}

async function createMessageElement(msg) {
    const isMine = msg.user_id === currentUser?.id;
    const div = document.createElement('div');
    div.classList.add('chat-msg');
    if (isMine) div.classList.add('chat-msg-mine');
    div.dataset.msgId = msg.id;

    const name = await getDisplayName(msg.user_id);
    const avatar = getAvatarUrl(msg.user_id);
    const time = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const date = new Date(msg.created_at);
    const today = new Date();
    const isToday = date.toDateString() === today.toDateString();
    const timeStr = isToday ? time : date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;

    const loc = parseLocationBody(msg.body);
    const img = parseImageBody(msg.body);
    const bubbleContent = img ? '<div class="chat-image-wrap"></div>'
        : loc ? '<div class="chat-location-wrap"></div>'
        : esc(msg.body);

    // Other people's messages get a small "Report" affordance so users
    // can flag objectionable content (Apple Guideline 1.2). Own messages
    // skip it.
    const reportBtnHtml = !isMine
        ? `<button type="button" class="chat-msg-report"
                   title="Report this message"
                   aria-label="Report this message"
                   onclick="onReportChatMessage('${esc(msg.id)}', '${esc(msg.user_id)}')">\u22EE</button>`
        : '';

    if (isMine) {
        div.innerHTML = `<div class="chat-bubble">${bubbleContent}</div><div class="chat-msg-time">${timeStr}</div>`;
    } else {
        const avatarHtml = avatar
            ? `<img class="chat-avatar" src="${esc(avatar)}" alt="">`
            : `<div class="chat-avatar chat-avatar-placeholder">${esc(name.charAt(0).toUpperCase())}</div>`;
        div.innerHTML = `
            <div class="chat-msg-sender">${esc(name)}</div>
            <div class="chat-msg-row">
                ${avatarHtml}
                <div class="chat-msg-body">
                    <div class="chat-bubble">${bubbleContent}</div>
                    <div class="chat-msg-time">${timeStr}</div>
                </div>
                ${reportBtnHtml}
            </div>`;
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

// Open the report dialog for a chat message. Hooked from the report
// button rendered next to non-self messages.
function onReportChatMessage(messageId, userId) {
    if (typeof openReportDialog !== 'function') return;
    openReportDialog({
        userId: userId,
        contentType: 'chat_message',
        contentId: messageId,
        contextLabel: 'message'
    });
}

async function sendChatMessage() {
    const input = document.getElementById('chatInput');
    if (!input || !selectedGroup) return;
    const body = input.value.trim();
    if (!body) return;

    input.disabled = true;
    const { data: msg, error } = await db.from('chat_messages').insert({
        group_id: selectedGroup.id,
        user_id: currentUser.id,
        body: body
    }).select().single();
    input.disabled = false;

    if (error) {
        showToast('Failed to send message: ' + error.message, 'error');
    } else {
        input.value = '';
        input.blur();
        if (msg) appendChatMessage(msg, true);
        scheduleLayoutChatPanel();
    }
}

function appendChatMessage(msg, forceScroll) {
    const msgsEl = document.getElementById('chatMessages');
    if (!msgsEl) return;

    // Skip if this message is already rendered (avoids duplicates from Realtime + direct append)
    if (msgsEl.querySelector(`[data-msg-id="${msg.id}"]`)) return;

    // Remove "no messages" placeholder if present
    const placeholder = msgsEl.querySelector('p');
    if (placeholder && placeholder.textContent.includes('No messages')) {
        placeholder.remove();
    }

    // Check if we're near the bottom before appending
    const atBottom = forceScroll
        || msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 60;

    createMessageElement(msg).then(el => {
        msgsEl.appendChild(el);
        if (atBottom) scrollChatToBottom();
        if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
    });
}
