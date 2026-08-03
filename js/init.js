// Synchronous peek: does Supabase have a cached session in localStorage?
function hasStoredSession() {
    try {
        const storageKey = typeof SUPABASE_AUTH_STORAGE_KEY === 'string'
            ? SUPABASE_AUTH_STORAGE_KEY
            : 'sb-' + (SUPABASE_URL.match(/\/\/([^.]+)\./)?.[1] || '') + '-auth-token';
        const raw = localStorage.getItem(storageKey);
        if (!raw) return false;
        const parsed = JSON.parse(raw);
        return !!(parsed?.access_token || parsed?.currentSession?.access_token);
    } catch { return false; }
}

async function init() {
    document.title = APP_NAME;
    const authHeading = document.querySelector('#authScreen h2');
    if (authHeading) authHeading.textContent = APP_NAME;
    const authSubtitle = document.querySelector('#authScreen .subtitle');
    if (authSubtitle) authSubtitle.textContent = APP_TAG_LINE;

    console.log('[init] Starting…');
    void lockAppToPortrait();
    if (!db) {
        showToast('Could not connect to database. Check Supabase config.', 'error');
        showAuth();
        return;
    }

    // Optimistic startup: if we have a cached session, show the app shell
    // immediately so the user never sees the login screen flash.
    const likelyLoggedIn = hasStoredSession();
    if (likelyLoggedIn) {
        const loadingScreen = document.getElementById('loadingScreen');
        if (loadingScreen) loadingScreen.classList.add('hidden');
        document.getElementById('appScreen').classList.remove('hidden');
    }

    // Check for invite/meet token in URL. Resolve session first so logged-in
    // users who open someone else's handshake link do not store the token or
    // auto-run handlePendingMeet (which would consume the link for signup).
    // NOTE: We use localStorage (not sessionStorage) so the token survives
    // the cross-tab redirect that happens when a new user confirms their
    // email — the confirmation link opens in a new tab where sessionStorage
    // would be empty, causing the sponsorship claim to silently fail.
    const urlParams = new URLSearchParams(window.location.search);
    const inviteToken = urlParams.get('invite');
    const meetToken = urlParams.get('meet');

    let earlySession = null;
    try {
        const { data: { session } } = await db.auth.getSession();
        earlySession = session;
    } catch (_) {}

    if (inviteToken) {
        window.history.replaceState({}, document.title, window.location.pathname);
        if (earlySession) {
            showToast('Share this link with someone who is not yet on FairShare.', 'info');
        } else {
            localStorage.setItem('fairshare_invite', JSON.stringify({
                token: inviteToken,
                savedAt: Date.now()
            }));
            await showInviteBanner(inviteToken);
        }
    } else if (meetToken) {
        window.history.replaceState({}, document.title, window.location.pathname);
        if (earlySession) {
            showToast('Share this link with someone who is not yet on FairShare.', 'info');
        } else {
            localStorage.setItem('fairshare_meet', JSON.stringify({
                token: meetToken,
                savedAt: Date.now(),
                meetSource: 'URL',
            }));
            await showMeetBanner(meetToken);
        }
    } else if (!earlySession) {
        // No URL token, but the user may have rescanned and reloaded the
        // page mid-signup. Re-validate any fresh stored token so the sponsor
        // banner reappears and the signup gate unlocks itself, without ever
        // bypassing the gate based on raw localStorage presence alone.
        const storedInvite = readStoredTokenIfFresh('fairshare_invite', 7 * 24 * 60 * 60 * 1000);
        const storedMeet = readStoredTokenIfFresh('fairshare_meet', 24 * 60 * 60 * 1000);
        if (storedInvite) {
            await showInviteBanner(storedInvite);
        } else if (storedMeet) {
            await showMeetBanner(storedMeet);
        }
    }

    const notifGroupId = urlParams.get('group');
    if (notifGroupId) {
        localStorage.setItem('fairshare_notification_nav', JSON.stringify({
            groupId: notifGroupId,
            tab: urlParams.get('tab') || null
        }));
        if (window.location.search) {
            window.history.replaceState({}, document.title, window.location.pathname);
        }
    }

    // Cold-start deep link from a "profile picture updated" (or similar) push
    // notification. Survives a sign-in round-trip via pendingOpenContactId,
    // which showApp()'s openPendingContactDetailsIfAny() consumes once the
    // contacts list is ready.
    if (urlParams.get('action') === 'view_contact') {
        const notifContactId = urlParams.get('contact');
        if (notifContactId) {
            pendingOpenContactId = notifContactId;
            window.history.replaceState({}, document.title, window.location.pathname);
        }
    }

    if (urlParams.get('action') === 'view_dm') {
        const notifDmContactId = urlParams.get('contact');
        if (notifDmContactId) {
            pendingOpenDmContactId = notifDmContactId;
            window.history.replaceState({}, document.title, window.location.pathname);
        }
    }

    if (urlParams.get('action') === 'contact_intro') {
        const introId = urlParams.get('intro');
        if (introId) {
            pendingContactIntroId = introId;
            window.history.replaceState({}, document.title, window.location.pathname);
        }
    }

    try {
        const session = earlySession ?? (await db.auth.getSession()).data?.session;
        if (session) {
            try { localStorage.setItem('fairshare_has_account', '1'); } catch (_) {}
            currentUser = session.user;
            await loadProfile();
            if (typeof loadDemoAccountsSetting === 'function') await loadDemoAccountsSetting();
            const claimedGroup = await handlePendingInvite();
            const claimedGroupFromMeet = await handlePendingMeet();
            // Either claim may have just updated profiles.sponsor_id (and
            // inserted contacts / pending memberships) server-side. Refresh
            // currentProfile so the UI renders with the post-claim state
            // instead of the stale snapshot from before the RPC ran.
            if (claimedGroup || claimedGroupFromMeet) {
                await loadProfile();
            }
            showApp(claimedGroup || claimedGroupFromMeet);
        } else {
            showAuth();
        }

        // Listen for auth changes
        // IMPORTANT: The callback must NOT await Supabase calls inline.
        // Doing so can corrupt the client's internal lock state, especially
        // after a tab-switch triggers TOKEN_REFRESHED.  We defer heavy work
        // via setTimeout so the auth callback returns synchronously.
        db.auth.onAuthStateChange((event, session) => {
            console.log('[auth] onAuthStateChange:', event);
            if (event === 'SIGNED_IN' && session) {
                try { localStorage.setItem('fairshare_has_account', '1'); } catch (_) {}
                currentUser = session.user;
                // Defer async Supabase work outside the callback
                setTimeout(async () => {
                    try {
                        await loadProfile();
                        if (typeof loadDemoAccountsSetting === 'function') await loadDemoAccountsSetting();
                        const claimedGroup = await handlePendingInvite();
                        const claimedGroupFromMeet = await handlePendingMeet();
                        // Refresh currentProfile if a claim ran — complete_meet /
                        // claim_sponsorship set sponsor_id server-side, so the
                        // snapshot we loaded above is stale. Without this, the
                        // Preferences screen shows "Root user (no sponsor)"
                        // until the user logs out and back in.
                        if (claimedGroup || claimedGroupFromMeet) {
                            await loadProfile();
                        }
                        showApp(claimedGroup || claimedGroupFromMeet);
                    } catch (e) {
                        console.error('[auth] post-SIGNED_IN error:', e);
                    }
                }, 0);
            } else if (event === 'SIGNED_OUT') {
                try { stopLocationSharingUpdates(); } catch (_) { /* best effort */ }
                if (typeof clearContactDetailResumeState === 'function') clearContactDetailResumeState();
                if (typeof clearDirectMessageResumeState === 'function') clearDirectMessageResumeState();
                pendingPostHandshakeSelfieContactId = null;
                pendingPostHandshakeSelfieContactName = null;
                pendingBetaIosPromptAfterPostHandshakeSelfie = false;
                pendingOpenDmContactId = null;
                currentUser = null;
                currentProfile = null;
                if (typeof clearSponsorTokenValidated === 'function') clearSponsorTokenValidated();
                showAuth();
            } else if (event === 'TOKEN_REFRESHED' && session) {
                // Session refreshed successfully — update user reference
                console.log('[auth] Token refreshed OK');
                currentUser = session.user;
                if (typeof refreshNativeLocationSharingAuth === 'function') {
                    refreshNativeLocationSharingAuth();
                }
            }
        });
    } catch (e) {
        console.error('Init error:', e);
        showToast('Connection error: ' + e.message, 'error');
        showAuth();
    }
}

