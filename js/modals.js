function showModal(type) {
    const overlay = document.getElementById('modalOverlay');
    const body = document.getElementById('modalBody');
    body.classList.remove('beta-ios-modal');
    overlay.classList.remove('hidden');

    switch (type) {
        case 'createGroup':
            body.innerHTML = `
                <h3>Create a Group</h3>
                <form id="createGroupForm">
                    <div class="form-group">
                        <label>Group Name</label>
                        <input type="text" id="newGroupName" required placeholder="e.g. San Francisco Local 94101">
                    </div>
                    <div class="form-toggle-row">
                        <span class="form-toggle-label">Enable Group Currency</span>
                        <button type="button" id="newCurrencyEnabled" class="form-switch" role="switch" aria-checked="false" aria-label="Enable Group Currency">
                            <span class="form-switch-knob"></span>
                        </button>
                    </div>
                    <p class="voting-basis-helper">Members share resources using a credit system they manage collectively.</p>
                    <div id="createGroupCurrencyFields" class="hidden">
                        <div class="form-group">
                            <label>Currency Name (plural if desired, e.g. "credits")</label>
                            <input type="text" id="newCurrencyName" placeholder="e.g. credits, coins, points" value="credits">
                        </div>
                        <div class="form-group">
                            <label>Currency Symbol</label>
                            <input type="text" id="newCurrencySymbol" placeholder="e.g. C, $, ¢" maxlength="5" value="C">
                        </div>
                        <p id="createGroupCurrencyPreview" style="font-size:0.8rem;color:var(--dark-gray);margin-top:0.5rem;">
                            Balances display as: <strong>C 100.00 credits</strong>
                        </p>
                    </div>
                    <div class="form-toggle-row">
                        <span class="form-toggle-label">Enable Voting Period</span>
                        <button type="button" id="newVotingPeriodEnabled" class="form-switch form-switch-on" role="switch" aria-checked="true" aria-label="Enable Voting Period">
                            <span class="form-switch-knob"></span>
                        </button>
                    </div>
                    <div id="createGroupVotingPeriodFields">
                        <div class="voting-period-days-row">
                            <label for="newVotingPeriodDays">Voting Period</label>
                            <input type="number" id="newVotingPeriodDays" min="1" max="365" value="3">
                            <span>days</span>
                        </div>
                        <p class="voting-basis-helper">Voting percentages are among those having voted during the period.</p>
                    </div>
                    <div class="form-actions">
                        <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                        <button type="submit" class="btn btn-primary">Create</button>
                    </div>
                </form>
            `;
            initCreateGroupForm();
            document.getElementById('createGroupForm').addEventListener('submit', (e) => createGroup(e));
            break;

        case 'send':
            loadSendModal();
            break;

        case 'sponsorShareInfo': {
            document.getElementById('modalBody').classList.add('share-modal');
            const loginEmail = currentUser?.email || '';
            const profEmail = currentProfile?.email || '';
            const prefEmail = loginEmail || profEmail;
            const prefPhone = currentProfile?.phone || '';
            const spName = esc(sponsorShareInfoContactName || 'your sponsor');
            body.innerHTML = `
                <h3 class="share-modal-title">Share contact info?</h3>
                <p class="share-modal-sub">Anything you enter is saved to your profile and shared with ${spName}.</p>
                <div class="form-group">
                    <label for="sponsorShareEmail">Email</label>
                    <input type="email" id="sponsorShareEmail" autocomplete="email" value="${esc(prefEmail)}">
                </div>
                <div class="form-group">
                    <label for="sponsorSharePhone">Phone</label>
                    <input type="tel" id="sponsorSharePhone" autocomplete="tel" value="${esc(prefPhone)}">
                </div>
                <div class="form-actions">
                    <button type="button" class="btn btn-secondary" onclick="dismissSponsorShareInfoDialog()">Not now</button>
                    <button type="button" class="btn btn-primary" id="sponsorShareSubmitBtn" onclick="submitSponsorShareInfoDialog()">Share with ${spName}</button>
                </div>
            `;
            break;
        }

        case 'shareChoice': {
            const hasPhone = !!currentProfile?.phone;
            const hasEmail = !!currentProfile?.email;
            const phoneVal = hasPhone ? esc(currentProfile.phone) : 'Add a phone in your profile';
            const emailVal = hasEmail ? esc(currentProfile.email) : 'Add an email in your profile';
            const phoneChecked = shareWithInitialPhone && hasPhone ? 'checked' : '';
            const emailChecked = shareWithInitialEmail && hasEmail ? 'checked' : '';
            document.getElementById('modalBody').classList.add('share-modal');
            body.innerHTML = `
                <h3 class="share-modal-title">Share with ${esc(shareWithContactName || 'contact')}</h3>
                <p class="share-modal-sub">Pick the contact details you'd like to share.</p>
                <div class="share-list">
                    <label class="share-row ${hasPhone ? '' : 'share-row-disabled'}" for="shareCheckPhone">
                        <span class="share-icon">
                            <i data-lucide="phone" aria-hidden="true"></i>
                        </span>
                        <span class="share-text">
                            <span class="share-label">Phone number</span>
                            <span class="share-value">${phoneVal}</span>
                        </span>
                        <input type="checkbox" class="share-check" id="shareCheckPhone" ${phoneChecked} ${hasPhone ? '' : 'disabled'}>
                    </label>
                    <div class="share-divider"></div>
                    <label class="share-row ${hasEmail ? '' : 'share-row-disabled'}" for="shareCheckEmail">
                        <span class="share-icon">
                            <i data-lucide="mail" aria-hidden="true"></i>
                        </span>
                        <span class="share-text">
                            <span class="share-label">Email</span>
                            <span class="share-value">${emailVal}</span>
                        </span>
                        <input type="checkbox" class="share-check" id="shareCheckEmail" ${emailChecked} ${hasEmail ? '' : 'disabled'}>
                    </label>
                </div>
                <div class="form-actions">
                    <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                    <button type="button" class="btn btn-primary" id="shareSaveBtn" onclick="saveShareWithContact()">Save</button>
                </div>
            `;
            break;
        }

        case 'betaIosApp':
            body.classList.add('beta-ios-modal');
            body.innerHTML = `
                <h3 class="beta-ios-title">Try the beta iOS app</h3>
                <p class="beta-ios-copy">
                    Get the native beta on your iPhone through TestFlight for a smoother mobile experience.
                </p>
                <div class="form-actions beta-ios-actions">
                    <button type="button" class="btn btn-secondary" onclick="closeModal()">Not now</button>
                    <button type="button" class="btn btn-primary" onclick="openBetaIosTestFlight(); closeModal();">Try the beta iOS app</button>
                </div>
            `;
            break;

        case 'introContact': {
            document.getElementById('modalBody').classList.remove('share-modal');
            const subj = introSubjectContactId;
            const subjName = esc(introSubjectContactName || 'contact');
            const rows = (contactsLoadedRows || [])
                .filter((r) => {
                    const cid = r.contact?.contact_id;
                    return cid && cid !== subj;
                })
                .slice()
                .sort((a, b) => {
                    const na = (a.profile?.display_name || '').toLowerCase();
                    const nb = (b.profile?.display_name || '').toLowerCase();
                    return na.localeCompare(nb);
                });
            const options = rows.map((r) => {
                const cid = r.contact.contact_id;
                const nm = esc(r.profile?.display_name || 'Unknown');
                return `<option value="${esc(cid)}">${nm}</option>`;
            }).join('');
            body.innerHTML = `
                <h3>Introduce ${subjName}</h3>
                <p style="font-size:0.9rem;color:var(--dark-gray);margin-bottom:0.75rem;">
                    Pick someone from your contacts and add a short message. Both people get a notification.
                </p>
                <div class="form-group">
                    <label for="introContactPick">Introduce to</label>
                    <select id="introContactPick" class="form-control" onchange="syncIntroSendEnabled()">
                        <option value="">Choose a contact\u2026</option>
                        ${options}
                    </select>
                </div>
                <div class="form-group">
                    <label for="introContactMessage">Introductory message</label>
                    <textarea id="introContactMessage" class="form-control" rows="4"
                        placeholder="Say how you know each other or why they should connect."
                        oninput="syncIntroSendEnabled()"></textarea>
                </div>
                <div class="form-actions">
                    <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                    <button type="button" class="btn btn-primary" id="introSendBtn" disabled onclick="submitIntroContactForm()">Send intro</button>
                </div>
            `;
            syncIntroSendEnabled();
            break;
        }

        case 'vouchChoice':
            renderVouchChoiceModal();
            break;

        case 'shareLocationDuration':
            body.innerHTML = `
                <h3>Share your location with ${esc(shareLocationContactName || 'contact')}</h3>
                <p style="font-size:0.9rem;color:var(--dark-gray);margin-bottom:1rem;">How long do you want to share?</p>
                <div class="choice-list">
                    <div class="choice-item"><button type="button" class="btn btn-outline choice-button" onclick="shareLocationDurationChoice(${LOCATION_DURATIONS.HOUR_MS})">For an Hour</button></div>
                    <div class="choice-item"><button type="button" class="btn btn-outline choice-button" onclick="shareLocationDurationChoice(${LOCATION_DURATIONS.DAY_MS})">For a Day</button></div>
                    <div class="choice-item"><button type="button" class="btn btn-outline choice-button" onclick="shareLocationDurationChoice(${LOCATION_DURATIONS.WEEK_MS})">For a Week</button></div>
                    <div class="choice-item"><button type="button" class="btn btn-outline choice-button" onclick="shareLocationDurationChoice(null)">Indefinitely</button></div>
                    <div class="form-actions">
                        <button type="button" class="btn btn-secondary" onclick="cancelShareLocationDialog()">Cancel</button>
                    </div>
                </div>
            `;
            break;

        case 'suggestPicture':
            body.innerHTML = `
                <h3>Suggest new picture</h3>
                <div id="suggestPicCameraWrap" style="display:none;background:#000;border-radius:8px;overflow:hidden;margin-bottom:1rem;aspect-ratio:1;max-height:320px;">
                    <video id="suggestPicVideo" autoplay playsinline muted style="width:100%;height:100%;object-fit:cover;"></video>
                </div>
                <div id="suggestPicPreviewWrap" style="display:none;margin-bottom:1rem;text-align:center;">
                    <img id="suggestPicPreviewImg" class="suggest-pic-preview" alt="Preview">
                </div>
                <div id="suggestPicOptions" class="suggest-pic-options">
                    <button type="button" class="btn btn-outline choice-button" onclick="suggestPicFromFile()">Choose from files</button>
                    <button type="button" class="btn btn-outline choice-button" onclick="suggestPicFromCamera()">Take a picture</button>
                </div>
                <input type="file" id="suggestPicFileInput" accept="image/*" style="display:none;">
                <div class="form-actions">
                    <button type="button" class="btn btn-secondary" onclick="closeSuggestPicModal()">Cancel</button>
                    <button type="button" class="btn btn-primary" id="suggestPicSendBtn" style="display:none;" onclick="suggestPicSend()">Send</button>
                </div>
            `;
            document.getElementById('suggestPicFileInput').addEventListener('change', suggestPicFileSelected);
            break;

        case 'proposeAmendment':
            document.getElementById('modalBody').classList.add('modal-wide');
            {
                const votingPeriodMatch = selectedGroup?.constitution?.match(/(\d+)\s*days?\s*\$VOTING_PERIOD_DAYS/i);
                const votingPeriodDays = votingPeriodMatch ? parseInt(votingPeriodMatch[1], 10) : null;
                const amendmentVoteCopy = votingPeriodDays && votingPeriodDays > 0
                    ? `Members vote for ${votingPeriodDays} day${votingPeriodDays === 1 ? '' : 's'}. Thresholds apply as described in the constitution.`
                    : 'Members vote for the period defined in the constitution (or 7 days if not set). Thresholds apply as described in the constitution.';
            body.innerHTML = `
                <h3>Propose Constitutional Amendment</h3>
                <div class="form-group">
                    <label>Title (short summary)</label>
                    <input type="text" id="amendmentTitle" required placeholder="e.g. Lower amendment threshold to 75%">
                </div>
                <div class="form-group">
                    <label>Edit the constitution below</label>
                    <textarea id="amendmentEditor" rows="8" style="font-family:monospace;font-size:16px;line-height:1.6;"
                        oninput="updateAmendmentPreview()">${esc(stripConstitutionTags(selectedGroup?.constitution || ''))}</textarea>
                </div>
                <div class="form-group">
                    <label>Preview of changes</label>
                    <div id="amendmentDiffPreview" class="diff-display" style="min-height:60px;">
                        <span style="color:var(--dark-gray);">Make changes above to see a preview.</span>
                    </div>
                </div>
                <p style="font-size:0.8rem;color:var(--dark-gray);margin-top:0.5rem;">
                    ${esc(amendmentVoteCopy)}
                </p>
                <div class="form-actions">
                    <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                    <button type="button" class="btn btn-primary" onclick="submitAmendment()">Submit Amendment</button>
                </div>
            `;
            }
            break;

        case 'createProposal': {
            const votingPeriodMatch = selectedGroup?.constitution?.match(/(\d+)\s*days?\s*\$VOTING_PERIOD_DAYS/i);
            const votingPeriodDays = votingPeriodMatch ? parseInt(votingPeriodMatch[1], 10) : null;
            const periodSuffix = votingPeriodDays && votingPeriodDays > 0
                ? `, with a voting period of ${votingPeriodDays} day${votingPeriodDays === 1 ? '' : 's'}`
                : '';
            body.innerHTML = `
                <h3>Create Proposal</h3>
                <div class="form-group">
                    <label>Proposal text</label>
                    <textarea id="proposalEditor" rows="6"
                        placeholder="Clearly describe your proposal here, e.g. 'All group members will wear blue pants at all time.'"></textarea>
                </div>
                <p style="font-size:0.8rem;color:var(--dark-gray);margin-top:0.5rem;">
                    When you press 'Submit Proposal', this proposal will be circulated to all group members for their vote${periodSuffix}.
                </p>
                <div class="form-actions">
                    <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
                    <button type="button" class="btn btn-primary" onclick="submitProposal()">Submit Proposal</button>
                </div>
            `;
            break;
        }
    }
    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
}

