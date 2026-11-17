async function switchTab(tabName) {
    if (tabName !== 'chat' && typeof unbindChatViewportListeners === 'function') {
        unbindChatViewportListeners();
    }
    document.body.classList.toggle('chat-tab-active', tabName === 'chat');
    if (tabName !== 'chat') {
        const main = document.querySelector('.main-content');
        if (main) {
            main.style.height = '';
            main.style.overflow = '';
        }
        if (typeof resetChatLayoutStyles === 'function') resetChatLayoutStyles();
    }
    if (tabName === 'constitution') tabName = 'governance'; // legacy tab id
    activeTab = tabName;
    document.querySelectorAll('.tab-btn').forEach(btn =>
        btn.classList.toggle('active', btn.dataset.tab === tabName));

    // Hide activity log on chat tab (chat IS the live activity)
    const actLog = document.getElementById('activityLog');
    if (actLog) actLog.classList.toggle('hidden', tabName === 'chat');

    // Check session health before loading data. Ambiguous failures are
    // recoverable; explicit SIGNED_OUT remains the logout path.
    if (!(await ensureSession())) return;

    if (tabName === 'money' && selectedGroup && !groupCurrencyEnabled(selectedGroup)) {
        tabName = 'members';
        activeTab = tabName;
        document.querySelectorAll('.tab-btn').forEach(btn =>
            btn.classList.toggle('active', btn.dataset.tab === tabName));
    }

    switch (tabName) {
        case 'money': await renderMoneyTab(); break;
        case 'members': await renderMembersTab(); break;
        case 'governance': await renderGovernanceTab(); break;
        case 'commons': await renderCommonsTab(); break;
        case 'chat': await renderChatTab(); break;
    }
    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
}

async function renderMoneyTab() {
    if (!selectedGroup || !groupCurrencyEnabled(selectedGroup)) return;
    const membership = myGroups.find(m => m.group_id === selectedGroup.id);
    if (!membership) return;
    const content = document.getElementById('tabContent');

    await ensureVotingFinalized(selectedGroup.id);

    const { data: freshGroup } = await db.from('groups').select('*').eq('id', selectedGroup.id).single();
    if (freshGroup) {
        selectedGroup = freshGroup;
        membership.groups = freshGroup;
    }

    // Fetch user's pending votes
    const { data: myVotes } = await db.from('votes').select('vote_type, value')
        .eq('group_id', selectedGroup.id).eq('user_id', currentUser.id);

    const myFeeVote = myVotes?.find(v => v.vote_type === 'fee_rate');
    const myIncomeVote = myVotes?.find(v => v.vote_type === 'daily_income');
    const balanceDisplay = `${selectedGroup.currency_symbol} ${Number(membership.balance).toFixed(2)}`;

    content.innerHTML = `
        <div class="group-info-bar">
            <div class="info-item">
                <div class="info-label">Your Balance</div>
                <div class="info-value" id="balanceAmount">${balanceDisplay}</div>
            </div>
            <div class="info-item">
                <div class="info-label">Fee Rate</div>
                <div class="info-value">${(Number(selectedGroup.fee_rate) * 100).toFixed(1)}%</div>
                ${myFeeVote
                    ? `<div class="info-my-vote info-vote-link" onclick="showVoteDialog('fee_rate')">Your vote: ${(Number(myFeeVote.value) * 100).toFixed(1)}%</div>`
                    : `<div class="info-vote-link" onclick="showVoteDialog('fee_rate')">vote</div>`}
            </div>
            <div class="info-item">
                <div class="info-label">Daily Income</div>
                <div class="info-value">${selectedGroup.currency_symbol} ${Number(selectedGroup.daily_income).toFixed(2)}</div>
                ${myIncomeVote
                    ? `<div class="info-my-vote info-vote-link" onclick="showVoteDialog('daily_income')">Your vote: ${selectedGroup.currency_symbol} ${Number(myIncomeVote.value).toFixed(2)}</div>`
                    : `<div class="info-vote-link" onclick="showVoteDialog('daily_income')">vote</div>`}
            </div>
        </div>
        <div style="margin-bottom:1.2rem;">
            <button class="btn btn-primary" onclick="showModal('send')">&#10132; Send ${esc(selectedGroup.currency_symbol)}</button>
        </div>
        <h4 style="color:var(--accent-color);margin-bottom:0.5rem;">Recent Transactions</h4>
        <div id="transactionsContent"><p style="color:var(--dark-gray);">Loading…</p></div>
    `;

    await loadTransactions();
}

async function renderMembersTab() {
    if (!selectedGroup) return;
    const content = document.getElementById('tabContent');
    content.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
            <span id="memberCountDisplay" style="font-size:0.9rem;color:var(--dark-gray);">Loading…</span>
            <button class="btn btn-primary btn-small" onclick="startSponsorMeet()">+ Sponsor</button>
        </div>
        <div id="removalVotesContent" class="hidden"></div>
        <div id="myDelegationsContent"></div>
        <h4 style="color:var(--accent-color);margin-bottom:0.5rem;">Members</h4>
        <div id="membersListContent"><p style="color:var(--dark-gray);">Loading…</p></div>
        <h4 style="color:var(--accent-color);margin:1.5rem 0 0.5rem;">Candidates Awaiting Endorsement</h4>
        <div id="candidatesContent"><p style="color:var(--dark-gray);">Loading…</p></div>
    `;

    await Promise.all([loadMembersList(), loadCandidatesList(), loadRemovalVotes()]);
}

async function renderGovernanceTab() {
    if (!selectedGroup) return;
    const content = document.getElementById('tabContent');
    content.innerHTML = `
        <h4 style="color:var(--accent-color);margin-bottom:0.5rem;">Constitution</h4>
        <div id="constitutionContent"><p style="color:var(--dark-gray);">Loading…</p></div>
        <h4 style="color:var(--accent-color);margin:1.5rem 0 0.5rem;">Group Statistics</h4>
        <div id="statsContent"><p style="color:var(--dark-gray);">Loading…</p></div>
    `;

    await Promise.all([loadConstitutionContent(), loadStatsContent()]);
}

async function renderCommonsTab() {
    if (!selectedGroup) return;
    const content = document.getElementById('tabContent');
    content.innerHTML = `
        <h4 style="color:var(--accent-color);margin-bottom:0.5rem;">Shared Document</h4>
        <div id="groupDocContent"><p style="color:var(--dark-gray);">Loading…</p></div>
    `;

    await loadGroupDocument();
}
