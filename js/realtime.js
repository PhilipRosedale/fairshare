function subscribeToGroup(groupId) {
    // Unsubscribe from previous group channel
    if (groupChannel) {
        db.removeChannel(groupChannel);
        groupChannel = null;
    }

    groupChannel = db.channel(`group-${groupId}`)
        .on('postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'group_events',
              filter: `group_id=eq.${groupId}` },
            (payload) => handleGroupEvent(payload.new)
        )
        .on('postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'chat_messages',
              filter: `group_id=eq.${groupId}` },
            async (payload) => {
                const msg = payload.new;
                // Drop messages from users this user has blocked, both
                // in the chat view and in toast previews.
                if (typeof isUserBlocked === 'function' && isUserBlocked(msg.user_id)) return;

                const msgsEl = document.getElementById('chatMessages');
                if (msgsEl) {
                    appendChatMessage(msg);
                } else if (msg.user_id !== currentUser?.id) {
                    const name = await getDisplayName(msg.user_id);
                    const preview = msg.body.length > 80 ? msg.body.slice(0, 80) + '…' : msg.body;
                    showToast(`💬 ${name}: ${preview}`, 'info');
                }
            }
        )
        .on('postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'document_history',
              filter: `group_id=eq.${groupId}` },
            async (payload) => {
                const edit = payload.new;
                // If we're on the Commons tab, refresh the document display
                if (activeTab === 'commons') {
                    // Only auto-refresh if the editor isn't open (don't clobber in-progress edits)
                    if (!document.getElementById('groupDocEditor')) {
                        await loadGroupDocument();
                    }
                }
                // Toast for other members
                if (edit.user_id !== currentUser?.id) {
                    const name = await getDisplayName(edit.user_id);
                    showToast(`📄 ${name} updated the group document`, 'info');
                }
            }
        )
        .subscribe();
}

async function handleGroupEvent(event) {
    if (!event || !selectedGroup || event.group_id !== selectedGroup.id) return;

    // Don't toast events we triggered ourselves
    const isMine = event.actor_id === currentUser?.id;

    // Show toast to other members (not the actor)
    if (!isMine) {
        showToast(event.summary, 'info');
    }

    // Prepend to the activity log UI (skip transactions — they have their own panel)
    if (event.event_type !== 'payment_received') {
        const logEl = document.getElementById('activityContent');
        if (logEl) {
            const itemHtml = renderActivityItem(event, true);
            logEl.insertAdjacentHTML('afterbegin', itemHtml);

            // Trim to 20 items
            const items = logEl.querySelectorAll('.activity-item');
            if (items.length > 20) {
                for (let i = 20; i < items.length; i++) items[i].remove();
            }
        }
    }

    // Refresh relevant UI based on event type
    switch (event.event_type) {
        case 'rate_change': {
            // Re-fetch group data to update money tab
            const { data: updatedGroup } = await db.from('groups').select('*').eq('id', selectedGroup.id).single();
            if (updatedGroup) {
                selectedGroup = updatedGroup;
                const membership = myGroups.find(m => m.group_id === selectedGroup.id);
                if (membership) membership.groups = updatedGroup;
            }
            if (activeTab === 'money') await renderMoneyTab();
            break;
        }
        case 'member_joined':
        case 'member_sponsored':
        case 'member_left': {
            await loadMyGroups();
            if (activeTab === 'members') await renderMembersTab();
            break;
        }
        case 'group_logo_changed': {
            const { data: updatedGroup } = await db.from('groups').select('*').eq('id', selectedGroup.id).single();
            if (updatedGroup) {
                selectedGroup = updatedGroup;
                const membership = myGroups.find(m => m.group_id === selectedGroup.id);
                if (membership) membership.groups = updatedGroup;
                setGroupAvatar(updatedGroup.logo_url || null, updatedGroup.logo_updated_at);
                renderGroupList();
            }
            break;
        }
        case 'payment_received': {
            // Refresh balance if we are the recipient
            const toUser = event.metadata?.to_user;
            if (toUser === currentUser?.id) {
                const membership = myGroups.find(m => m.group_id === selectedGroup.id);
                if (membership) {
                    const { data: myMember } = await db.from('members').select('balance')
                        .eq('group_id', selectedGroup.id).eq('user_id', currentUser.id).single();
                    if (myMember) {
                        membership.balance = myMember.balance;
                        const balEl = document.getElementById('balanceAmount');
                        if (balEl && groupCurrencyEnabled(selectedGroup)) {
                            balEl.textContent =
                                `${selectedGroup.currency_symbol} ${Number(myMember.balance).toFixed(2)}`;
                        }
                    }
                }
                if (activeTab === 'money') await loadTransactions();
            }
            break;
        }
        case 'amendment_proposed':
        case 'amendment_passed':
        case 'amendment_failed':
        case 'accord_proposed':
        case 'accord_passed':
        case 'accord_failed': {
            if (activeTab === 'governance') await loadConstitutionContent();
            // Amendment pass may have changed group settings
            if (event.event_type === 'amendment_passed') {
                const { data: freshGroup } = await db.from('groups').select('*').eq('id', selectedGroup.id).single();
                if (freshGroup) syncSelectedGroup(freshGroup);
                if (activeTab === 'money') await renderMoneyTab();
            }
            break;
        }
    }
}

async function loadActivityLog() {
    if (!selectedGroup) return;

    const { data, error } = await db
        .from('group_events')
        .select('*')
        .eq('group_id', selectedGroup.id)
        .neq('event_type', 'payment_received')
        .order('created_at', { ascending: false })
        .limit(20);

    const logEl = document.getElementById('activityContent');
    if (error || !data || data.length === 0) {
        logEl.innerHTML = '<p style="color:var(--dark-gray);font-size:0.85rem;">No activity yet.</p>';
        return;
    }

    logEl.innerHTML = data.map(e => renderActivityItem(e, false)).join('');
}

function renderActivityItem(event, highlight) {
    const ago = formatTimeAgo(new Date(event.created_at));
    return `<div class="activity-item${highlight ? ' highlight' : ''}">
        <span class="activity-time">${esc(ago)}</span>
        <span class="activity-summary">${esc(event.summary)}</span>
    </div>`;
}

function formatTimeAgo(date) {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return 'just now';
    const mins = Math.floor(seconds / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return date.toLocaleDateString();
}