// Read a stored invite/meet token if it was saved recently enough.
// Stale entries are dropped so they never bypass the signup gate later.
function readStoredTokenIfFresh(key, maxAgeMs) {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        if (parsed?.token && typeof parsed.savedAt === 'number'
            && (Date.now() - parsed.savedAt) < maxAgeMs) {
            return parsed.token;
        }
    } catch {
        // Legacy plain-string entry, no savedAt — treat as stale.
    }
    localStorage.removeItem(key);
    return null;
}

// Show invite banner on the auth screen
async function showInviteBanner(token) {
    try {
        const { data, error } = await db.rpc('get_sponsorship_by_token', { p_token: token });
        if (error || data?.error) {
            const msg = data?.error || error?.message || 'Invalid invitation';
            document.getElementById('inviteBannerText').innerHTML =
                `<strong>Invitation issue:</strong> ${esc(msg)}`;
            document.getElementById('inviteBanner').classList.remove('hidden');
            localStorage.removeItem('fairshare_invite');
            if (typeof clearSponsorTokenValidated === 'function') clearSponsorTokenValidated();
            return;
        }

        if (typeof markSponsorTokenValidated === 'function') markSponsorTokenValidated();

        const sponsorName = data?.sponsor_name || 'A Union member';
        const sponsorInitial = sponsorName.charAt(0).toUpperCase() || 'U';
        const sponsorAvatar = data?.profile_image_url
            ? `<img class="invite-sponsor-avatar" src="${esc(data.profile_image_url)}" alt="${esc(sponsorName)}">`
            : `<span class="invite-sponsor-avatar invite-sponsor-avatar-fallback">${esc(sponsorInitial)}</span>`;

        document.getElementById('inviteBannerText').innerHTML =
            `<div class="invite-sponsor-row">${sponsorAvatar}<div class="invite-sponsor-message"><strong class="invite-sponsor-name">${esc(sponsorName)}</strong> wants to sponsor you as a member of the <strong>${esc(data.group_name)}</strong> group!</div></div>` +
            (data.message ? `<div class="invite-sponsor-note"><em>"${esc(data.message)}"</em></div>` : '') +
            `<div class="invite-sponsor-subtext">If you haven't yet created an account, start by making one.</div>`;
        document.getElementById('inviteBanner').classList.remove('hidden');

        // Default to sign-up tab for new users arriving via invite
        switchAuthTab('signup');
    } catch (e) {
        console.error('Failed to load invite details:', e);
    }
}

