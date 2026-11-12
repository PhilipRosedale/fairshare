// =============================================================================
// Safety: report content + block users (Apple Guideline 1.2)
// -----------------------------------------------------------------------------
// Companion to sql/safety-schema.sql. Maintains a small client-side cache of
// blocked user ids so chat / contacts / nearby can hide them locally without
// every render touching the network. The server side is the source of truth;
// the cache is refreshed on login and after every block / unblock.
// =============================================================================

// Set<string> of user ids the current user has blocked. Populated by
// loadBlockedUsers() at login and updated by block/unblock helpers.
const blockedUserIds = new Set();

function isUserBlocked(userId) {
    if (!userId) return false;
    return blockedUserIds.has(userId);
}

async function loadBlockedUsers() {
    blockedUserIds.clear();
    if (!currentUser) return;
    try {
        const { data, error } = await db.rpc('list_blocked_users');
        if (error) {
            console.warn('list_blocked_users error:', error);
            return;
        }
        (data || []).forEach(row => {
            if (row?.blocked_id) blockedUserIds.add(row.blocked_id);
        });
    } catch (e) {
        console.warn('loadBlockedUsers failed:', e);
    }
}

// ---- Block / Unblock --------------------------------------------------------

function openBlockUserConfirm(contactId, displayName) {
    if (!contactId) return;
    const overlay = document.getElementById('modalOverlay');
    const body = document.getElementById('modalBody');
    if (!overlay || !body) return;
    const safeName = esc(displayName || 'this user');
    body.innerHTML = `
        <h3>Block ${safeName}?</h3>
        <p style="font-size:0.92rem;color:var(--dark-gray);margin-bottom:0.75rem;">
            They will be removed from your contacts and will not appear in chat,
            nearby alerts, or the map. You can unblock them later from your
            profile screen.
        </p>
        <div class="form-actions">
            <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
            <button type="button" class="btn btn-danger" onclick="confirmBlockUser('${esc(contactId)}', '${esc(displayName || '')}')">Block</button>
        </div>
    `;
    overlay.classList.remove('hidden');
}

async function confirmBlockUser(contactId, displayName) {
    if (!contactId || !currentUser) return;
    try {
        const { data, error } = await db.rpc('block_user', { p_target_id: contactId });
        if (error) throw error;
        if (data?.error) throw new Error(data.error);

        blockedUserIds.add(contactId);
        showToast((displayName || 'User') + ' has been blocked.', 'success');
        closeModal();

        // Refresh the contact list and step out of the contact details
        // screen if it's still showing this user.
        if (typeof cdCurrentContactId !== 'undefined' && cdCurrentContactId === contactId) {
            if (typeof closeContactDetailsScreen === 'function') closeContactDetailsScreen();
        }
        if (typeof loadAndRenderContactList === 'function') {
            await loadAndRenderContactList();
        }
    } catch (e) {
        console.error('block_user failed:', e);
        showToast('Could not block: ' + (e.message || 'unknown error'), 'error');
    }
}

async function unblockUserById(targetId, displayName) {
    if (!targetId || !currentUser) return;
    try {
        const { data, error } = await db.rpc('unblock_user', { p_target_id: targetId });
        if (error) throw error;
        if (data?.error) throw new Error(data.error);

        blockedUserIds.delete(targetId);
        showToast((displayName || 'User') + ' has been unblocked.', 'success');
        // Refresh the blocked-users list view if it's open.
        if (document.getElementById('blockedUsersList')) {
            await renderBlockedUsersList();
        }
    } catch (e) {
        console.error('unblock_user failed:', e);
        showToast('Could not unblock: ' + (e.message || 'unknown error'), 'error');
    }
}

// ---- Blocked users management screen ---------------------------------------

async function openBlockedUsersModal() {
    const overlay = document.getElementById('modalOverlay');
    const body = document.getElementById('modalBody');
    if (!overlay || !body) return;
    body.innerHTML = `
        ${modalCloseX()}
        <h3>Blocked users</h3>
        <p style="font-size:0.88rem;color:var(--dark-gray);margin-bottom:0.75rem;">
            People you've blocked won't appear in your contacts, chat, nearby
            alerts, or the map.
        </p>
        <div id="blockedUsersList" class="blocked-users-list">
            <p style="color:var(--dark-gray);text-align:center;padding:1rem 0;">Loading…</p>
        </div>
    `;
    overlay.classList.remove('hidden');
    await renderBlockedUsersList();
}