function closeModal(_options = {}) {
    if (heartDialogTimer) { clearTimeout(heartDialogTimer); heartDialogTimer = null; }
    if (shareLocationContactId) {
        updateShareLocationCheckbox(shareLocationContactId, false, null);
        shareLocationContactId = null;
        shareLocationContactName = '';
    }
    shareWithContactId = null;
    shareWithContactName = '';
    shareWithInitialPhone = false;
    shareWithInitialEmail = false;
    introSubjectContactId = null;
    introSubjectContactName = '';
    sponsorShareInfoContactId = null;
    sponsorShareInfoContactName = '';
    vouchWithContactId = null;
    vouchWithContactName = '';
    if (typeof _pendingReportTarget !== 'undefined') _pendingReportTarget = null;
    stopSuggestPicStream();
    document.getElementById('modalOverlay').classList.add('hidden');
    document.getElementById('modalBody').classList.remove('modal-wide');
    document.getElementById('modalBody').classList.remove('share-modal');
    document.getElementById('modalBody').classList.remove('beta-ios-modal');
}

function openBetaIosTestFlight() {
    if (IS_NATIVE) return;
    openExternalUrl(BETA_IOS_TESTFLIGHT_URL);
}

function betaIosPromptStorageKey() {
    return `fairshare_beta_ios_prompt_shown_v2_${currentUser?.id || 'anon'}`;
}