// In-memory mutex so the getSession() and onAuthStateChange(SIGNED_IN) paths
// in init() don't both fire claim RPCs concurrently. They run in the same JS
// runtime, so a simple boolean is enough — the server also takes a
// transactional FOR UPDATE lock, but routing duplicate calls through a
// no-op here avoids the spurious "already used" error toasts on the second.
let _claimingInvite = false;
let _claimingMeet = false;

// Claim a pending invite after the user has signed in
// Returns the group_id if successfully claimed, so the caller can navigate there
async function handlePendingInvite() {
    if (_claimingInvite) return null;

    // Resolve the token from localStorage first (works when signup and
    // login happen in the same browser/origin), and fall back to the copy
    // we embedded in auth user_metadata at signup. The fallback is what
    // recovers users whose login origin differs from the click origin —
    // e.g. clicked the invite link in mobile Safari but logged in via the
    // iOS native app (capacitor://localhost has its own localStorage).
    let token = null;
    let staleLocal = false;
    const stored = localStorage.getItem('fairshare_invite');
    if (stored) {
        try {
            const parsed = JSON.parse(stored);
            const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
            if (parsed.token && (Date.now() - parsed.savedAt) < SEVEN_DAYS_MS) {
                token = parsed.token;
            } else {
                staleLocal = true;
            }
        } catch {
            // Legacy format (plain string) — treat as a valid token
            token = stored;
        }
    }
    if (!token && currentUser?.user_metadata?.invite_token) {
        token = currentUser.user_metadata.invite_token;
    }
    if (!token) {
        if (staleLocal) localStorage.removeItem('fairshare_invite');
        return null;
    }

    _claimingInvite = true;
    let claimedGroupId = null;
    let consumed = false;
    try {
        const { data, error } = await db.rpc('claim_sponsorship', { p_token: token });
        if (error) {
            const msg = (error.message || '').toLowerCase();
            if (msg.includes('already been used') || msg.includes('already used')) {
                // The signup-time trigger already set sponsor_id from the
                // same token, or a prior successful login already ran the
                // claim. Either way, sponsorship is settled — no toast.
                consumed = true;
            } else if (msg.includes('expired')
                    || msg.includes('not found')
                    || msg.includes('already a member')) {
                // Permanent / terminal failures — token is spent.
                consumed = true;
                showToast('Invite: ' + error.message, 'error');
            } else {
                // Transient failure (network, server). Leave the token in
                // localStorage and user_metadata so the next login retries.
                showToast('Invite: ' + error.message, 'error');
            }
        } else if (data?.success) {
            consumed = true;
            claimedGroupId = data.group_id;
            pendingOpenNewestContact = true;
            if (data.admitted) {
                showToast(`Welcome to "${data.group_name}"! You've been admitted as a member.`, 'success');
            } else {
                showToast(`You've been sponsored to join "${data.group_name}"! Awaiting group endorsement.`, 'success');
            }
        }
    } catch (e) {
        console.error('Failed to claim sponsorship:', e);
        // Network / exception — leave the token alone for retry on next login.
    } finally {
        _claimingInvite = false;
    }

    if (consumed) {
        try { localStorage.removeItem('fairshare_invite'); } catch (_) {}
        if (currentUser?.user_metadata?.invite_token) {
            try {
                await db.auth.updateUser({ data: { invite_token: null } });
            } catch (e) {
                console.warn('Could not clear invite_token from user_metadata:', e);
            }
        }
    }

    // Clean the URL
    if (window.location.search.includes('invite=')) {
        const cleanUrl = window.location.pathname;
        window.history.replaceState({}, document.title, cleanUrl);
    }

    // Hide the invite banner
    document.getElementById('inviteBanner').classList.add('hidden');
    return claimedGroupId;
}

