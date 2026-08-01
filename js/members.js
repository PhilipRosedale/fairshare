async function loadMembersList() {
    if (!selectedGroup) return;
    const el = document.getElementById('membersListContent');
    if (!el) return;

    const monthAgo = new Date(Date.now() - 30 * APP_TIMING.DAY_MS).toISOString();

    const [{ data, error }, { data: sponsorships }, { data: txns }] = await Promise.all([
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
            .not('from_user', 'is', null)
    ]);

    if (error || !data) {
        el.innerHTML = '<p>Failed to load members.</p>';
        return;
    }

    // Update member count display
    const countEl = document.getElementById('memberCountDisplay');
    if (countEl) countEl.textContent = `${data.length} active member${data.length === 1 ? '' : 's'}`;

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
        return `<div class="member-item">
            ${avatarHtml}
            <span class="member-name">${esc(displayName)}</span>
            ${sponsorLabel ? `<span class="member-sponsor">${sponsorLabel}</span>` : ''}
            ${flowHtml}
        </div>`;
    }).join('');
}