function hasShownBetaIosPrompt() {
    try {
        return localStorage.getItem(betaIosPromptStorageKey()) === '1';
    } catch (_) {
        return false;
    }
}

function markBetaIosPromptShown() {
    try {
        localStorage.setItem(betaIosPromptStorageKey(), '1');
    } catch (_) { /* quota / private mode */ }
}

function pendingBetaIosSignupStorageKey() {
    return 'fairshare_beta_ios_signup_pending';
}

function hasPendingBetaIosWebSignup() {
    try {
        const startedAt = Number(localStorage.getItem(pendingBetaIosSignupStorageKey()) || 0);
        return Number.isFinite(startedAt) && startedAt > 0
            && (Date.now() - startedAt) < (7 * APP_TIMING.DAY_MS);
    } catch (_) {
        return false;
    }
}

function clearPendingBetaIosWebSignup() {
    try {
        localStorage.removeItem(pendingBetaIosSignupStorageKey());
    } catch (_) { /* quota / private mode */ }
}

function isRecentSignupForBetaIosPrompt() {
    const createdAt = currentProfile?.created_at;
    if (!createdAt) return false;
    const createdMs = new Date(createdAt).getTime();
    if (!Number.isFinite(createdMs)) return false;
    return (Date.now() - createdMs) < (7 * APP_TIMING.DAY_MS);
}

