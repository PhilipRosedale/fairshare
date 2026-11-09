// Removing a member by group vote. Backend: sql/removal-votes-schema.sql.
//
// Any active member can propose removing another. The others vote on the
// Members tab; the person being voted on sees the vote but cannot take part.
// When the votes reach the group's admission share (or, after the voting
// period, a majority of eligible members) the server flips the member to
// 'removed' and logs a member_removed event. Nothing here decides anything;
// it only shows the state the server reports and sends votes to it.

let removalProposals = [];

async function loadRemovalVotes() {
    const el = document.getElementById('removalVotesContent');
    if (!el || !selectedGroup) return;
    try {
        const { data, error } = await db.rpc('list_removal_proposals', { p_group_id: selectedGroup.id });
        if (error) throw error;
        removalProposals = Array.isArray(data) ? data : [];
    } catch (e) {
        console.warn('list_removal_proposals:', e);
        removalProposals = [];
    }
    renderRemovalVotes();
}

function removalDaysLeft(windowEnd) {
    if (!windowEnd) return null;
    const ms = new Date(windowEnd) - Date.now();
    if (ms <= 0) return 'closing';
    const d = Math.ceil(ms / 86400000);
    return d === 1 ? '1 day left' : `${d} days left`;
}

function renderRemovalVotes() {
    const el = document.getElementById('removalVotesContent');
    if (!el) return;
    if (!removalProposals.length) { el.innerHTML = ''; el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.innerHTML = `<h4 class="removal-h">Removal votes</h4>` + removalProposals.map(p => {
        const left = removalDaysLeft(p.window_end);
        const meta = [`${p.votes} of ${p.threshold} votes`, left].filter(Boolean).join(' · ');
        let action;
        if (p.is_me) {
            action = `<span class="removal-you">You can't vote on this one</span>`;
        } else if (p.i_proposed) {
            action = `<button class="btn btn-small btn-ghost" onclick="withdrawRemoval('${p.id}')">Withdraw</button>`;
        } else if (p.i_voted) {
            action = `<button class="btn btn-small btn-ghost" onclick="unvoteRemoval('${p.id}')">Undo vote</button>`;
        } else {
            action = `<button class="btn btn-small btn-danger" onclick="voteRemoval('${p.id}')">Vote to remove</button>`;
        }
        return `<div class="removal-card${p.is_me ? ' is-me' : ''}">
            <div class="removal-main">
                <div class="removal-title">${p.is_me ? 'A vote to remove <strong>you</strong> is open' : `Remove <strong>${esc(p.target_name)}</strong>?`}</div>
                <div class="removal-meta">Proposed by ${esc(p.proposer_name)} · ${meta}</div>
                ${p.reason ? `<div class="removal-reason">“${esc(p.reason)}”</div>` : ''}
            </div>
            <div class="removal-action">${action}</div>
        </div>`;
    }).join('');
}

async function afterRemovalChange(result) {
    if (result?.status === 'passed') {
        showToast('The group voted to remove this member.', 'info');
        await loadMyGroups();
        if (activeTab === 'members' && typeof renderMembersTab === 'function') await renderMembersTab();
        return;
    }
    await loadRemovalVotes();
}

async function voteRemoval(id) {
    const { data, error } = await db.rpc('vote_removal', { p_proposal_id: id });
    if (error) { showToast(error.message, 'error'); return; }
    if (data?.status === 'open') showToast('Vote recorded', 'info');
    await afterRemovalChange(data);
}

async function unvoteRemoval(id) {
    const { data, error } = await db.rpc('unvote_removal', { p_proposal_id: id });
    if (error) { showToast(error.message, 'error'); return; }
    await afterRemovalChange(data);
}

async function withdrawRemoval(id) {
    const { error } = await db.rpc('withdraw_removal', { p_proposal_id: id });
    if (error) { showToast(error.message, 'error'); return; }
    showToast('Proposal withdrawn', 'info');
    await loadRemovalVotes();
}

// Member row "..." -> propose. Uses the shared modal container directly.
function openProposeRemoval(userId, displayName) {
    if (!selectedGroup || !currentUser || userId === currentUser.id) return;
    const overlay = document.getElementById('modalOverlay');
    const body = document.getElementById('modalBody');
    if (!overlay || !body) return;
    body.classList.remove('beta-ios-modal');
    const name = esc(displayName || 'this member');
    const pct = Math.round((typeof parseNewMemberThreshold === 'function' ? parseNewMemberThreshold(selectedGroup.constitution) : 1) * 100);
    const days = typeof parseVotingPeriodDays === 'function' ? parseVotingPeriodDays(selectedGroup.constitution) : null;
    const rule = `${pct}% of the other members have to agree` + (days ? `, within ${days} day${days === 1 ? '' : 's'}` : '') + '.';
    body.innerHTML = `
        <h3>Propose removing ${name}</h3>
        <p class="removal-explain">This starts a vote the whole group can see, ${name} included. ${rule} Your proposal counts as your vote.</p>
        <div class="form-group">
            <label for="removalReason">Why? (optional, shown to the group)</label>
            <textarea id="removalReason" rows="3" maxlength="280" placeholder="Keep it factual."></textarea>
        </div>
        <div class="modal-actions">
            <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
            <button type="button" class="btn btn-danger" onclick="submitProposeRemoval('${userId}')">Start the vote</button>
        </div>`;
    overlay.classList.remove('hidden');
    setTimeout(() => document.getElementById('removalReason')?.focus(), 50);
}

async function submitProposeRemoval(userId) {
    const reason = (document.getElementById('removalReason')?.value || '').trim();
    const { data, error } = await db.rpc('propose_removal', {
        p_group_id: selectedGroup.id, p_target_id: userId, p_reason: reason || null
    });
    if (error) { showToast(error.message, 'error'); return; }
    closeModal();
    if (data?.status === 'passed') {
        // Tiny group: the proposer's own vote was enough.
        await afterRemovalChange(data);
        return;
    }
    showToast('Vote started. The group has been told.', 'info');
    await loadRemovalVotes();
}