// Show meet banner on the auth screen when arriving via ?meet=TOKEN
async function showMeetBanner(token) {
    try {
        const { data, error } = await db.rpc('get_meet_by_token', { p_token: token });

        // The invitee already signed up with this handshake and is waiting on
        // their confirmation email. Their account is fine -- the token also
        // rides in auth user_metadata -- so keep the stored token and the
        // validated sponsor gate, and point them at Log In rather than
        // telling them the link is spent.
        if (data?.status === 'awaiting_confirmation') {
            document.getElementById('inviteBannerText').innerHTML =
                `<strong>Almost there.</strong> ${esc(data.message || 'Check your email to confirm your account, then log in.')}`;
            document.getElementById('inviteBanner').classList.remove('hidden');
            if (typeof switchAuthTab === 'function') switchAuthTab('login');
            return;
        }

        if (error || data?.error) {
            const msg = data?.error || error?.message || 'Invalid meet link';
            document.getElementById('inviteBannerText').innerHTML =
                `<strong>Meet link issue:</strong> ${esc(msg)}`;
            document.getElementById('inviteBanner').classList.remove('hidden');
            localStorage.removeItem('fairshare_meet');
            if (typeof clearSponsorTokenValidated === 'function') clearSponsorTokenValidated();
            return;
        }

        if (typeof markSponsorTokenValidated === 'function') markSponsorTokenValidated();

        const authHeading = document.querySelector('#authScreen h2');
        if (authHeading) authHeading.style.display = 'none';

        const name = data?.user_name || 'A Union member';
        const photoUrl = data?.profile_image_url;
        const phone = data?.phone;
        const email = data?.email;
        const groupName = data?.group_name;
        const message = data?.message;

        let html = '<div class="meet-landing-card">';
        if (photoUrl) {
            html += `<img class="meet-landing-photo" src="${esc(photoUrl)}" alt="${esc(name)}">`;
        }
        html += `<div class="meet-landing-name">${esc(name)}</div>`;
        if (phone) html += `<div class="meet-landing-detail">\u260E\uFE0F ${esc(phone)}</div>`;
        if (email) html += `<div class="meet-landing-detail">\u2709\uFE0F ${esc(email)}</div>`;
        // The "add as contact" link only renders on the web. Inside the
        // Capacitor native shell, blob:/data: vCard URLs never reach the
        // iOS Contacts app — see prepareMeetVcfLink — so we skip the link
        // entirely there to avoid offering a broken affordance.
        const showAddContactLink = !IS_NATIVE;
        const vcfLinkHtml = showAddContactLink
            ? ', or <a href="#" id="meetAddContact">add as contact</a>'
            : '';

        if (groupName) {
            html += `<div class="meet-landing-group">wants to sponsor you as a member of <strong>${esc(groupName)}</strong></div>`;
            if (message) html += `<div class="invite-sponsor-note"><em>"${esc(message)}"</em></div>`;
            html += `<div class="meet-landing-subtext">Sign up to join the group${vcfLinkHtml}.</div>`;
        } else {
            html += `<div class="meet-landing-group">wants to connect with you on ${esc(APP_NAME)}</div>`;
            html += `<div class="meet-landing-subtext">Sign up below${vcfLinkHtml}.</div>`;
        }
        html += '</div>';

        document.getElementById('inviteBannerText').innerHTML = html;
        document.getElementById('inviteBanner').classList.remove('hidden');

        if (showAddContactLink) {
            const meetUrl = publicAppUrl(`?meet=${encodeURIComponent(token)}`);
            const addContactLink = document.getElementById('meetAddContact');
            if (addContactLink) {
                prepareMeetVcfLink(addContactLink, name, phone, email, meetUrl, photoUrl);
            }
        }

        switchAuthTab('signup');
    } catch (e) {
        console.error('Failed to load meet details:', e);
    }
}