function shouldOfferBetaIosPromptAfterSignup() {
    if (IS_NATIVE || !currentUser || hasShownBetaIosPrompt()) return false;
    return hasPendingBetaIosWebSignup() || isRecentSignupForBetaIosPrompt();
}

function maybeShowBetaIosPromptAfterSignup() {
    if (IS_NATIVE) return;
    if (!currentUser || !pendingBetaIosPromptAfterPostHandshakeSelfie) return;
    pendingBetaIosPromptAfterPostHandshakeSelfie = false;
    if (!shouldOfferBetaIosPromptAfterSignup()) return;

    const showWhenModalIsFree = () => {
        if (!currentUser) return;
        const overlay = document.getElementById('modalOverlay');
        const modalOpen = overlay && !overlay.classList.contains('hidden');
        if (modalOpen) {
            setTimeout(showWhenModalIsFree, 250);
            return;
        }
        markBetaIosPromptShown();
        clearPendingBetaIosWebSignup();
        showModal('betaIosApp');
    };
    setTimeout(showWhenModalIsFree, 400);
}

function sponsorShareInfoPromptStorageKey(userId, sponsorContactId) {
    return `fairshare_sponsor_share_prompt_${userId}_${sponsorContactId}`;
}

function markSponsorShareInfoPromptDone(contactId) {
    if (!currentUser?.id || !contactId) return;
    try {
        localStorage.setItem(sponsorShareInfoPromptStorageKey(currentUser.id, contactId), '1');
    } catch (_) { /* quota / private mode */ }
}

/** Save email + phone on profiles and sync pref inputs; notify contacts when values change. */
async function persistProfileEmailPhone(emailTrim, phoneTrim) {
    if (!currentUser) throw new Error('Not signed in');
    const email = emailTrim || null;
    const phone = phoneTrim || null;
    const prevEmail = currentProfile?.email || '';
    const prevPhone = currentProfile?.phone || '';
    const { error } = await db.from('profiles').update({ email, phone }).eq('id', currentUser.id);
    if (error) throw error;
    if (currentProfile) {
        currentProfile.email = email;
        currentProfile.phone = phone;
    }
    const prefEmail = document.getElementById('prefEmail');
    const prefPhone = document.getElementById('prefPhone');
    if (prefEmail) prefEmail.value = email || '';
    if (prefPhone) prefPhone.value = phone || '';
    const emailChanged = (email || '') !== prevEmail;
    const phoneChanged = (phone || '') !== prevPhone;
    if (emailChanged || phoneChanged) {
        const displayName = currentProfile?.display_name || currentUser.email || 'Someone';
        const changes = [];
        if (emailChanged) changes.push('email');
        if (phoneChanged) changes.push('phone number');
        const msg = displayName + ' updated their ' + changes.join(' and ') + '.';
        db.rpc('notify_contacts_of_profile_update', { p_actor_id: currentUser.id, p_message: msg })
            .then(({ error: nErr }) => { if (nErr) console.warn('notify profile update error:', nErr); });
    }
}

function openSponsorShareInfoDialog(contactId) {
    if (!contactId || !currentUser) return;
    const row = (contactsLoadedRows || []).find(r => r.contact?.contact_id === contactId);
    sponsorShareInfoContactName = row?.profile?.display_name || 'your sponsor';
    sponsorShareInfoContactId = contactId;
    showModal('sponsorShareInfo');
}

