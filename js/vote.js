function showVoteDialog(voteType) {
    if (!selectedGroup || !groupCurrencyEnabled(selectedGroup)) {
        showToast('This group does not use currency', 'error');
        return;
    }
    const isFee = voteType === 'fee_rate';
    const label = isFee ? 'Fee Rate' : 'Daily Income';
    const currentVal = isFee
        ? `${(Number(selectedGroup.fee_rate) * 100).toFixed(1)}%`
        : `${selectedGroup.currency_symbol} ${Number(selectedGroup.daily_income).toFixed(2)}`;
    const placeholder = isFee ? 'e.g. 5 for 5%' : 'e.g. 10.00';
    const periodDays = parseVotingPeriodDays(selectedGroup.constitution);
    const periodMode = isVotingPeriodMode(selectedGroup.constitution);
    const hint = periodMode
        ? (isFee
            ? `Enter a percentage (e.g. 5 for 5%). During the ${periodDays}-day voting period, the median applies once enough participants have voted.`
            : `Enter an amount. During the ${periodDays}-day voting period, the median applies once enough participants have voted.`)
        : (isFee
            ? 'Enter a percentage (e.g. 5 for 5%). The group setting will change to the median of all votes once enough members have voted.'
            : 'Enter an amount. The group setting will change to the median of all votes once enough members have voted.');

    const body = document.getElementById('modalBody');
    body.innerHTML = `
        <h3>Vote on ${label}</h3>
        <p style="font-size:0.85rem;color:var(--dark-gray);margin-bottom:0.75rem;">Current value: <strong>${currentVal}</strong></p>
        <form id="voteForm">
            <div class="form-group">
                <label>Your proposed value</label>
                <input type="number" id="voteValue" required min="0" step="any" placeholder="${placeholder}">
            </div>
            <p style="font-size:0.8rem;color:var(--dark-gray);margin-top:0.5rem;">${hint}</p>
            <div class="form-actions">
                <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                <button type="submit" class="btn btn-primary">Submit Vote</button>
            </div>
        </form>
    `;
    document.getElementById('voteForm').addEventListener('submit', (e) => castVote(e, voteType));
    document.getElementById('modalOverlay').classList.remove('hidden');
}

async function castVote(e, voteType) {
    e.preventDefault();
    let value = parseFloat(document.getElementById('voteValue').value);

    // For fee_rate, user enters percentage, store as decimal
    if (voteType === 'fee_rate') {
        value = value / 100;
    }

    // Close any expired round first so this vote opens a fresh one instead of being cleared with it
    await ensureVotingFinalized(selectedGroup.id);

    // Upsert vote (unique constraint on group_id, user_id, vote_type)
    const { error } = await db.from('votes').upsert({
        group_id: selectedGroup.id,
        user_id: currentUser.id,
        vote_type: voteType,
        value: value
    }, { onConflict: 'group_id,user_id,vote_type' });

    if (error) { showToast(error.message, 'error'); return; }

    closeModal();

    // Auto-tally: check if enough members have voted to apply the change
    const { data: tallyResult } = await db.rpc('compute_tally', {
        p_group_id: selectedGroup.id,
        p_vote_type: voteType
    });

    const label = voteType === 'fee_rate' ? 'Fee Rate' : 'Daily Income';
    if (tallyResult?.applied) {
        // Refresh group data
        const { data: updatedGroup } = await db.from('groups').select('*').eq('id', selectedGroup.id).single();
        if (updatedGroup) {
            selectedGroup = updatedGroup;
            const membership = myGroups.find(m => m.group_id === selectedGroup.id);
            if (membership) membership.groups = updatedGroup;
        }
        const displayVal = voteType === 'fee_rate'
            ? `${(tallyResult.median * 100).toFixed(1)}%`
            : `${selectedGroup.currency_symbol} ${Number(tallyResult.median).toFixed(2)}`;
        const delegatedNote = tallyResult.vote_count > (tallyResult.direct_vote_count ?? tallyResult.vote_count) ? ', incl. delegated' : '';
        showToast(`${label} updated to ${displayVal} (${tallyResult.vote_count}/${tallyResult.active_members} member votes${delegatedNote})`, 'success');
    } else {
        showToast(`Vote recorded — ${tallyResult?.vote_count || 0}/${tallyResult?.threshold || '?'} votes needed to apply ${label}`, 'info');
    }

    // Refresh the money tab to show updated rates / "Your vote" line
    if (activeTab === 'money') await renderMoneyTab();
}
