// Liquid democracy: members delegate their vote to another member per issue type.
// Delegations are private (sql/vote-delegation-schema.sql): the client reads only the
// current user's own rows, plus aggregate voting power and tallies from the server.

const ISSUE_TYPE_MEMBERSHIP = 'Membership';
const ISSUE_TYPE_MONETARY_POLICY = 'Monetary Policy';
const DEFAULT_ISSUE_TYPES = [ISSUE_TYPE_MEMBERSHIP, ISSUE_TYPE_MONETARY_POLICY];

function issueTypesClause(types = DEFAULT_ISSUE_TYPES) {
    return 'Any member may delegate their vote to another member on these Issue Types: '
        + types.join(', ') + ' $ISSUE_TYPES. A delegation may be withdrawn at any time.';
}

function normalizeIssueTypeList(value) {
    const seen = new Set();
    const out = [];
    String(value || '').split(',').forEach((raw) => {
        const item = raw.trim();
        if (!item || seen.has(item.toLowerCase())) return;
        seen.add(item.toLowerCase());
        out.push(item);
    });
    return out;
}

function parseIssueTypes(constitutionText) {
    const match = (constitutionText || '').match(/:\s*([^:\n$]*?)\s*\$ISSUE_TYPES/);
    return match ? normalizeIssueTypeList(match[1]) : [];
}

function findIssueType(constitutionText, name) {
    if (!name) return null;
    const key = String(name).trim().toLowerCase();
    return parseIssueTypes(constitutionText).find((t) => t.toLowerCase() === key) || null;
}

function parseCurrencyRatesThreshold(constitutionText) {
    const match = (constitutionText || '').match(/(\d+)%\s*(?:members?\s*)?\$CHANGE_CURRENCY_RATES_PERCENTAGE/i);
    return match ? parseInt(match[1], 10) / 100 : 0.66;
}

// Share of all active members' votes needed to decide this issue type early.
function issueTypeThreshold(constitutionText, issueType) {
    const key = (issueType || '').toLowerCase();
    if (key === ISSUE_TYPE_MEMBERSHIP.toLowerCase()) return parseNewMemberThreshold(constitutionText);
    if (key === ISSUE_TYPE_MONETARY_POLICY.toLowerCase()) return parseCurrencyRatesThreshold(constitutionText);
    return parseAccordThreshold(constitutionText);
}

// lower-cased issue type -> delegate id, for the current user only.
async function fetchMyDelegations(groupId) {
    const { data, error } = await db
        .from('vote_delegations')
        .select('delegate_id, issue_type')
        .eq('group_id', groupId)
        .eq('delegator_id', currentUser.id);
    if (error) {
        console.warn('fetchMyDelegations:', error);
        return {};
    }
    const map = {};
    (data || []).forEach((d) => { map[d.issue_type.toLowerCase()] = d.delegate_id; });
    return map;
}

// lower-cased issue type -> { member id -> votes held }, only for members holding more than their own vote.
async function fetchVotingPower(groupId) {
    const { data, error } = await db.rpc('get_voting_power', { p_group_id: groupId });
    if (error) {
        console.warn('fetchVotingPower:', error);
        return {};
    }
    const map = {};
    (data || []).forEach((row) => {
        const key = row.issue_type.toLowerCase();
        (map[key] || (map[key] = {}))[row.member_id] = row.votes;
    });
    return map;
}

// Snapshot of the members tab, used by the delegate dialog and withdraw buttons.
let delegationView = null;

function setDelegationView(view) {
    delegationView = view;
}

function delegationMemberName(userId) {
    return delegationView?.names?.[userId] || 'Unknown';
}

function myDelegateFor(issueType) {
    const delegateId = delegationView?.myDelegates?.[issueType.toLowerCase()];
    return delegateId && delegationView.activeIds.includes(delegateId) ? delegateId : null;
}

function votingPowerOf(issueType, userId) {
    return delegationView?.power?.[issueType.toLowerCase()]?.[userId] || 1;
}

function renderMemberDelegationChips(userId) {
    if (!delegationView || delegationView.issueTypes.length === 0) return '';
    const { issueTypes, activeIds, constitution } = delegationView;
    const chips = [];
    issueTypes.forEach((issueType) => {
        const power = votingPowerOf(issueType, userId);
        if (power <= 1) return;
        const total = activeIds.length || 1;
        const share = Math.round((power / total) * 100);
        const needed = Math.max(1, Math.ceil(total * issueTypeThreshold(constitution, issueType)));
        const decisive = power >= needed;
        const title = decisive
            ? `${power} of ${total} votes: enough to decide ${issueType} without anyone else`
            : `${power} of ${total} votes (${needed} needed to decide ${issueType})`;
        chips.push(`<span class="member-deleg-chip member-deleg-power${decisive ? ' member-deleg-decisive' : ''}" title="${esc(title)}">
            ${esc(issueType)}: ${power} votes &middot; ${share}%</span>`);
    });
    return chips.length ? `<div class="member-deleg-line">${chips.join('')}</div>` : '';
}

function memberDelegateButtonHtml(userId) {
    if (!delegationView || delegationView.issueTypes.length === 0) return '';
    if (userId === currentUser?.id) {
        return '<span class="ft-open-btn-spacer member-delegate-spacer" aria-hidden="true"></span>';
    }
    const name = delegationMemberName(userId);
    return `<button type="button" class="ft-open-btn member-delegate-btn"
        title="Delegate your vote" aria-label="Delegate your vote to ${esc(name)}"
        onclick="event.stopPropagation(); showDelegateModal('${esc(userId)}')">
        <i data-lucide="vote" aria-hidden="true"></i>
    </button>`;
}