/**
 * After opening the contact-details screen for the user's sponsor, offer to share email/phone once.
 */
function maybeOfferSponsorShareInfo(contactId) {
    if (!contactId || !currentUser || !currentProfile?.sponsor_id) return;
    if (currentProfile.sponsor_id !== contactId) return;
    try {
        if (localStorage.getItem(sponsorShareInfoPromptStorageKey(currentUser.id, contactId)) === '1') return;
    } catch (_) { /* ignore */ }
    requestAnimationFrame(() => {
        if (typeof cdCurrentContactId !== 'undefined' && cdCurrentContactId !== contactId) return;
        openSponsorShareInfoDialog(contactId);
    });
}

function dismissSponsorShareInfoDialog() {
    if (sponsorShareInfoContactId) markSponsorShareInfoPromptDone(sponsorShareInfoContactId);
    closeModal();
}

async function submitSponsorShareInfoDialog() {
    const cid = sponsorShareInfoContactId;
    if (!cid || !currentUser) { closeModal(); return; }

    const emailEl = document.getElementById('sponsorShareEmail');
    const phoneEl = document.getElementById('sponsorSharePhone');
    const email = (emailEl?.value || '').trim();
    const phone = (phoneEl?.value || '').trim();
    if (!email && !phone) {
        showToast('Enter an email or phone number to share.', 'error');
        return;
    }
    if (emailEl && !emailEl.checkValidity()) {
        showToast('Please enter a valid email address.', 'error');
        return;
    }

    const btn = document.getElementById('sponsorShareSubmitBtn');
    if (btn) btn.disabled = true;

    try {
        await persistProfileEmailPhone(email, phone);

        const { data: prior, error: pErr } = await db.from('contact_shared')
            .select('shared_phone, shared_email')
            .eq('user_id', currentUser.id)
            .eq('contact_id', cid)
            .maybeSingle();
        if (pErr) throw pErr;
        const initPhone = !!prior?.shared_phone;
        const initEmail = !!prior?.shared_email;
        const wantPhone = !!phone;
        const wantEmail = !!email;
        const sharedPhone = wantPhone ? phone : null;
        const sharedEmail = wantEmail ? email : null;
        const newlyShared = [];
        if (wantPhone && !initPhone) newlyShared.push('phone');
        if (wantEmail && !initEmail) newlyShared.push('email');

        await db.from('contact_shared').upsert({
            user_id: currentUser.id,
            contact_id: cid,
            shared_phone: sharedPhone,
            shared_email: sharedEmail
        }, { onConflict: 'user_id,contact_id' });

        for (const sharedType of newlyShared) {
            await db.from('contact_shares').insert({
                from_user_id: currentUser.id,
                to_user_id: cid,
                shared_type: sharedType
            });
        }

        const phoneFirst = wantPhone && newlyShared.includes('phone');
        const emailFirst = wantEmail && newlyShared.includes('email');
        const phoneUpdate = wantPhone && !phoneFirst && String(sharedPhone || '') !== String(prior?.shared_phone || '');
        const emailUpdate = wantEmail && !emailFirst && String(sharedEmail || '') !== String(prior?.shared_email || '');
        const sponsorSharePushBody = buildInboundShareEmailPhonePushBody(
            currentProfile?.display_name || 'Someone',
            { phoneFirst, phoneUpdate, emailFirst, emailUpdate }
        );
        if (sponsorSharePushBody) sendInboundShareEmailPhonePush(cid, sponsorSharePushBody);

        const row = (contactsLoadedRows || []).find(r => r.contact?.contact_id === cid);
        if (row) {
            row.sharedByMe = row.sharedByMe || {};
            row.sharedByMe.shared_phone = sharedPhone;
            row.sharedByMe.shared_email = sharedEmail;
        }

        if (typeof cdRefreshProfileShareTogglesIfOpen === 'function') cdRefreshProfileShareTogglesIfOpen(cid);

        markSponsorShareInfoPromptDone(cid);
        if (newlyShared.length > 0) {
            const labels = newlyShared.map(t => (t === 'phone' ? 'phone number' : 'email'));
            const joined = labels.length === 2 ? labels.join(' and ') : labels[0];
            showToast('Shared your ' + joined + '.', 'success');
        } else {
            showToast('Saved to your profile.', 'success');
        }
    } catch (e) {
        console.error('submitSponsorShareInfoDialog:', e);
        showToast('Could not save: ' + (e.message || 'error'), 'error');
        if (btn) btn.disabled = false;
        return;
    }
    closeModal();
}

