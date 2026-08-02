function esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

/** Appends a query param so replaced storage objects (same public URL) still load fresh bytes. */
function withImageCacheBust(url, token) {
    if (!url || token == null || token === '') return url;
    const sep = url.includes('?') ? '&' : '?';
    return url + sep + 'v=' + encodeURIComponent(String(token));
}

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), APP_TIMING.TOAST_MS);
}

const INSTALL_HINT_SESSION_KEY = 'union_install_hint_dismissed';
let _installHintCloseBound = false;

function isStandaloneApp() {
    const standaloneMedia = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
    const iosStandalone = window.navigator.standalone === true;
    return Boolean(standaloneMedia || iosStandalone);
}

function isMobileBrowser() {
    const coarsePointer = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    const ua = window.navigator.userAgent || '';
    const mobileUA = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
    return Boolean(coarsePointer || mobileUA);
}

function shouldShowInstallHintThisSession() {
    try {
        return sessionStorage.getItem(INSTALL_HINT_SESSION_KEY) !== '1';
    } catch (e) {
        console.warn('Install hint session storage unavailable:', e);
        return true;
    }
}

function markInstallHintDismissedForSession() {
    try {
        sessionStorage.setItem(INSTALL_HINT_SESSION_KEY, '1');
    } catch (e) {
        console.warn('Could not persist install hint dismissal:', e);
    }
}

function dismissInstallHintFloater() {
    const floater = document.getElementById('installHintFloater');
    if (!floater) return;
    floater.classList.add('hidden');
    markInstallHintDismissedForSession();
}

function showInstallHintFloater() {
    const floater = document.getElementById('installHintFloater');
    const message = document.getElementById('installHintMessage');
    const closeBtn = document.getElementById('installHintCloseBtn');
    if (!floater || !message) return;

    const isMobile = isMobileBrowser();
    message.textContent = isMobile
        ? `Install ${APP_NAME} to homescreen to get notifications`
        : `Install ${APP_NAME} as desktop icon to get notifications`;

    if (isMobile) {
        floater.style.left = '';
        floater.style.right = '';
    } else {
        floater.style.left = '50vw';
        floater.style.right = 'auto';
    }
    floater.classList.remove('hidden');

    if (closeBtn && !_installHintCloseBound) {
        closeBtn.addEventListener('click', dismissInstallHintFloater);
        _installHintCloseBound = true;
    }
}

function maybeShowInstallHintFloater() {
    if (isStandaloneApp()) return;
    if (!shouldShowInstallHintThisSession()) return;
    showInstallHintFloater();
}

/**
 * Build the push body when outbound email/phone shared with one contact is new or changed.
 * @param {string} displayName
 * @param {{ phoneFirst: boolean, phoneUpdate: boolean, emailFirst: boolean, emailUpdate: boolean }} shareState
 * @returns {string|null}
 */
function buildInboundShareEmailPhonePushBody(displayName, shareState) {
    const name = displayName || 'Someone';
    const { phoneFirst, phoneUpdate, emailFirst, emailUpdate } = shareState;
    const seg = [];
    if (phoneFirst) seg.push('shared their phone number');
    else if (phoneUpdate) seg.push('updated the phone number they share');
    if (emailFirst) seg.push('shared their email');
    else if (emailUpdate) seg.push('updated the email they share');
    if (seg.length === 0) return null;
    if (seg.length === 1) return name + ' ' + seg[0] + ' with you.';
    return name + ' ' + seg[0] + ' and ' + seg[1] + ' with you.';
}

/**
 * Push when someone first shares or updates email/phone with a specific contact.
 * In-app toasts for first share still come from `contact_shares` Realtime.
 */
function sendInboundShareEmailPhonePush(toUserId, body) {
    if (!currentUser?.id || !toUserId || !body) return;
    const title = typeof APP_NAME !== 'undefined' ? APP_NAME : 'FairShare';
    db.rpc('send_push_to_users', {
        p_user_ids: [toUserId],
        p_actor_id: currentUser.id,
        p_title: title,
        p_body: body,
        p_url: '/?action=view_contact&contact=' + currentUser.id
    }).then(({ error: pErr }) => {
        if (pErr) console.warn('share email/phone push error:', pErr);
    });
}

/**
 * Grow a message composer to fit its content, up to the max-height set in CSS,
 * and only then scroll. Call on input and again after the field is cleared,
 * so the box collapses back to one row after a message is sent.
 */
function autoGrowMessageInput(el) {
    if (!el) return;
    const maxHeight = parseInt(window.getComputedStyle(el).maxHeight, 10);
    el.style.height = 'auto';
    const target = Number.isFinite(maxHeight)
        ? Math.min(el.scrollHeight, maxHeight)
        : el.scrollHeight;
    el.style.height = `${target}px`;
    el.style.overflowY = el.scrollHeight > target ? 'auto' : 'hidden';
}