async function prepareMeetVcfLink(linkEl, name, phone, email, meetUrl, photoUrl) {
    let vcf = 'BEGIN:VCARD\r\nVERSION:3.0\r\n';
    vcf += `FN:${name}\r\n`;
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
        vcf += `N:${parts.slice(1).join(' ')};${parts[0]};;;\r\n`;
    } else {
        vcf += `N:${name};;;;\r\n`;
    }
    if (phone) vcf += `TEL;TYPE=CELL:${phone}\r\n`;
    if (email) vcf += `EMAIL:${email}\r\n`;
    if (meetUrl) vcf += `URL:${meetUrl}\r\n`;
    if (photoUrl) {
        try {
            const resp = await fetch(photoUrl);
            const blob = await resp.blob();
            const mime = blob.type || 'image/jpeg';
            const ext = mime.split('/')[1]?.toUpperCase() || 'JPEG';
            const buf = await blob.arrayBuffer();
            const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
            vcf += `PHOTO;ENCODING=b;TYPE=${ext}:${b64}\r\n`;
        } catch {
            // CORS or network issue — skip embedded photo
        }
    }
    vcf += `NOTE:Met via ${APP_NAME}\r\n`;
    vcf += 'END:VCARD';

    const blob = new Blob([vcf], { type: 'text/vcard' });
    const url = URL.createObjectURL(blob);
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

    linkEl.href = url;
    if (!isMobile) {
        linkEl.download = `${name.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_')}.vcf`;
    }
}