async function savePreferences(e) {
    e?.preventDefault();
    if (savePreferences._running) return;
    savePreferences._running = true;
    try {
        if (!currentUser) {
            showToast('Session expired — please log in again.', 'error');
            return;
        }

        const form = document.getElementById('preferencesForm');
        if (form && !form.reportValidity()) {
            showToast('Please correct the highlighted field(s).', 'error');
            return;
        }

        const displayName = document.getElementById('prefDisplayName').value.trim();
        const email = document.getElementById('prefEmail').value.trim();
        const phone = document.getElementById('prefPhone').value.trim();
        const prefPreview = document.getElementById('prefPhotoPreview');
        const prevProfileImageUrl = currentProfile?.profile_image_url || null;
        const prevDisplayName = currentProfile?.display_name ?? '';
        const prevEmail = currentProfile?.email || '';
        const prevPhone = currentProfile?.phone || '';
        let profileImageUrl = prevProfileImageUrl;
        /** True when we just uploaded a new file from the prefs picker (public URL may match the old one). */
        let uploadedNewProfilePhoto = false;
        if (prefPreview?._pendingFile) {
            try {
                const file = prefPreview._pendingFile;
                const ext = (file.name && file.name.split('.').pop()) || 'jpg';
                const filePath = `${currentUser.id}/profile.${ext}`;
                const { error: upErr } = await db.storage.from('avatars').upload(filePath, file, { upsert: true });
                if (upErr) throw upErr;
                const { data: urlData } = db.storage.from('avatars').getPublicUrl(filePath);
                profileImageUrl = urlData.publicUrl;
                uploadedNewProfilePhoto = true;
            } catch (err) {
                console.error('Profile photo upload error:', err);
                showToast('Could not upload photo: ' + (err.message || 'error'), 'error');
                return;
            }
        }
        const payload = {
            display_name: displayName || currentUser.email,
            email: email || null,
            phone: phone || null
        };
        if (profileImageUrl !== undefined) payload.profile_image_url = profileImageUrl;

        // Handle push notification toggle
        const pushCheck = document.getElementById('prefPushNotifications');
        if (pushCheck) {
            payload.push_notifications = pushCheck.checked;
            if (pushCheck.checked) {
                await subscribeToPush();
            } else {
                await unsubscribePush();
            }
        }

        // Trust score component weights. The dropdowns only expose integer
        // multipliers 1..5, but we still clamp defensively so a hand-edited
        // DOM value can't smuggle anything weird into the database. An empty /
        // non-numeric value falls back to the historical 2 / 1 / 3 default.
        const weightFields = [
            ['prefWeightDirect',  'trust_weight_direct',  2],
            ['prefWeightMutuals', 'trust_weight_mutuals', 1],
            ['prefWeightTrusted', 'trust_weight_trusted', 3],
        ];
        for (const [inputId, column, fallback] of weightFields) {
            const el = document.getElementById(inputId);
            if (!el) continue;
            const raw = Number(el.value);
            const clamped = Number.isFinite(raw)
                ? Math.max(1, Math.min(5, Math.round(raw)))
                : fallback;
            payload[column] = clamped;
            el.value = String(clamped);
        }

        const { error } = await db.from('profiles').update(payload).eq('id', currentUser.id);
        if (error) {
            showToast('Could not save: ' + error.message, 'error');
            return;
        }
        if (currentProfile) {
            currentProfile.display_name = payload.display_name;
            currentProfile.email = email || null;
            currentProfile.phone = phone || null;
            currentProfile.profile_image_url = profileImageUrl;
            if (pushCheck) currentProfile.push_notifications = pushCheck.checked;
            if ('trust_weight_direct'  in payload) currentProfile.trust_weight_direct  = payload.trust_weight_direct;
            if ('trust_weight_mutuals' in payload) currentProfile.trust_weight_mutuals = payload.trust_weight_mutuals;
            if ('trust_weight_trusted' in payload) currentProfile.trust_weight_trusted = payload.trust_weight_trusted;
        }
        const userDisplay = document.getElementById('userDisplay');
        if (userDisplay) userDisplay.textContent = APP_NAME;
        const headerBust = uploadedNewProfilePhoto ? Date.now() : null;
        setHeaderAvatar(profileImageUrl || null, headerBust);
        showToast('Saved.', 'success');

        if (prefPreview && uploadedNewProfilePhoto) {
            prefPreview._pendingFile = undefined;
        }

        // Notify contacts of profile changes (photo, email, phone).
        const pictureChanged = uploadedNewProfilePhoto
            || !!(profileImageUrl && profileImageUrl !== prevProfileImageUrl);
        const emailChanged = (email || '') !== prevEmail;
        const phoneChanged = (phone || '') !== prevPhone;
        if (pictureChanged) {
            // Dedicated RPC: sends 'profile_picture_updated' notifications so
            // contacts can refresh their cached avatar via Realtime without a
            // full app reload.
            db.rpc('notify_contacts_of_profile_picture_change', { p_actor_id: currentUser.id })
                .then(({ error }) => { if (error) console.warn('notify profile pic change error:', error); });
        }
        if (emailChanged || phoneChanged) {
            const changes = [];
            if (emailChanged) changes.push('email');
            if (phoneChanged) changes.push('phone number');
            const msg = payload.display_name + ' updated their ' + changes.join(' and ') + '.';
            db.rpc('notify_contacts_of_profile_update', { p_actor_id: currentUser.id, p_message: msg })
                .then(({ error }) => { if (error) console.warn('notify profile update error:', error); });
        }
        const displayNameChanged = (prevDisplayName || '').trim() !== (payload.display_name || '').trim();
        if (displayNameChanged) {
            db.rpc('notify_contacts_of_display_name_change', {
                p_actor_id: currentUser.id,
                p_old_display_name: prevDisplayName,
                p_new_display_name: payload.display_name
            }).then(({ error }) => { if (error) console.warn('notify display name change error:', error); });
        }
    } catch (err) {
        console.error('savePreferences failed:', err);
        showToast('Could not save preferences.', 'error');
    } finally {
        savePreferences._running = false;
    }
}

