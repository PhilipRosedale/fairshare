async function loadMembersList() {
    if (!selectedGroup) return;
    const el = document.getElementById('membersListContent');
    if (!el) return;

    // Look back one month (30 days) for each member's transaction activity.
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

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
        // Peer transactions in this group over the previous month.
        // Exclude automated daily income (those rows have a null from_user).
        db.from('transactions')
            .select('from_user, to_user, amount, created_at')
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
    // Sum each member's transaction total (sent + received) over the previous month.
    const txTotals = {};
    (txns || []).forEach(t => {
        const amt = Number(t.amount) || 0;
        if (t.from_user) txTotals[t.from_user] = (txTotals[t.from_user] || 0) + amt;
        if (t.to_user) txTotals[t.to_user] = (txTotals[t.to_user] || 0) + amt;
    });
    const currencySymbol = selectedGroup.currency_symbol || '';
    const currencyOn = typeof groupCurrencyEnabled === 'function'
        ? groupCurrencyEnabled(selectedGroup) : true;

    el.innerHTML = data.map(m => {
        const sponsor = sponsorMap[m.user_id];
        const isCreator = m.user_id === selectedGroup.created_by;
        const sponsorLabel = isCreator ? 'founder' : (sponsor ? `sponsored by ${esc(sponsor)}` : '');
        const displayName = m.profiles?.display_name || 'Unknown';
        const avatarUrl = m.profiles?.profile_image_url || null;
        const avatarHtml = avatarUrl
            ? `<img class="member-avatar" src="${esc(avatarUrl)}" alt="">`
            : `<div class="member-avatar-placeholder">${esc(displayName.charAt(0).toUpperCase())}</div>`;
        // Member's total transactions over the previous month, shown as a
        // right-aligned pill so the numbers line up in a scannable column.
        const txTotal = txTotals[m.user_id] || 0;
        const txPill = currencyOn
            ? `<span class="member-tx-total"
                     title="Total transactions over the previous month"
                     style="margin-left:auto;padding:3px 10px;border-radius:999px;background:rgba(0,0,0,0.05);font-size:0.72rem;color:var(--dark-gray);white-space:nowrap;">
                   <strong style="font-weight:600;">${esc(currencySymbol)}${txTotal.toFixed(2)}</strong> this month
               </span>`
            : '';
        return `<div class="member-item">
            ${avatarHtml}
            <span class="member-name">${esc(displayName)}</span>
            ${sponsorLabel ? `<span class="member-sponsor">${sponsorLabel}</span>` : ''}
            ${txPill}
        </div>`;
    }).join('');
}
