async function loadMyGroups(autoNavigateGroupId) {
    // Verify session is still valid before fetching data
    if (!(await ensureSession())) return;

    const { data, error } = await db
        .from('members')
        .select('*, groups(*)')
        .eq('user_id', currentUser.id)
        .in('status', ['active', 'pending']);

    if (error) { showToast('Failed to load groups', 'error'); return; }
    myGroups = data || [];
    myGroups.forEach(m => {
        if (m.groups) m.groups = syncGroupInMyGroups(m.groups);
    });

    // Fetch member counts for each group
    const groupIds = myGroups.map(m => m.group_id);
    if (groupIds.length > 0) {
        const { data: counts } = await db
            .from('members')
            .select('group_id')
            .in('group_id', groupIds)
            .eq('status', 'active');
        const countMap = {};
        (counts || []).forEach(r => { countMap[r.group_id] = (countMap[r.group_id] || 0) + 1; });
        myGroups.forEach(m => { m._memberCount = countMap[m.group_id] || 0; });
    }

    renderGroupList();

    if (autoNavigateGroupId) {
        const target = myGroups.find(m => m.group_id === autoNavigateGroupId);
        if (target) { selectGroup(target.groups, target); return; }
    }

    if (selectedGroup) {
        const still = myGroups.find(m => m.group_id === selectedGroup.id);
        if (still) {
            selectGroup(still.groups, still);
        } else {
            selectedGroup = null;
            showGroupsList();
        }
    } else {
        showGroupsList();
    }
}

function renderGroupCardLogo(logoUrl, groupName, logoUpdatedAt) {
    if (logoUrl) {
        const src = esc(withImageCacheBust(logoUrl, logoUpdatedAt));
        return `<img class="group-card-logo" src="${src}" alt="${esc(groupName)} logo">`;
    }
    return '<div class="group-card-logo-placeholder" aria-hidden="true"><i data-lucide="users-round" aria-hidden="true"></i></div>';
}

function renderGroupList() {
    const el = document.getElementById('groupList');
    const hint = document.getElementById('groupsEmptyHint');
    if (myGroups.length === 0) {
        el.innerHTML = '';
        hint.classList.remove('hidden');
        return;
    }
    hint.classList.add('hidden');
    el.innerHTML = myGroups.map(m => {
        const groupName = getGroupDisplayName(m.groups);
        return `
        <div class="group-card" onclick="selectGroupById('${m.group_id}')">
            <div class="group-card-main">
                ${renderGroupCardLogo(m.groups.logo_url, groupName, m.groups.logo_updated_at)}
                <div>
                <div class="group-card-name">
                    ${esc(groupName)}
                    ${m.status === 'pending' ? '<span class="group-card-status">pending</span>' : ''}
                </div>
                <div class="group-card-meta">${m._memberCount || 0} member${m._memberCount === 1 ? '' : 's'}</div>
                </div>
            </div>
            <div class="group-card-actions">
                <button class="btn-leave-group" onclick="leaveGroup('${m.group_id}', '${esc(groupName)}', event)" title="Leave group">Leave</button>
                <span class="group-card-arrow">›</span>
            </div>
        </div>
    `;
    }).join('');
    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
}

async function leaveGroup(groupId, groupName, event) {
    event.stopPropagation();
    if (!confirm(`Are you sure you want to leave group ${groupName}?`)) return;

    try {
        const { error } = await db.rpc('leave_group', { p_group_id: groupId });
        if (error) throw error;

        if (selectedGroup?.id === groupId) {
            selectedGroup = null;
            showGroupsList();
        }
        await loadMyGroups();
        showToast(`You have left ${groupName}.`, 'success');
    } catch (err) {
        console.error('Leave group error:', err);
        showToast('Failed to leave group: ' + (err.message || 'error'), 'error');
    }
}

function groupCurrencyEnabled(group) {
    return group?.currency_enabled !== false;
}

function updateGroupTabBar(group) {
    const moneyBtn = document.querySelector('.tab-btn[data-tab="money"]');
    const currencyOn = groupCurrencyEnabled(group);
    if (moneyBtn) moneyBtn.classList.toggle('hidden', !currencyOn);
    if (!currencyOn && activeTab === 'money') activeTab = 'members';
}

function getGroupDisplayName(group) {
    if (!group) return '';
    const constitution = group.constitution || '';
    const tagged = constitution.match(/Group Name:\s*([^\n$]+?)\s*\$GROUP_NAME/i);
    if (tagged?.[1]?.trim()) return tagged[1].trim();
    const labeled = constitution.match(/Group Name:\s*([^\n$]+)/i);
    if (labeled?.[1]?.trim()) return labeled[1].trim();
    return group.name || '';
}

function syncGroupInMyGroups(groupData) {
    if (!groupData?.id) return groupData;
    const displayName = getGroupDisplayName(groupData);
    const syncedGroup = displayName ? { ...groupData, name: displayName } : groupData;
    const membership = myGroups.find(m => m.group_id === syncedGroup.id);
    if (membership) membership.groups = syncedGroup;
    if (selectedGroup?.id === syncedGroup.id) selectedGroup = syncedGroup;
    return syncedGroup;
}

function syncSelectedGroup(freshGroup) {
    if (!freshGroup || !selectedGroup || freshGroup.id !== selectedGroup.id) return;
    const syncedGroup = syncGroupInMyGroups(freshGroup);
    const nameEl = document.getElementById('groupNameDisplay');
    if (nameEl) nameEl.textContent = syncedGroup.name;
    renderGroupList();
}

function selectGroupById(groupId) {
    const membership = myGroups.find(m => m.group_id === groupId);
    if (membership) selectGroup(membership.groups, membership);
}