// ---- Suggest Profile Picture helpers ----

function openSuggestPicture(contactId) {
    suggestPicContactId = contactId;
    showModal('suggestPicture');
}

function closeSuggestPicModal() {
    stopSuggestPicStream();
    suggestPicContactId = null;
    closeModal({ refreshContactList: false });
}

function stopSuggestPicStream() {
    if (suggestPicStream) {
        suggestPicStream.getTracks().forEach(t => t.stop());
        suggestPicStream = null;
    }
    const video = document.getElementById('suggestPicVideo');
    if (video) video.srcObject = null;
}

function suggestPicFromFile() {
    const input = document.getElementById('suggestPicFileInput');
    if (input) input.click();
}

function suggestPicFileSelected(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const preview = document.getElementById('suggestPicPreviewImg');
    const previewWrap = document.getElementById('suggestPicPreviewWrap');
    const options = document.getElementById('suggestPicOptions');
    const cameraWrap = document.getElementById('suggestPicCameraWrap');
    const sendBtn = document.getElementById('suggestPicSendBtn');
    stopSuggestPicStream();
    if (cameraWrap) cameraWrap.style.display = 'none';
    if (preview) preview.src = url;
    if (previewWrap) previewWrap.style.display = '';
    if (options) options.style.display = 'none';
    if (sendBtn) {
        sendBtn.style.display = '';
        sendBtn._pendingFile = file;
    }
}

async function suggestPicFromCamera() {
    const cameraWrap = document.getElementById('suggestPicCameraWrap');
    const options = document.getElementById('suggestPicOptions');
    const video = document.getElementById('suggestPicVideo');
    if (!cameraWrap || !video) return;

    if (options) options.style.display = 'none';
    cameraWrap.style.display = '';

    try {
        suggestPicStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 640 } }
        });
        video.srcObject = suggestPicStream;
        await video.play();
    } catch (e) {
        console.error('Suggest pic camera error:', e);
        showToast('Camera unavailable: ' + (e.message || 'error'), 'error');
        closeSuggestPicModal();
        return;
    }

    const sendBtn = document.getElementById('suggestPicSendBtn');
    if (sendBtn) {
        sendBtn.style.display = '';
        sendBtn.textContent = 'Capture';
        sendBtn._captureFromCamera = true;
    }
}

async function suggestPicSend() {
    const sendBtn = document.getElementById('suggestPicSendBtn');
    if (!sendBtn || !suggestPicContactId || !currentUser) return;

    if (sendBtn._captureFromCamera) {
        const video = document.getElementById('suggestPicVideo');
        if (!video || video.readyState < 2) {
            showToast('Camera not ready — please wait a moment.', 'error');
            return;
        }
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
        if (!blob) { showToast('Could not capture image.', 'error'); return; }
        sendBtn._pendingFile = new File([blob], 'suggested.jpg', { type: 'image/jpeg' });
        sendBtn._captureFromCamera = false;

        stopSuggestPicStream();
        const cameraWrap = document.getElementById('suggestPicCameraWrap');
        const previewWrap = document.getElementById('suggestPicPreviewWrap');
        const preview = document.getElementById('suggestPicPreviewImg');
        if (cameraWrap) cameraWrap.style.display = 'none';
        if (preview) preview.src = URL.createObjectURL(sendBtn._pendingFile);
        if (previewWrap) previewWrap.style.display = '';
        sendBtn.textContent = 'Send';
        return;
    }

    const file = sendBtn._pendingFile;
    if (!file) return;

    sendBtn.disabled = true;
    try {
        await sendSuggestedPicture(suggestPicContactId, file);
        showToast('Picture suggestion sent!', 'success');
        closeSuggestPicModal();
    } catch (e) {
        console.error('Suggest picture error:', e);
        showToast('Could not send suggestion: ' + (e.message || 'error'), 'error');
        sendBtn.disabled = false;
    }
}

async function sendSuggestedPicture(contactId, file) {
    const ext = (file.name && file.name.split('.').pop()) || 'jpg';
    const filePath = `${currentUser.id}/suggested_${contactId}_${Date.now()}.${ext}`;
    const { error: upErr } = await db.storage.from('avatars').upload(filePath, file, { upsert: false });
    if (upErr) throw upErr;
    const { data: urlData } = db.storage.from('avatars').getPublicUrl(filePath);
    const imageUrl = urlData.publicUrl;

    const { error: rpcErr } = await db.rpc('suggest_profile_picture', {
        p_actor_id: currentUser.id,
        p_contact_id: contactId,
        p_image_url: imageUrl
    });
    if (rpcErr) throw rpcErr;
}

