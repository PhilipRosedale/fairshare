// tally comes from get_endorsement_tallies: { votes, endorsers }, where votes
// includes Membership votes delegated to the endorsers.
function candidateEndorsementStats(tally, roundOpenedAt, periodDays, memberPct, activeCount) {
    const count = tally?.votes || 0;
    const direct = tally?.endorsers || 0;
    if (!isVotingPeriodMode(selectedGroup?.constitution) || !roundOpenedAt || !periodDays) {
        const threshold = Math.max(1, Math.ceil((activeCount || 0) * memberPct));
        return { count, direct, threshold, periodMode: false };
    }
    const windowEnd = new Date(roundOpenedAt);
    windowEnd.setDate(windowEnd.getDate() + periodDays);
    const expired = new Date() >= windowEnd;
    const threshold = expired
        ? Math.max(1, Math.ceil(count * memberPct))
        : Math.max(1, Math.ceil((activeCount || 0) * memberPct));
    return { count, direct, threshold, periodMode: true, expired };
}

async function loadCandidatesList() {
    if (!selectedGroup) return;
    const el = document.getElementById('candidatesContent');
    if (!el) return;

    await ensureVotingFinalized(selectedGroup.id);

    const { data: candidates, error } = await db
        .from('members')
        .select('*, profiles(display_name)')
        .eq('group_id', selectedGroup.id)
        .eq('status', 'pending');

    if (error || !candidates || candidates.length === 0) {
        el.innerHTML = '<p style="color:var(--dark-gray);">No pending candidates.</p>';
        return;
    }

    const { data: endorsements } = await db
        .from('endorsements')
        .select('candidate_id, endorser_id, created_at')
        .eq('group_id', selectedGroup.id);

    const myEndorsements = new Set();
    (endorsements || []).forEach(e => {
        if (e.endorser_id === currentUser.id) myEndorsements.add(e.candidate_id);
    });

    const periodDays = parseVotingPeriodDays(selectedGroup.constitution);
    const roundKeys = candidates.map(c => 'candidate:' + c.user_id);
    const { data: voteRounds } = await db
        .from('vote_rounds')
        .select('round_key, opened_at')
        .eq('group_id', selectedGroup.id)
        .in('round_key', roundKeys);

    const roundMap = {};
    (voteRounds || []).forEach(r => { roundMap[r.round_key] = r.opened_at; });

    // Get sponsorship info for each candidate (sponsor name + message)
    const candidateIds = candidates.map(c => c.user_id);
    const { data: sponsorships } = await db
        .from('sponsorships')
        .select('candidate_id, message, sponsor:profiles!sponsorships_sponsor_id_fkey(display_name)')
        .eq('group_id', selectedGroup.id)
        .eq('status', 'claimed')
        .in('candidate_id', candidateIds);

    const sponsorMap = {};
    (sponsorships || []).forEach(s => {
        sponsorMap[s.candidate_id] = {
            sponsor_name: s.sponsor?.display_name || 'Unknown',
            message: s.message
        };
    });

    const [{ count: activeCount }, { data: tallies, error: tallyError }] = await Promise.all([
        db.from('members')
            .select('*', { count: 'exact', head: true })
            .eq('group_id', selectedGroup.id)
            .eq('status', 'active'),
        db.rpc('get_endorsement_tallies', { p_group_id: selectedGroup.id })
    ]);
    if (tallyError) console.warn('get_endorsement_tallies:', tallyError);
    const tallyMap = {};
    (tallies || []).forEach(t => { tallyMap[t.candidate_id] = t; });

    const memberPct = parseNewMemberThreshold(selectedGroup.constitution);

    el.innerHTML = candidates.map(c => {
        const endorsed = myEndorsements.has(c.user_id);
        const roundKey = 'candidate:' + c.user_id;
        const stats = candidateEndorsementStats(
            tallyMap[c.user_id],
            roundMap[roundKey],
            periodDays,
            memberPct,
            activeCount
        );
        const delegatedNote = stats.count > stats.direct
            ? ` from ${stats.direct} endorser${stats.direct === 1 ? '' : 's'} incl. delegated`
            : '';
        const endorseLabel = stats.periodMode
            ? `${stats.count}/${stats.threshold} votes (period)${delegatedNote}`
            : `${stats.count}/${stats.threshold} votes${delegatedNote}`;
        const sponsorInfo = sponsorMap[c.user_id];
        return `<div class="member-item" style="flex-direction:column;align-items:stretch;gap:0.5rem;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
                <div>
                    <span class="member-name">${esc(c.profiles?.display_name || 'Unknown')}</span>
                    <span style="font-size:0.8rem;color:var(--dark-gray);margin-left:0.5rem;">${endorseLabel}</span>
                </div>
                <div>
                    ${endorsed
                        ? `<button class="btn btn-danger btn-small" onclick="unendorse('${c.user_id}')">Unendorse</button>`
                        : `<button class="btn btn-success btn-small" onclick="endorse('${c.user_id}')">Endorse</button>`
                    }
                </div>
            </div>
            ${sponsorInfo ? `
                <div style="font-size:0.8rem;color:var(--dark-gray);padding-left:0.5rem;border-left:3px solid var(--medium-gray);">
                    Sponsored by <strong>${esc(sponsorInfo.sponsor_name)}</strong>
                    ${sponsorInfo.message ? `<br><em>"${esc(sponsorInfo.message)}"</em>` : ''}
                </div>
            ` : ''}
        </div>`;
    }).join('');
}

async function endorse(candidateId) {
    const { error } = await db.from('endorsements').insert({
        group_id: selectedGroup.id,
        candidate_id: candidateId,
        endorser_id: currentUser.id
    });
    if (error) { showToast(error.message, 'error'); return; }

    // Check if threshold met
    const { data } = await db.rpc('check_endorsements', {
        p_group_id: selectedGroup.id,
        p_candidate_id: candidateId
    });
    if (data?.admitted) {
        showToast('Candidate admitted to the group!', 'success');
        await loadMyGroups();
    } else {
        showToast(data ? `Endorsement recorded (${data.endorsements}/${data.threshold} votes)` : 'Endorsement recorded', 'info');
    }
    await loadCandidatesList();
}

async function unendorse(candidateId) {
    const { error } = await db.from('endorsements')
        .delete()
        .eq('group_id', selectedGroup.id)
        .eq('candidate_id', candidateId)
        .eq('endorser_id', currentUser.id);
    if (error) { showToast(error.message, 'error'); return; }
    showToast('Endorsement removed', 'info');
    await loadCandidatesList();
}