// Claim a pending meet token after the user has signed in
// Returns group_id if the meet carried group context (sponsorship)
async function handlePendingMeet() {
    if (_claimingMeet) return null;

    // localStorage first, then fall back to user_metadata (set at signup
    // time). See handlePendingInvite for the cross-origin rationale.
    let token = null;
    let meetSource = 'URL';
    let staleLocal = false;
    const stored = localStorage.getItem('fairshare_meet');
    if (stored) {
        try {
            const parsed = JSON.parse(stored);
            const ONE_DAY_MS = 24 * 60 * 60 * 1000;
            if (parsed.token && (Date.now() - parsed.savedAt) < ONE_DAY_MS) {
                token = parsed.token;
                if (parsed.meetSource === 'F2F') meetSource = 'F2F';
            } else {
                staleLocal = true;
            }
        } catch {
            token = stored;
            meetSource = 'URL';
        }
    }
    if (!token && currentUser?.user_metadata?.meet_token) {
        token = currentUser.user_metadata.meet_token;
    }
    if (!token) {
        if (staleLocal) localStorage.removeItem('fairshare_meet');
        return null;
    }

    _claimingMeet = true;
    let claimedGroupId = null;
    let consumed = false;
    try {
        const { data, error } = await db.rpc('complete_meet', {
            p_token: token,
            p_meet_source: meetSource,
        });
        if (error) {
            const msg = (error.message || '').toLowerCase();
            if (msg.includes('already been used') || msg.includes('already used')) {
                // Either we ran complete_meet successfully on a prior login
                // (and just didn't manage to clear user_metadata) or the
                // token was used elsewhere. sponsor_id is already set from
                // the signup-time trigger; nothing more for us to do.
                consumed = true;
            } else if (msg.includes('expired')
                    || msg.includes('not found')
                    || msg.includes('already a member')
                    || msg.includes('cannot create a contact with yourself')) {
                consumed = true;
                showToast('Meet: ' + error.message, 'error');
            } else {
                // Transient failure — keep the token for retry next login.
                showToast('Meet: ' + error.message, 'error');
            }
        } else {
            consumed = true;
            const contactName = data?.contact_name || 'New contact';
            if (data?.contact_id) {
                pendingPostHandshakeSelfieContactId = data.contact_id;
                pendingPostHandshakeSelfieContactName = data.contact_name || contactName;
                pendingBetaIosPromptAfterPostHandshakeSelfie = true;
            }

            if (data?.group_id) {
                claimedGroupId = data.group_id;
                if (!data?.contact_id) pendingOpenNewestContact = true;
                if (data.admitted) {
                    showToast(`Welcome to "${data.group_name}"! You've been admitted as a member.`, 'success');
                } else {
                    showToast(`You've been sponsored to join "${data.group_name}"! Awaiting group endorsement.`, 'success');
                }
            } else {
                const alreadyContact = Boolean(data?.already_contact)
                    || (data?.contact_id && typeof contactsLoadedRows !== 'undefined'
                        && contactsLoadedRows.some((r) => r.contact?.contact_id === data.contact_id));
                if (!alreadyContact) {
                    showToast(`Connected with ${contactName}!`, 'success');
                }
            }
        }
    } catch (e) {
        console.error('Failed to complete meet:', e);
    } finally {
        _claimingMeet = false;
    }

    if (consumed) {
        try { localStorage.removeItem('fairshare_meet'); } catch (_) {}
        if (currentUser?.user_metadata?.meet_token) {
            try {
                await db.auth.updateUser({ data: { meet_token: null } });
            } catch (e) {
                console.warn('Could not clear meet_token from user_metadata:', e);
            }
        }
    }

    if (window.location.search.includes('meet=')) {
        window.history.replaceState({}, document.title, window.location.pathname);
    }

    document.getElementById('inviteBanner').classList.add('hidden');
    return claimedGroupId;
}