function renderMyDelegationsSummary() {
    const el = document.getElementById('myDelegationsContent');
    if (!el) return;
    if (!delegationView || delegationView.issueTypes.length === 0 || !currentUser) {
        el.innerHTML = '';
        return;
    }
    const rows = delegationView.issueTypes.map((issueType, i) => {
        const delegateId = myDelegateFor(issueType);
        if (delegateId) {
            return `<div class="my-deleg-row">
                <span class="my-deleg-issue">${esc(issueType)}</span>
                <span class="my-deleg-status">delegated to <strong>${esc(delegationMemberName(delegateId))}</strong></span>
                <button type="button" class="btn btn-secondary btn-small" onclick="withdrawDelegation(${i})">Withdraw</button>
            </div>`;
        }
        const power = votingPowerOf(issueType, currentUser.id);
        return `<div class="my-deleg-row">
            <span class="my-deleg-issue">${esc(issueType)}</span>
            <span class="my-deleg-status">you vote directly${power > 1 ? ` &middot; carrying <strong>${power}</strong> votes` : ''}</span>
        </div>`;
    }).join('');
    el.innerHTML = `<div class="my-delegations">
        <div class="my-deleg-title">Your votes by issue type</div>
        ${rows}
        <p class="my-deleg-hint">Tap <i data-lucide="vote" aria-hidden="true"></i> next to a member to delegate your vote to them. Your delegations are private. Voting yourself always overrides your delegation.</p>
    </div>`;
}

function showDelegateModal(memberId) {
    if (!delegationView || !currentUser) return;
    const name = delegationMemberName(memberId);
    const rows = delegationView.issueTypes.map((issueType, i) => {
        const current = myDelegateFor(issueType);
        const checked = current === memberId;
        const note = current && !checked ? `currently delegated to ${esc(delegationMemberName(current))}` : '';
        return `<label class="deleg-option">
            <input type="checkbox" data-issue-index="${i}" ${checked ? 'checked' : ''}>
            <span class="deleg-option-label">${esc(issueType)}</span>
            ${note ? `<span class="deleg-option-note">${note}</span>` : ''}
        </label>`;
    }).join('');

    const body = document.getElementById('modalBody');
    body.innerHTML = `
        <h3>Delegate your vote to ${esc(name)}</h3>
        <p style="font-size:0.85rem;color:var(--dark-gray);margin-bottom:0.75rem;">
            ${esc(name)} will vote for you on the issue types you check, along with any votes delegated to you.
            If ${esc(name)} delegates too, your vote passes along to their delegate. Voting yourself always overrides the delegation.
            Only you can see who you delegate to.
        </p>
        <div class="deleg-options" id="delegateOptions">${rows}</div>
        <div class="form-actions">
            <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
            <button type="button" class="btn btn-primary" onclick="saveDelegations('${esc(memberId)}')">Save</button>
        </div>
    `;
    document.getElementById('modalOverlay').classList.remove('hidden');
}

function describeDelegationEffects(effects) {
    if (!effects) return '';
    const parts = [];
    const admitted = effects.admitted?.length || 0;
    const rates = effects.rates_applied?.length || 0;
    const accords = effects.accords_passed?.length || 0;
    if (admitted) parts.push(`${admitted} candidate${admitted === 1 ? '' : 's'} admitted`);
    if (rates) parts.push(`${rates} rate change${rates === 1 ? '' : 's'} applied`);
    if (accords) parts.push(`${accords} accord${accords === 1 ? '' : 's'} adopted`);
    return parts.join(', ');
}

async function saveDelegations(memberId) {
    if (!delegationView || !selectedGroup) return;
    const groupId = selectedGroup.id;
    const inputs = document.querySelectorAll('#delegateOptions input[data-issue-index]');
    const effects = [];
    let changed = 0;

    for (const input of inputs) {
        const issueType = delegationView.issueTypes[Number(input.dataset.issueIndex)];
        if (!issueType) continue;
        const isDelegatedHere = myDelegateFor(issueType) === memberId;
        if (input.checked && !isDelegatedHere) {
            const { data, error } = await db.rpc('set_vote_delegation', {
                p_group_id: groupId,
                p_issue_type: issueType,
                p_delegate_id: memberId
            });
            if (error) { showToast(error.message, 'error'); break; }
            changed++;
            const summary = describeDelegationEffects(data?.effects);
            if (summary) effects.push(summary);
        } else if (!input.checked && isDelegatedHere) {
            const { error } = await db.rpc('withdraw_vote_delegation', {
                p_group_id: groupId,
                p_issue_type: issueType
            });
            if (error) { showToast(error.message, 'error'); break; }
            changed++;
        }
    }

    closeModal();
    if (changed) {
        showToast(effects.length ? `Delegation saved: ${effects.join('; ')}` : 'Delegation saved', 'success');
        if (effects.length) {
            await loadMyGroups();
            return;
        }
    }
    await refreshMembersTab();
}

async function withdrawDelegation(issueIndex) {
    if (!delegationView || !selectedGroup) return;
    const issueType = delegationView.issueTypes[issueIndex];
    if (!issueType) return;
    const { error } = await db.rpc('withdraw_vote_delegation', {
        p_group_id: selectedGroup.id,
        p_issue_type: issueType
    });
    if (error) { showToast(error.message, 'error'); return; }
    showToast(`You now vote directly on ${issueType}`, 'info');
    await refreshMembersTab();
}

async function refreshMembersTab() {
    if (activeTab !== 'members') return;
    await Promise.all([loadMembersList(), loadCandidatesList()]);
}
