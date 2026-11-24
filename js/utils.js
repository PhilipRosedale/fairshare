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
    // Fade out over the last 200ms instead of vanishing.
    setTimeout(() => toast.classList.add('toast-out'), Math.max(0, APP_TIMING.TOAST_MS - 200));
    setTimeout(() => toast.remove(), APP_TIMING.TOAST_MS);
}

// ---- Microanimations ---------------------------------------------------------
// Small helpers behind the motion in styles.css ("MICROANIMATIONS"). They share
// the easing of the Union fan so the whole app moves one way, and every one of
// them is switched off there under prefers-reduced-motion.

// Play a one-shot CSS animation class on an element. The class comes off again
// once the animation is over so no transform lingers: a transformed ancestor
// would re-anchor position:fixed children such as the chat input bar.
function playEnterAnimation(el, className) {
    if (!el) return;
    clearTimeout(el._enterAnimTimer);
    el.classList.remove(className);
    void el.offsetWidth; // restart if it is already mid-animation
    el.classList.add(className);
    // Timed rather than on animationend: some of these animate the element's
    // children, and nothing fires at all under prefers-reduced-motion.
    el._enterAnimTimer = setTimeout(() => el.classList.remove(className), 500);
}

// Let the first rows of a list arrive one after another. `startedAt` is when
// the cascade began (performance.now()); a list that re-renders mid-cascade
// passes the same value and picks up where it was instead of starting over,
// and once the cascade is over this does nothing.
const LIST_CASCADE = { STEP_MS: 28, ROW_MS: 320, MAX_ROWS: 14 };
function playListCascade(container, selector, startedAt) {
    if (!container) return;
    const elapsed = performance.now() - startedAt;
    const rows = Array.from(container.querySelectorAll(selector)).slice(0, LIST_CASCADE.MAX_ROWS);
    rows.forEach((row, i) => {
        const delay = i * LIST_CASCADE.STEP_MS - elapsed;
        if (delay + LIST_CASCADE.ROW_MS <= 0) return;
        row.style.animationDelay = `${Math.round(delay)}ms`;
        row.classList.add('cascade-in');
        setTimeout(() => {
            row.classList.remove('cascade-in');
            row.style.animationDelay = '';
        }, delay + LIST_CASCADE.ROW_MS + 60);
    });
}

// Slide the white pill in the group tab bar to the active tab. The pill is the
// bar's ::before, placed from two CSS variables measured here. If the bar can't
// be measured (hidden), the class comes off and the active button draws its own
// background as before.
function updateTabThumb(animate) {
    const bar = document.getElementById('tabBar');
    if (!bar) return;
    if (!bar._thumbObserver && typeof ResizeObserver === 'function') {
        bar._thumbObserver = new ResizeObserver(() => updateTabThumb(false));
        bar._thumbObserver.observe(bar);
    }
    const btn = bar.querySelector('.tab-btn.active');
    if (!btn || !btn.offsetWidth) {
        bar.classList.remove('has-thumb', 'thumb-animate');
        return;
    }
    const hadThumb = bar.classList.contains('has-thumb');
    bar.classList.toggle('thumb-animate', Boolean(animate && hadThumb));
    bar.style.setProperty('--thumb-x', `${btn.offsetLeft}px`);
    bar.style.setProperty('--thumb-w', `${btn.offsetWidth}px`);
    bar.classList.add('has-thumb');
}

// Closing a dialog hides the real overlay at once (callers rely on that), so
// the fade-out plays on a throwaway copy. Skipped when another dialog opens
// straight away, so one dialog handing over to the next does not double up.
function playModalCloseGhost(overlay) {
    try {
        if (!overlay || overlay.classList.contains('hidden')) return;
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const ghost = overlay.cloneNode(true);
        const fields = 'input, textarea, select';
        const src = overlay.querySelectorAll(fields);
        ghost.querySelectorAll(fields).forEach((el, i) => {
            // cloneNode drops what was typed; names would join live radio groups.
            if (src[i]) { el.value = src[i].value; el.checked = src[i].checked; }
            el.removeAttribute('name');
        });
        ghost.removeAttribute('id');
        ghost.querySelector('.modal')?.removeAttribute('id');
        ghost.removeAttribute('onclick');
        ghost.removeAttribute('onmousedown');
        ghost.removeAttribute('ontouchstart');
        ghost.setAttribute('aria-hidden', 'true');
        ghost.inert = true;
        ghost.classList.add('modal-ghost');
        setTimeout(() => {
            if (!overlay.classList.contains('hidden')) return;
            document.body.appendChild(ghost);
            setTimeout(() => ghost.remove(), 200);
        }, 0);
    } catch (_) { /* purely cosmetic */ }
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
function sendInboundShareEmailPhonePush(toUserId, shareState) {
    if (!currentUser?.id || !toUserId || !shareState) return;
    // The server builds the sentence (same wording as
    // buildInboundShareEmailPhonePushBody) and checks the share is real.
    db.rpc('notify_contact_info_shared', {
        p_contact_id: toUserId,
        p_phone_first: !!shareState.phoneFirst,
        p_phone_update: !!shareState.phoneUpdate,
        p_email_first: !!shareState.emailFirst,
        p_email_update: !!shareState.emailUpdate
    }).then(({ error: pErr }) => {
        if (pErr) console.warn('share email/phone push error:', pErr);
    });
}
