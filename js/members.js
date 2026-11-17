async function loadMembersList() {
    if (!selectedGroup) return;
    const el = document.getElementById('membersListContent');
    if (!el) return;

    const monthAgo = new Date(Date.now() - 30 * APP_TIMING.DAY_MS).toISOString();
    const issueTypes = parseIssueTypes(selectedGroup.constitution);

    const [{ data, error }, { data: sponsorships }, { data: txns }, myDelegates, power] = await Promise.all([
        db.from('members')
            .select('*, profiles(display_name, profile_image_url)')
            .eq('group_id', selectedGroup.id)
            .eq('status', 'active')
            .order('joined_at', { ascending: true }),
        db.from('sponsorships')
            .select('candidate_id, sponsor:profiles!sponsorships_sponsor_id_fkey(display_name)')
            .eq('group_id', selectedGroup.id)
            .eq('status', 'claimed'),
        // Peer transactions only. Minted daily income (from_user null) is the same
        // for every member, so counting it would bury the earned-income signal.
        db.from('transactions')
            .select('from_user, to_user, amount, fee')
            .eq('group_id', selectedGroup.id)
            .gte('created_at', monthAgo)
            .not('from_user', 'is', null),
        issueTypes.length ? fetchMyDelegations(selectedGroup.id) : Promise.resolve({}),
        issueTypes.length ? fetchVotingPower(selectedGroup.id) : Promise.resolve({})
    ]);

    if (error || !data) {
        el.innerHTML = '<p>Failed to load members.</p>';
        return;
    }

    // Update member count display
    const countEl = document.getElementById('memberCountDisplay');
    if (countEl) countEl.textContent = `${data.length} active member${data.length === 1 ? '' : 's'}`;

    const names = {};
    data.forEach(m => { names[m.user_id] = m.profiles?.display_name || 'Unknown'; });
    setDelegationView({
        groupId: selectedGroup.id,
        constitution: selectedGroup.constitution,
        issueTypes,
        myDelegates,
        power,
        activeIds: data.map(m => m.user_id),
        names
    });
    renderMyDelegationsSummary();

    // Build a map of candidate_id → sponsor name
    const sponsorMap = {};
    (sponsorships || []).forEach(s => {
        if (s.candidate_id) sponsorMap[s.candidate_id] = s.sponsor?.display_name || null;
    });

    // Received and sent are tracked separately so the list shows who is earning
    // from others rather than just who is busy. Senders are debited the full
    // amount and recipients credited net of the fee, mirroring the balance
    // changes send_currency actually applies.
    const flows = {};
    const flowFor = id => (flows[id] || (flows[id] = { in: 0, out: 0 }));
    (txns || []).forEach(t => {
        const amount = Number(t.amount) || 0;
        const fee = Number(t.fee) || 0;
        if (t.from_user) flowFor(t.from_user).out += amount;
        if (t.to_user) flowFor(t.to_user).in += amount - fee;
    });

    const sym = esc(selectedGroup.currency_symbol);
    const currencyOn = groupCurrencyEnabled(selectedGroup);

    el.innerHTML = data.map(m => {
        const sponsor = sponsorMap[m.user_id];
        const isCreator = m.user_id === selectedGroup.created_by;
        const sponsorLabel = isCreator ? 'founder' : (sponsor ? `sponsored by ${esc(sponsor)}` : '');
        const displayName = m.profiles?.display_name || 'Unknown';
        const avatarUrl = m.profiles?.profile_image_url || null;
        const avatarHtml = avatarUrl
            ? `<img class="member-avatar" src="${esc(avatarUrl)}" alt="">`
            : `<div class="member-avatar-placeholder">${esc(displayName.charAt(0).toUpperCase())}</div>`;
        const flow = flows[m.user_id] || { in: 0, out: 0 };
        const flowHtml = currencyOn
            ? `<span class="member-tx-flow" title="Received and sent over the last 30 days">
                <span class="member-tx-in${flow.in ? '' : ' member-tx-idle'}">+${sym} ${flow.in.toFixed(2)}</span>
                <span class="member-tx-out${flow.out ? '' : ' member-tx-idle'}">-${sym} ${flow.out.toFixed(2)}</span>
            </span>`
            : '';
        const delegationLine = renderMemberDelegationChips(m.user_id);
        // Everything the member sheet needs, so tapping a row costs no fetch.
        membersLoaded[m.user_id] = {
            userId: m.user_id, displayName, avatarUrl, isCreator, sponsor: sponsor || null,
            joinedAt: m.joined_at, flow, isMe: m.user_id === currentUser?.id
        };
        // A div, not a button: the row holds the delegate and family tree
        // buttons, which stop propagation so they do not open the sheet.
        return `<div class="member-item member-item-btn${delegationLine ? ' member-item-has-deleg' : ''}" role="button" tabindex="0"
            onclick="openMemberSheet('${m.user_id}')"
            onkeydown="if (event.target === this && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openMemberSheet('${m.user_id}'); }">
            ${avatarHtml}
            <span class="member-name">${esc(displayName)}</span>
            ${sponsorLabel ? `<span class="member-sponsor">${sponsorLabel}</span>` : ''}
            ${flowHtml}
            ${memberDelegateButtonHtml(m.user_id)}
            ${m.user_id === currentUser?.id
                ? '<span class="ft-open-btn-spacer" aria-hidden="true"></span>'
                : familyTreeButtonHtml(m.user_id, displayName)}
        </div>${delegationLine}`;
    }).join('');
    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
}

