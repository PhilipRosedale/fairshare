function initCreateGroupForm() {
    const toggle = document.getElementById('newCurrencyEnabled');
    const fields = document.getElementById('createGroupCurrencyFields');
    const nameInput = document.getElementById('newCurrencyName');
    const symInput = document.getElementById('newCurrencySymbol');
    const preview = document.getElementById('createGroupCurrencyPreview');
    const votingToggle = document.getElementById('newVotingPeriodEnabled');
    const votingPeriodFields = document.getElementById('createGroupVotingPeriodFields');

    function updatePreview() {
        if (!preview) return;
        const sym = (symInput?.value || 'C').trim() || 'C';
        const cur = (nameInput?.value || 'credits').trim() || 'credits';
        preview.innerHTML = `Balances display as: <strong>${esc(sym)} 100.00 ${esc(cur)}</strong>`;
    }

    function setCurrencyEnabled(on) {
        toggle.classList.toggle('form-switch-on', on);
        toggle.setAttribute('aria-checked', on ? 'true' : 'false');
        fields.classList.toggle('hidden', !on);
        if (nameInput) nameInput.required = on;
        if (symInput) symInput.required = on;
        if (on) updatePreview();
    }

    function setVotingPeriodEnabled(on) {
        votingToggle.classList.toggle('form-switch-on', on);
        votingToggle.setAttribute('aria-checked', on ? 'true' : 'false');
        votingPeriodFields.classList.toggle('hidden', !on);
    }

    toggle.addEventListener('click', () => setCurrencyEnabled(!toggle.classList.contains('form-switch-on')));
    votingToggle.addEventListener('click', () => setVotingPeriodEnabled(!votingToggle.classList.contains('form-switch-on')));
    nameInput?.addEventListener('input', updatePreview);
    symInput?.addEventListener('input', updatePreview);
    setCurrencyEnabled(false);
    setVotingPeriodEnabled(true);
}

function buildDefaultConstitution(name, currencyEnabled, currencyName, currencySymbol, votingPeriodDays) {
    let text = 'We, the people, hereby give this Group Name: ' + name + ' $GROUP_NAME\n\n';
    if (votingPeriodDays > 0) {
        text += 'Voting will happen over a period of ' + votingPeriodDays + ' days $VOTING_PERIOD_DAYS, with the percentage to approve being taken from the number of votes submitted.\n\n';
    }
    if (currencyEnabled) {
        text += 'In economic matters, we choose the Currency Name: ' + currencyName + ' $CURRENCY_NAME, and the Currency Symbol: ' + currencySymbol + ' $CURRENCY_SYMBOL, and to Change Currency Rates: 66% $CHANGE_CURRENCY_RATES_PERCENTAGE of member\'s vote is required.\n\n';
    }
    text += 'To Approve New Member: 100% $NEW_MEMBER_PERCENTAGE of member\'s vote is required.\n\n';
    text += issueTypesClause() + '\n\n';
    text += 'Any member may propose amendment to this constitution. To Approve Amendment: 100% $AMENDMENT_PERCENTAGE of member\'s vote is required.';
    text += '\n\nAny member may write a proposed accord. To Approve a proposed accord: 50% $ACCORD_PERCENTAGE of member\'s vote is required.';
    return text;
}

async function createGroup(e) {
    e.preventDefault();
    const name = document.getElementById('newGroupName').value.trim();
    const currencyEnabled = document.getElementById('newCurrencyEnabled').classList.contains('form-switch-on');
    const currencyName = currencyEnabled
        ? document.getElementById('newCurrencyName').value.trim()
        : 'credits';
    const currencySymbol = currencyEnabled
        ? document.getElementById('newCurrencySymbol').value.trim()
        : 'C';

    if (currencyEnabled && (!currencyName || !currencySymbol)) {
        showToast('Enter a currency name and symbol', 'error');
        return;
    }

    const votingPeriodMode = document.getElementById('newVotingPeriodEnabled').classList.contains('form-switch-on');
    const votingPeriodDays = votingPeriodMode
        ? Math.max(1, parseInt(document.getElementById('newVotingPeriodDays')?.value, 10) || 3)
        : 0;

    const defaultConstitution = buildDefaultConstitution(name, currencyEnabled, currencyName, currencySymbol, votingPeriodDays);

    const { data: group, error: groupError } = await db
        .from('groups')
        .insert({
            name,
            currency_name: currencyName,
            currency_symbol: currencySymbol,
            currency_enabled: currencyEnabled,
            constitution: defaultConstitution,
            created_by: currentUser.id
        })
        .select()
        .single();

    if (groupError) {
        console.error('createGroup error:', groupError);
        showToast(groupError.message, 'error');
        return;
    }

    const { error: memberError } = await db
        .from('members')
        .insert({
            group_id: group.id,
            user_id: currentUser.id,
            status: 'active',
            balance: 0
        });

    if (memberError) {
        console.error('createGroup member error:', memberError);
        showToast(memberError.message, 'error');
        return;
    }

    showToast(`Group "${name}" created!`, 'success');
    closeModal();
    await loadMyGroups(group.id);
}