function showSuggestedPictureDialog(notification) {
    const rawData = typeof notification.data === 'string' ? JSON.parse(notification.data) : notification.data;
    const imageUrl = rawData?.image_url;
    const msg = notification.message || 'Someone suggests a new profile picture';
    if (!imageUrl) {
        showToast(msg, 'info');
        return;
    }

    const overlay = document.getElementById('modalOverlay');
    const body = document.getElementById('modalBody');
    body.innerHTML = `
        <h3>New picture suggestion</h3>
        <p style="font-size:0.9rem;color:var(--dark-gray);margin-bottom:0.75rem;">${esc(msg)}</p>
        <div style="text-align:center;margin-bottom:1rem;">
            <img src="${esc(imageUrl)}" class="suggest-pic-dialog-img" alt="Suggested profile picture">
        </div>
        <div class="form-actions" style="flex-wrap:wrap;gap:0.5rem;">
            <button type="button" class="btn btn-secondary" onclick="closeModal({refreshContactList:false})">Ignore</button>
            <button type="button" class="btn btn-outline" onclick="saveSuggestedPicture('${esc(imageUrl)}')">Save</button>
            <button type="button" class="btn btn-primary" onclick="acceptSuggestedPicture('${esc(imageUrl)}')">Accept</button>
        </div>
    `;
    overlay.classList.remove('hidden');
}

async function acceptSuggestedPicture(imageUrl) {
    if (!currentUser) return;
    try {
        const resp = await fetch(imageUrl);
        if (!resp.ok) throw new Error('Could not download image');
        const blob = await resp.blob();
        const ext = imageUrl.split('.').pop()?.split('?')[0] || 'jpg';
        const file = new File([blob], 'profile.' + ext, { type: blob.type || 'image/jpeg' });
        const filePath = `${currentUser.id}/profile.${ext}`;
        const { error: upErr } = await db.storage.from('avatars').upload(filePath, file, { upsert: true });
        if (upErr) throw upErr;
        const { data: urlData } = db.storage.from('avatars').getPublicUrl(filePath);
        const newUrl = urlData.publicUrl + '?t=' + Date.now();

        const { error } = await db.from('profiles').update({ profile_image_url: newUrl }).eq('id', currentUser.id);
        if (error) throw error;

        if (currentProfile) currentProfile.profile_image_url = newUrl;
        setHeaderAvatar(newUrl);
        showToast('Profile picture updated!', 'success');

        db.rpc('notify_contacts_of_profile_picture_change', { p_actor_id: currentUser.id })
            .then(({ error }) => { if (error) console.warn('notify profile pic change error:', error); });
    } catch (e) {
        console.error('Accept suggested picture error:', e);
        showToast('Could not update picture: ' + (e.message || 'error'), 'error');
        return;
    }
    closeModal({ refreshContactList: false });
}

async function saveSuggestedPicture(imageUrl) {
    try {
        const resp = await fetch(imageUrl);
        if (!resp.ok) throw new Error('Could not download image');
        const blob = await resp.blob();
        const ext = imageUrl.split('.').pop()?.split('?')[0] || 'jpg';
        const mimeType = blob.type || 'image/jpeg';
        const file = new File([blob], 'suggested-profile-picture.' + ext, { type: mimeType });

        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file] });
            showToast('Picture saved.', 'success');
        } else {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'suggested-profile-picture.' + ext;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showToast('Picture saved.', 'success');
        }
    } catch (e) {
        if (e.name === 'AbortError') return;
        console.error('Save suggested picture error:', e);
        showToast('Could not save picture: ' + (e.message || 'error'), 'error');
    }
}

function syncIntroSendEnabled() {
    const sel = document.getElementById('introContactPick');
    const ta = document.getElementById('introContactMessage');
    const btn = document.getElementById('introSendBtn');
    if (!btn || !sel || !ta) return;
    const ok = !!sel.value && !!String(ta.value || '').trim();
    btn.disabled = !ok;
}

async function submitIntroContactForm() {
    if (!introSubjectContactId || !currentUser) {
        closeModal();
        return;
    }
    const sel = document.getElementById('introContactPick');
    const ta = document.getElementById('introContactMessage');
    const otherId = sel?.value;
    const msg = String(ta?.value || '').trim();
    if (!otherId || !msg) return;

    const btn = document.getElementById('introSendBtn');
    if (btn) btn.disabled = true;

    try {
        const { error } = await db.rpc('send_contact_intro', {
            p_contact_a: introSubjectContactId,
            p_contact_b: otherId,
            p_message: msg,
        });
        if (error) throw error;
        showToast('Intro sent.', 'success');
        if (typeof cdRefreshHistoryIfOpen === 'function') {
            cdRefreshHistoryIfOpen(introSubjectContactId);
        }
        closeModal();
    } catch (e) {
        console.error('send_contact_intro error:', e);
        showToast('Could not send intro: ' + (e.message || 'error'), 'error');
        if (btn) btn.disabled = false;
    }
}

// Allow Escape key to close any open modal or overlays
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (!document.getElementById('meetOverlay').classList.contains('hidden')) {
            closeMeetScreen();
        } else if (!document.getElementById('modalOverlay').classList.contains('hidden')) {
            closeModal();
        }
    }
});