// Tap a member: a sheet with who they are and what you can do with them.
// Group-level actions live here (removal today; roles, delegation later),
// so the list itself stays just a list.
let membersLoaded = {};

async function openMemberSheet(userId) {
    const m = membersLoaded[userId];
    if (!m || !selectedGroup) return;
    let sheet = document.getElementById('memberSheet');
    if (!sheet) {
        sheet = document.createElement('div');
        sheet.id = 'memberSheet';
        sheet.className = 'member-sheet hidden';
        sheet.innerHTML = '<div class="member-sheet-scrim" onclick="closeMemberSheet()"></div><div class="member-sheet-panel" role="dialog" aria-modal="true"></div>';
        document.body.appendChild(sheet);
    }
    const panel = sheet.querySelector('.member-sheet-panel');
    const sym = esc(selectedGroup.currency_symbol || '');
    const currencyOn = groupCurrencyEnabled(selectedGroup);
    const joined = m.joinedAt ? new Date(m.joinedAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : '';
    const sub = m.isCreator ? 'Founder' : (m.sponsor ? `Sponsored by ${esc(m.sponsor)}` : 'Member');
    const avatar = m.avatarUrl
        ? `<img class="member-sheet-avatar" src="${esc(m.avatarUrl)}" alt="">`
        : `<div class="member-sheet-avatar placeholder">${esc(m.displayName.charAt(0).toUpperCase())}</div>`;

    panel.innerHTML = `
        <div class="member-sheet-grab"></div>
        <div class="member-sheet-head">
            ${avatar}
            <div class="member-sheet-who">
                <div class="member-sheet-name">${esc(m.displayName)}${m.isMe ? ' <span class="member-sheet-you">you</span>' : ''}</div>
                <div class="member-sheet-sub">${sub}${joined ? ` · joined ${esc(joined)}` : ''}</div>
            </div>
        </div>
        ${currencyOn ? `<div class="member-sheet-stats">
            <div><span class="k">Received</span><span class="v in">+${sym} ${m.flow.in.toFixed(2)}</span></div>
            <div><span class="k">Sent</span><span class="v out">-${sym} ${m.flow.out.toFixed(2)}</span></div>
            <div class="member-sheet-stats-note">last 30 days, within this group</div>
        </div>` : ''}
        <div class="member-sheet-actions" id="memberSheetActions"></div>`;
    sheet.dataset.for = userId;
    sheet.classList.remove('hidden');
    requestAnimationFrame(() => sheet.classList.add('open'));

    // Actions depend on whether they are in your contacts; find out quietly.
    const actions = panel.querySelector('#memberSheetActions');
    if (m.isMe) {
        actions.innerHTML = `<button class="btn btn-secondary member-sheet-btn" onclick="closeMemberSheet(); leaveGroup('${selectedGroup.id}', ${JSON.stringify(selectedGroup.name || '')}, event)">Leave group</button>`;
        return;
    }
    let isContact = false;
    try {
        const { data } = await db.from('contacts').select('contact_id').eq('user_id', currentUser.id).eq('contact_id', userId).maybeSingle();
        isContact = !!data;
    } catch (e) { /* treat as not a contact */ }
    if (sheet.dataset.for !== userId && sheet.dataset.for) return; // user tapped someone else meanwhile
    actions.innerHTML = `
        ${isContact ? `
            <button class="btn btn-primary member-sheet-btn" onclick="closeMemberSheet(); openDirectMessageScreen('${userId}')">Message</button>
            <button class="btn btn-secondary member-sheet-btn" onclick="closeMemberSheet(); openContactDetailsById('${userId}')">View contact</button>`
        : `<div class="member-sheet-hint">Not in your contacts. Meet in person to connect.</div>`}
        <button class="btn btn-ghost member-sheet-btn member-sheet-danger" onclick="closeMemberSheet(); openProposeRemoval('${userId}', ${JSON.stringify(m.displayName).replace(/"/g, '&quot;')})">Propose removal from group</button>`;
}

function closeMemberSheet() {
    const sheet = document.getElementById('memberSheet');
    if (!sheet) return;
    sheet.classList.remove('open');
    setTimeout(() => sheet.classList.add('hidden'), 180);
}