async function selectGroup(group, membership) {
    selectedGroup = group;
    document.getElementById('groupsScreen').classList.add('hidden');
    document.getElementById('groupView').classList.remove('hidden');

    // Remember this group for next visit
    if (currentProfile?.last_group_id !== group.id) {
        currentProfile.last_group_id = group.id;
        db.from('profiles').update({ last_group_id: group.id }).eq('id', currentUser.id).then();
    }

    // Subscribe to realtime events for this group
    subscribeToGroup(group.id);

    // Show group name at top
    document.getElementById('groupNameDisplay').textContent = getGroupDisplayName(group);
    setGroupAvatar(group.logo_url || null, group.logo_updated_at);
    bindGroupLogoInput();
    updateGroupLogoControl(membership?.status === 'active');

    if (membership.status === 'pending') {
        document.getElementById('tabBar').classList.add('hidden');
        document.getElementById('tabContent').innerHTML =
            '<p style="color:var(--dark-gray);padding:1rem;">Your candidacy is being reviewed by the group members. ' +
            'You will gain access once enough members have endorsed you.</p>';
        document.getElementById('activityLog').classList.add('hidden');
        return;
    }

    document.getElementById('tabBar').classList.remove('hidden');
    document.getElementById('activityLog').classList.remove('hidden');
    updateGroupTabBar(group);

    // Render current tab
    await switchTab(activeTab);

    // Claim daily income if 24h+ since last claim
    if (groupCurrencyEnabled(group) && membership.status === 'active' && Number(group.daily_income) > 0) {
        try {
            const { data: incomeResult } = await db.rpc('claim_daily_income', { p_group_id: group.id });
            if (incomeResult?.claimed) {
                membership.balance = Number(membership.balance) + Number(incomeResult.amount);
                const balEl = document.getElementById('balanceAmount');
                if (balEl) balEl.textContent =
                    `${group.currency_symbol} ${Number(incomeResult.new_balance).toFixed(2)}`;
                showToast(`Daily income: +${group.currency_symbol} ${Number(incomeResult.amount).toFixed(2)}`, 'success');
            }
        } catch (e) {
            console.error('Daily income claim error:', e);
        }
    }

    await loadActivityLog();
}

function showGroupsList() {
    document.body.classList.remove('chat-tab-active');
    const main = document.querySelector('.main-content');
    if (main) {
        main.style.height = '';
        main.style.overflow = '';
    }
    if (typeof resetChatLayoutStyles === 'function') resetChatLayoutStyles();
    if (typeof unbindChatViewportListeners === 'function') unbindChatViewportListeners();
    document.getElementById('groupsScreen').classList.remove('hidden');
    document.getElementById('groupView').classList.add('hidden');
    selectedGroup = null;
    setHeaderAvatar(currentProfile?.profile_image_url || null);
    // Unsubscribe from realtime when leaving a group
    if (groupChannel) {
        db.removeChannel(groupChannel);
        groupChannel = null;
    }
    renderGroupList();
}

function updateGroupLogoControl(isActiveMember) {
    const wrap = document.querySelector('.group-header-avatar-wrap');
    if (!wrap) return;
    wrap.classList.toggle('group-logo-disabled', !isActiveMember);
    wrap.title = isActiveMember ? 'Click to change group logo' : 'Only active members can change the group logo';
}

function bindGroupLogoInput() {
    const input = document.getElementById('groupLogoInput');
    if (!input || input.dataset.bound === '1') return;
    input.addEventListener('change', onGroupLogoSelected);
    input.dataset.bound = '1';
}

function onGroupLogoClick(event) {
    event?.stopPropagation();
    if (!selectedGroup) return;
    const membership = myGroups.find(m => m.group_id === selectedGroup.id);
    if (!membership || membership.status !== 'active') {
        showToast('Only active group members can change the logo.', 'error');
        return;
    }
    const input = document.getElementById('groupLogoInput');
    if (!input) return;
    input.value = '';
    input.click();
}

async function onGroupLogoSelected(event) {
    const file = event?.target?.files?.[0];
    if (!file || !selectedGroup || !currentUser) return;

    const membership = myGroups.find(m => m.group_id === selectedGroup.id);
    if (!membership || membership.status !== 'active') {
        showToast('Only active group members can change the logo.', 'error');
        return;
    }

    const wrap = document.querySelector('.group-header-avatar-wrap');
    wrap?.classList.add('updating');
    try {
        const ext = (file.name && file.name.split('.').pop()) || 'jpg';
        const filePath = `${currentUser.id}/group_${selectedGroup.id}.${ext}`;

        const { error: upErr } = await db.storage.from('avatars').upload(filePath, file, { upsert: true });
        if (upErr) throw upErr;

        const { data: urlData } = db.storage.from('avatars').getPublicUrl(filePath);
        const logoUrl = urlData?.publicUrl;
        if (!logoUrl) throw new Error('Could not create logo URL');

        const { data: rpcData, error: rpcErr } = await db.rpc('update_group_logo', {
            p_group_id: selectedGroup.id,
            p_logo_url: logoUrl
        });
        if (rpcErr) throw rpcErr;

        const logoUpdatedAt = rpcData?.logo_updated_at;
        selectedGroup.logo_url = logoUrl;
        membership.groups.logo_url = logoUrl;
        if (logoUpdatedAt) {
            selectedGroup.logo_updated_at = logoUpdatedAt;
            membership.groups.logo_updated_at = logoUpdatedAt;
        }
        setGroupAvatar(logoUrl, logoUpdatedAt);
        renderGroupList();
        showToast('Group logo updated.', 'success');
    } catch (err) {
        console.error('Group logo update error:', err);
        showToast('Could not update group logo: ' + (err.message || 'error'), 'error');
    } finally {
        wrap?.classList.remove('updating');
        if (event?.target) event.target.value = '';
    }
}