async function renderBlockedUsersList() {
    const list = document.getElementById('blockedUsersList');
    if (!list) return;
    try {
        const { data, error } = await db.rpc('list_blocked_users');
        if (error) throw error;
        if (!data || data.length === 0) {
            list.innerHTML = '<p style="color:var(--dark-gray);text-align:center;padding:1rem 0;">You haven\u2019t blocked anyone.</p>';
            return;
        }
        list.innerHTML = data.map(row => {
            const id = row.blocked_id;
            const name = row.display_name || 'Former user';
            const initial = (name || '?').trim().charAt(0).toUpperCase() || '?';
            const avatar = row.profile_image_url
                ? `<img class="blocked-user-avatar" src="${esc(row.profile_image_url)}" alt="">`
                : `<div class="blocked-user-avatar blocked-user-avatar-fallback">${esc(initial)}</div>`;
            return `
                <div class="blocked-user-row">
                    ${avatar}
                    <span class="blocked-user-name">${esc(name)}</span>
                    <button type="button" class="btn btn-outline btn-small"
                            onclick="unblockUserById('${esc(id)}', '${esc(name)}')">Unblock</button>
                </div>`;
        }).join('');
    } catch (e) {
        console.error('renderBlockedUsersList failed:', e);
        list.innerHTML = '<p style="color:var(--red);text-align:center;padding:1rem 0;">Could not load blocked users.</p>';
    }
}

// ---- Report content --------------------------------------------------------

// Pending report target, held in a module-level variable instead of being
// serialized into an inline onclick attribute. Cleared on close.
let _pendingReportTarget = null;

// Open a report dialog. `target` describes what is being reported:
//   { userId, contentType, contentId?, contextLabel? }
// contentType matches the SQL CHECK list ('chat_message', 'profile_photo', etc.).
function openReportDialog(target) {
    const overlay = document.getElementById('modalOverlay');
    const body = document.getElementById('modalBody');
    if (!overlay || !body) return;

    _pendingReportTarget = target || {};
    const label = target?.contextLabel || reportContentLabel(target?.contentType);
    body.innerHTML = `
        <h3>Report ${esc(label)}</h3>
        <p style="font-size:0.88rem;color:var(--dark-gray);margin-bottom:0.75rem;">
            Tell us what's wrong. Reports are reviewed and acted on within
            24 hours. Abusive users and objectionable content are removed.
        </p>
        <div class="form-group">
            <label for="reportReasonInput">Reason</label>
            <textarea id="reportReasonInput" rows="4" maxlength="2000"
                      placeholder="e.g. Hate speech, harassment, spam, sexual content, violence\u2026"></textarea>
        </div>
        <div class="form-actions">
            <button type="button" class="btn btn-secondary" onclick="cancelReportDialog()">Cancel</button>
            <button type="button" class="btn btn-primary" id="reportSubmitBtn"
                    onclick="submitPendingReport()">Submit report</button>
        </div>
    `;
    overlay.classList.remove('hidden');
    setTimeout(() => {
        const input = document.getElementById('reportReasonInput');
        if (input) input.focus();
    }, 0);
}

function cancelReportDialog() {
    _pendingReportTarget = null;
    closeModal();
}

function reportContentLabel(contentType) {
    switch (contentType) {
        case 'chat_message':  return 'message';
        case 'profile_photo': return 'profile photo';
        case 'profile':       return 'profile';
        case 'group_logo':    return 'group logo';
        case 'group_name':    return 'group name';
        case 'selfie':        return 'photo';
        case 'display_name':  return 'display name';
        default:              return 'content';
    }
}

async function submitPendingReport() {
    const target = _pendingReportTarget;
    if (!target) return;

    const input = document.getElementById('reportReasonInput');
    const btn   = document.getElementById('reportSubmitBtn');
    const reason = (input?.value || '').trim();
    if (!reason) {
        showToast('Please describe what you\u2019re reporting.', 'error');
        return;
    }
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Submitting\u2026';
    }
    try {
        const { data, error } = await db.rpc('report_content', {
            p_reported_user_id: target.userId || null,
            p_content_type:     target.contentType || 'other',
            p_content_id:       target.contentId ? String(target.contentId) : null,
            p_reason:           reason
        });
        if (error) throw error;
        if (data?.error) throw new Error(data.error);

        showToast('Report submitted. Thank you.', 'success');
        _pendingReportTarget = null;
        closeModal();
    } catch (e) {
        console.error('submitReport failed:', e);
        showToast('Could not submit report: ' + (e.message || 'unknown error'), 'error');
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Submit report';
        }
    }
}
