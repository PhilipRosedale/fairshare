let authScanStream = null;
let authScanTimer = null;
let authScanHandled = false;

// True only when an invite/meet token has been *successfully* validated for
// the current session (i.e. showInviteBanner/showMeetBanner returned a real
// sponsor card, not an error). The signup form refuses to reveal its fields
// unless this flag is set, enforcing the "no signup without sponsor" rule
// even if a stale token is sitting in localStorage from an earlier session.
let hasValidatedSponsorToken = false;

function markSponsorTokenValidated() {
    hasValidatedSponsorToken = true;
    // If the signup tab is already on screen, flip the gate immediately so
    // the user sees the sponsor info card + signup fields without having to
    // re-tap the tab.
    const signupForm = document.getElementById('signupForm');
    if (signupForm && !signupForm.classList.contains('hidden')) {
        document.getElementById('signupGate')?.classList.add('hidden');
        document.getElementById('signupFields')?.classList.remove('hidden');
    }
}

function clearSponsorTokenValidated() {
    hasValidatedSponsorToken = false;
}

function hasInviteOrMeetToken() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('invite') || params.get('meet')) return true;
    return hasValidatedSponsorToken;
}

function switchAuthTab(tab) {
    // The "forgot" view is link-triggered (not a real tab), so when it's
    // active we still highlight "login" on the tab bar to reinforce that
    // forgot-password is part of the login flow.
    const tabHighlight = tab === 'forgot' ? 'login' : tab;
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabHighlight));
    document.getElementById('loginForm').classList.toggle('hidden', tab !== 'login');
    document.getElementById('signupForm').classList.toggle('hidden', tab !== 'signup');
    const forgotForm = document.getElementById('forgotForm');
    if (forgotForm) forgotForm.classList.toggle('hidden', tab !== 'forgot');
    if (tab === 'signup') {
        const hasToken = hasInviteOrMeetToken();
        document.getElementById('signupGate').classList.toggle('hidden', hasToken);
        document.getElementById('signupFields').classList.toggle('hidden', !hasToken);
    }
    if (tab === 'forgot') {
        const loginEmail = document.getElementById('loginEmail')?.value?.trim();
        const forgotEmail = document.getElementById('forgotEmail');
        if (forgotEmail && loginEmail && !forgotEmail.value) forgotEmail.value = loginEmail;
    }
}

async function handleLogin(e) {
    e.preventDefault();
    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;

    const { error } = await db.auth.signInWithPassword({ email, password });
    if (error) {
        showToast(error.message, 'error');
    }
}

async function handleForgotPassword(e) {
    e.preventDefault();
    const email = document.getElementById('forgotEmail').value.trim();
    if (!email) return;

    // Always target the public web origin so the email link works even when
    // the user kicked off the flow from the native iOS shell (where
    // window.location.origin is capacitor://localhost).
    const redirectTo = PUBLIC_APP_ORIGIN + '/reset-password.html';

    const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) {
        showToast(error.message, 'error');
        return;
    }
    showToast('If that email is registered, a reset link has been sent.', 'success');
    switchAuthTab('login');
}

async function handleSignup(e) {
    e.preventDefault();
    const name = document.getElementById('signupName').value;
    const email = document.getElementById('signupEmail').value;
    const password = document.getElementById('signupPassword').value;
    const agree = document.getElementById('signupAgree');

    // Apple expects an explicit, blocking agreement to Terms / Privacy /
    // age (18+) at signup for social-with-UGC apps. The checkbox is also
    // marked `required` in the markup, but we double-check here in case
    // someone JS-bypasses it.
    if (agree && !agree.checked) {
        showToast('Please confirm you are 18+ and agree to the Terms.', 'error');
        try { agree.focus(); } catch (_) {}
        return;
    }

    // Embed the handshake token in auth user_metadata so the
    // handle_new_user trigger can set sponsor_id atomically with the
    // auth.users insert. This makes sponsor assignment independent of
    // which browser/device/origin the user later confirms email or logs
    // in from (localStorage is per-origin, so a click on the web that
    // turns into a login in the iOS native app would otherwise lose the
    // token entirely — see init.js comment about cross-tab redirects).
    const data = { display_name: name };
    try {
        const meetRaw = localStorage.getItem('fairshare_meet');
        const inviteRaw = localStorage.getItem('fairshare_invite');
        const meet = meetRaw ? JSON.parse(meetRaw) : null;
        const invite = inviteRaw ? JSON.parse(inviteRaw) : null;
        if (meet?.token && typeof meet.savedAt === 'number'
            && (Date.now() - meet.savedAt) < 24 * 60 * 60 * 1000) {
            data.meet_token = meet.token;
        } else if (invite?.token && typeof invite.savedAt === 'number'
            && (Date.now() - invite.savedAt) < 7 * 24 * 60 * 60 * 1000) {
            data.invite_token = invite.token;
        }
    } catch (_) {
        // Legacy plain-string entry without savedAt — the signup gate
        // already required a freshly-validated token, so we just skip.
    }

    const { error } = await db.auth.signUp({
        email,
        password,
        options: { data }
    });
    if (error) {
        // Map server-side trigger errors to friendlier wording.
        const msg = (error.message || '').toLowerCase();
        if (msg.includes('already been used to create an account')) {
            showToast('This handshake has already been used to create an account. Ask your sponsor for a new link.', 'error');
        } else if (msg.includes('invalid, expired, or already used')) {
            showToast('Your sponsor link is invalid, expired, or already used. Ask for a new one.', 'error');
        } else {
            showToast(error.message, 'error');
        }
    } else {
        if (!IS_NATIVE) {
            try {
                localStorage.setItem('fairshare_beta_ios_signup_pending', String(Date.now()));
            } catch (_) { /* quota / private mode */ }
        }
        showToast('Account created! Check your email to confirm, then log in.', 'success');
        switchAuthTab('login');
    }
}

// Open Terms / Privacy from the signup form. Routes through the shared
// openExternalUrl helper (defined in preferences.js) so the iOS shell
// pops Safari instead of replacing the WebView.
function openSignupTerms() {
    if (typeof openExternalUrl === 'function') {
        openExternalUrl(PUBLIC_APP_ORIGIN + '/terms.html');
    } else {
        window.open(PUBLIC_APP_ORIGIN + '/terms.html', '_blank', 'noopener');
    }
}
function openSignupPrivacy() {
    if (typeof openExternalUrl === 'function') {
        openExternalUrl(PUBLIC_APP_ORIGIN + '/privacy.html');
    } else {
        window.open(PUBLIC_APP_ORIGIN + '/privacy.html', '_blank', 'noopener');
    }
}

async function openAuthScanOverlay() {
    authScanHandled = false;

    // Request camera in the same call stack as the user gesture for iOS Safari.
    // Use the rear camera: the user is holding the phone and pointing it at
    // the sponsor's screen to scan their QR code.
    try {
        authScanStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 } }
        });
    } catch (camErr) {
        console.warn('[auth-scan] Camera access denied or unavailable:', camErr);
        showToast('Could not access camera. Please allow camera permissions.', 'error');
        return;
    }

    const overlay = document.getElementById('authScanOverlay');
    if (overlay) overlay.classList.remove('hidden');

    const video = document.getElementById('authScanVideo');
    if (video) {
        video.srcObject = authScanStream;
        try { await video.play(); } catch (_) { /* iOS sometimes ignores this */ }
    }

    authScanLoop();
}

function authScanLoop() {
    if (authScanHandled) return;

    const video = document.getElementById('authScanVideo');
    const canvas = document.getElementById('authScanCanvas');
    if (!video || !canvas) return;

    if (video.readyState < video.HAVE_ENOUGH_DATA) {
        authScanTimer = requestAnimationFrame(authScanLoop);
        return;
    }

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = (typeof jsQR === 'function')
        ? jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' })
        : null;

    if (code && code.data) {
        let scannedToken = null;
        try {
            const scannedUrl = new URL(code.data);
            scannedToken = scannedUrl.searchParams.get('meet');
        } catch {}
        if (!scannedToken && code.data.startsWith('fairshare-meet:')) {
            scannedToken = code.data.replace('fairshare-meet:', '');
        }
        if (scannedToken && !authScanHandled) {
            authScanHandled = true;
            handleAuthQrScan(scannedToken);
            return;
        }
    }

    authScanTimer = requestAnimationFrame(authScanLoop);
}

async function handleAuthQrScan(token) {
    closeAuthScanOverlay();

    try {
        localStorage.setItem('fairshare_meet', JSON.stringify({
            token: token,
            savedAt: Date.now(),
            meetSource: 'F2F',
        }));
    } catch (e) {
        console.warn('[auth-scan] Could not persist meet token:', e);
    }

    if (typeof showMeetBanner === 'function') {
        await showMeetBanner(token);
    }
}

function closeAuthScanOverlay() {
    if (authScanStream) {
        authScanStream.getTracks().forEach(t => t.stop());
        authScanStream = null;
    }
    const video = document.getElementById('authScanVideo');
    if (video) video.srcObject = null;

    if (authScanTimer) {
        cancelAnimationFrame(authScanTimer);
        authScanTimer = null;
    }

    const overlay = document.getElementById('authScanOverlay');
    if (overlay) overlay.classList.add('hidden');
}

async function logout() {
    console.log('[auth] logout() called');
    // Clean up realtime subscriptions
    if (groupChannel) {
        db.removeChannel(groupChannel);
        groupChannel = null;
    }
    if (contactSharesChannel) {
        db.removeChannel(contactSharesChannel);
        contactSharesChannel = null;
    }
    if (contactEventsChannel) {
        db.removeChannel(contactEventsChannel);
        contactEventsChannel = null;
    }
    if (groupInvitationsChannel) {
        db.removeChannel(groupInvitationsChannel);
        groupInvitationsChannel = null;
    }
    if (typeof directMessageChannel !== 'undefined' && directMessageChannel) {
        db.removeChannel(directMessageChannel);
        directMessageChannel = null;
    }
    if (typeof unbindDirectMessageSubscriptions === 'function') {
        unbindDirectMessageSubscriptions();
    }
    // Stop nearby location tracking
    stopNearbyTracking();
    // Stop location sharing updates
    stopLocationSharingUpdates();
    unsubscribeFromLocationShares();
    stopContactLocationsRefresh();
    // Reset client state
    selectedGroup = null;
    myGroups = [];
    if (typeof clearContactDetailResumeState === 'function') clearContactDetailResumeState();
    if (typeof clearDirectMessageResumeState === 'function') clearDirectMessageResumeState();
    pendingPostHandshakeSelfieContactId = null;
    pendingPostHandshakeSelfieContactName = null;
    pendingContactIntroId = null;
    pendingOpenDmContactId = null;
    introSubjectContactId = null;
    introSubjectContactName = '';
    currentUser = null;
    currentProfile = null;
    profileCache = {};
    if (typeof blockedUserIds !== 'undefined' && typeof blockedUserIds.clear === 'function') {
        blockedUserIds.clear();
    }

    try {
        // Use local scope so signOut clears the local session immediately
        // without needing a server round-trip (which can hang if token expired).
        // Add a timeout guard: if signOut hangs (deadlocked locks), fall through.
        await Promise.race([
            db.auth.signOut({ scope: 'local' }),
            new Promise(resolve => setTimeout(() => {
                console.warn('[auth] signOut hung for ' + (APP_TIMING.SIGN_OUT_TIMEOUT_MS / APP_TIMING.SECOND_MS) + 's — forcing logout');
                resolve();
            }, APP_TIMING.SIGN_OUT_TIMEOUT_MS))
        ]);
    } catch (e) {
        console.warn('[auth] signOut error (ignored):', e);
    }
    // Always return to auth screen, even if signOut failed
    showAuth();
}

function showAuth() {
    const loadingScreen = document.getElementById('loadingScreen');
    if (loadingScreen) loadingScreen.classList.add('hidden');
    document.getElementById('authScreen').classList.remove('hidden');
    document.getElementById('appScreen').classList.add('hidden');
    const installHintFloater = document.getElementById('installHintFloater');
    if (installHintFloater) installHintFloater.classList.add('hidden');
    document.getElementById('userDisplay').textContent = '';
    setHeaderAvatar(null);

    // First-run default: a user who has never signed in here lands on the
    // Sign Up tab so they can scan a sponsor's QR right away. Returning
    // users who have logged in before (and then logged out) keep the Log In
    // tab default. We never override an active sponsor banner — those flows
    // already call switchAuthTab('signup') before showAuth runs.
    let hasAccount = false;
    try { hasAccount = !!localStorage.getItem('fairshare_has_account'); } catch (_) {}
    if (!hasAccount && !hasInviteOrMeetToken()) {
        switchAuthTab('signup');
    }
}

async function showApp(navigateToGroupId) {
    const loadingScreen = document.getElementById('loadingScreen');
    if (loadingScreen) loadingScreen.classList.add('hidden');
    document.getElementById('authScreen').classList.add('hidden');
    document.getElementById('appScreen').classList.remove('hidden');
    document.getElementById('userDisplay').textContent = APP_NAME;
    setHeaderAvatar(currentProfile?.profile_image_url || null);
    initContactsSortPrefs();

    if (!navigateToGroupId) {
        const storedNav = localStorage.getItem('fairshare_notification_nav');
        if (storedNav) {
            try {
                const nav = JSON.parse(storedNav);
                navigateToGroupId = nav.groupId;
                if (nav.tab) activeTab = nav.tab;
            } catch {}
            localStorage.removeItem('fairshare_notification_nav');
        }
    } else {
        localStorage.removeItem('fairshare_notification_nav');
    }

    if (!navigateToGroupId) {
        let resumeDmContactId = null;
        let resumeContactId = null;
        if (!pendingOpenContactId
            && !pendingOpenDmContactId
            && !pendingOpenNewestContact
            && !pendingContactIntroId) {
            if (typeof readDirectMessageResumeContactId === 'function') {
                resumeDmContactId = readDirectMessageResumeContactId();
            }
            if (!resumeDmContactId && typeof readContactDetailResumeContactId === 'function') {
                resumeContactId = readContactDetailResumeContactId();
            }
        }
        if (resumeDmContactId) {
            navigateTo('directMessage', resumeDmContactId);
        } else if (resumeContactId) {
            navigateTo('contactDetails', resumeContactId);
        } else {
            navigateTo('contacts');
        }
    }

    await loadMyGroups(navigateToGroupId || null);

    if (navigateToGroupId) {
        navigateTo('groups');
    }

    // Refresh the blocked-users cache before contacts/chat render so the
    // UI never momentarily shows content from a blocked user.
    try { await loadBlockedUsers(); } catch (e) { console.warn('loadBlockedUsers at login failed:', e); }

    // Defer non-critical work until after the first paint so the UI is
    // interactive as soon as possible.
    setTimeout(async () => {
        subscribeToContactShares();
        subscribeToContactEvents();
        subscribeToContactNotifications();
        subscribeToGroupInvitations();
        if (typeof subscribeToDirectMessages === 'function') subscribeToDirectMessages();
        maybeShowInstallHintFloater();
        if (currentProfile?.push_notifications !== false) subscribeToPush();
        if (typeof openPendingDirectMessageIfAny === 'function') await openPendingDirectMessageIfAny();
        await openPendingContactDetailsIfAny();
        if (typeof openPostHandshakeSelfieIfPending === 'function') {
            await openPostHandshakeSelfieIfPending();
        }
        await checkPendingGroupInvitations();
        await checkPendingSuggestedPictures();
        checkAndStartNearbyTracking();
        // Populate locationSharesOutbound/Inbound from the DB before deciding
        // whether to start the native location pipeline. Without this, a user
        // who has an existing outbound share from a prior session would never
        // kick off plugin.start() at launch (locationSharesOutbound would stay
        // empty until the contact list finished rendering and ran its own
        // loadLocationShares() as a side effect).
        try { await loadLocationShares(); } catch (e) { console.warn('loadLocationShares at login failed:', e); }
        try { await claimUnownedLocationSharesForThisDevice(); } catch (e) { console.warn('claim location shares at login failed:', e); }
        checkAndStartLocationSharing();
        subscribeToLocationShares();
        // Fetch current positions of anyone sharing with us and wire up the
        // realtime/poll refresh so the card/map stays current.
        try { await loadContactLocations(); } catch (e) { console.warn('loadContactLocations at login failed:', e); }
        refreshContactLocationsSubscriptions();
    }, 0);
}

function subscribeToContactShares() {
    if (contactSharesChannel) {
        db.removeChannel(contactSharesChannel);
        contactSharesChannel = null;
    }
    if (!currentUser) return;
    contactSharesChannel = db.channel('contact-shares')
        .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'contact_shares',
            filter: 'to_user_id=eq.' + currentUser.id
        }, async (payload) => {
            const fromId = payload.new?.from_user_id;
            const sharedType = payload.new?.shared_type;
            if (!fromId || !sharedType) return;
            const { data: profile } = await db.from('profiles').select('display_name').eq('id', fromId).single();
            const name = profile?.display_name || 'Someone';
            const msg = sharedType === 'phone' ? (name + ' shared phone number with you.') : (name + ' shared email with you.');
            showToast(msg, 'info');
        })
        .subscribe();
}

function subscribeToContactNotifications() {
    if (contactNotificationsChannel) {
        db.removeChannel(contactNotificationsChannel);
        contactNotificationsChannel = null;
    }
    if (!currentUser) return;
    contactNotificationsChannel = db.channel('contact-notifications')
        .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'contact_notifications',
            filter: 'to_user_id=eq.' + currentUser.id
        }, async (payload) => {
            if (payload.new?.notification_type === 'profile_picture_suggested') {
                const notification = await hydrateContactNotificationData(payload.new);
                showSuggestedPictureDialog(notification);
            } else if (payload.new?.notification_type === 'met_date_set') {
                const msg = payload.new?.message;
                if (msg) showToast(msg, 'info');
                const fromId = payload.new?.from_user_id;
                const metDate = payload.new?.data?.met_date;
                if (fromId && metDate) updateContactMetDate(fromId, metDate);
            } else if (payload.new?.notification_type === 'nearby_alert') {
                const msg = payload.new?.message;
                if (msg) showToast(msg, 'success');
            } else if (payload.new?.notification_type === 'location_share_started') {
                const msg = payload.new?.message;
                if (msg) showToast(msg, 'success');
            } else if (payload.new?.notification_type === 'new_selfie') {
                // In-app display is handled by the contacts.selfie_url UPDATE Realtime event,
                // which also refreshes the selfie strip. This notification exists for push delivery only.
            } else if (payload.new?.notification_type === 'new_contact') {
                // In-app display is handled by subscribeToContactEvents, which
                // opens the new contact's details on the contacts INSERT. This
                // notification exists for APNs / Web Push delivery so the
                // issuer gets a banner when backgrounded or terminated.
            } else if (payload.new?.notification_type === 'profile_picture_updated'
                    || payload.new?.notification_type === 'profile_updated') {
                const fromId = payload.new?.from_user_id;
                const msg = payload.new?.message;
                if (fromId) {
                    try {
                        const { data: fresh } = await db.from('profiles')
                            .select('profile_image_url')
                            .eq('id', fromId)
                            .single();
                        // Use the notification's created_at as the cache-bust token so
                        // same-URL replacements (upsert into the same storage path)
                        // actually reload in the browser.
                        const bust = payload.new?.created_at || Date.now();
                        const url = fresh?.profile_image_url || null;
                        if (typeof updateContactAvatarInList === 'function') {
                            updateContactAvatarInList(fromId, url, bust);
                        }
                        if (typeof cdUpdateHeroAvatar === 'function') {
                            cdUpdateHeroAvatar(fromId, url, bust);
                        }
                    } catch (e) {
                        console.warn('refresh contact avatar after profile update failed:', e);
                    }
                }
                if (msg) showToast(msg, 'info');
            } else if (payload.new?.notification_type === 'contact_intro') {
                const raw = payload.new?.data;
                const d = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
                const introId = d?.intro_id || d?.introId;
                if (introId && typeof showContactIntroDialog === 'function') {
                    await showContactIntroDialog(introId);
                } else if (payload.new?.message) {
                    showToast(payload.new.message, 'info');
                }
            } else if (payload.new?.notification_type === 'display_name_changed') {
                const fromId = payload.new?.from_user_id;
                const msg = payload.new?.message;
                const data = payload.new?.data;
                let newName = data && typeof data.new_display_name === 'string' ? data.new_display_name : null;
                if (fromId && !newName) {
                    try {
                        const { data: fresh } = await db.from('profiles')
                            .select('display_name')
                            .eq('id', fromId)
                            .single();
                        newName = fresh?.display_name || null;
                    } catch (e) {
                        console.warn('refresh contact display name failed:', e);
                    }
                }
                if (fromId && newName) {
                    if (typeof profileCache !== 'undefined' && profileCache[fromId]) {
                        profileCache[fromId].name = newName;
                    }
                    if (typeof updateContactDisplayNameInList === 'function') {
                        updateContactDisplayNameInList(fromId, newName);
                    }
                    if (typeof cdUpdateHeroDisplayName === 'function') {
                        cdUpdateHeroDisplayName(fromId, newName);
                    }
                }
                if (msg) showToast(msg, 'info');
            } else {
                const msg = payload.new?.message;
                if (msg) showToast(msg, 'info');
            }
        })
        .subscribe();
}

function subscribeToContactEvents() {
    if (contactEventsChannel) {
        db.removeChannel(contactEventsChannel);
        contactEventsChannel = null;
    }
    if (!currentUser) return;

    contactEventsChannel = db.channel('contact-events')
        .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'contacts',
            filter: 'user_id=eq.' + currentUser.id
        }, async (payload) => {
            const contactId = payload.new?.contact_id;
            if (!contactId) return;
            if (typeof window !== 'undefined' && window.__suppressContactOpenOnInsert) return;
            await openContactDetailsById(contactId);
        })
        .on('postgres_changes', {
            event: 'UPDATE',
            schema: 'public',
            table: 'contacts',
            filter: 'user_id=eq.' + currentUser.id
        }, async (payload) => {
            const contactId = payload.new?.contact_id;
            const oldSelfie = payload.old?.selfie_url || '';
            const newSelfie = payload.new?.selfie_url || '';
            if (!contactId || !newSelfie || oldSelfie === newSelfie) return;

            updateContactSelfieInList(contactId, newSelfie);

            const recentUploadAt = recentSelfieUploads[contactId] || 0;
            if (Date.now() - recentUploadAt < APP_TIMING.CONTACT_SELFIE_DEDUPE_MS) {
                delete recentSelfieUploads[contactId];
                return;
            }

            // The other side just posted a selfie. If we happen to have our
            // own "Take a selfie" overlay open for the same contact, dismiss
            // it — no point in both people capturing the same moment twice.
            if (typeof isSelfieOverlayOpenFor === 'function'
                && isSelfieOverlayOpenFor(contactId)
                && typeof closeSelfieOverlay === 'function') {
                closeSelfieOverlay();
            }

            const { data: profile } = await db.from('profiles').select('display_name').eq('id', contactId).single();
            const name = profile?.display_name || 'Someone';
            showToast(name + ' took a new selfie with you.', 'info');
        })
        .subscribe();
}

async function checkPendingSuggestedPictures() {
    if (!currentUser) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('action') !== 'suggested_picture') return;
    window.history.replaceState({}, document.title, window.location.pathname);
    await fetchAndShowSuggestedPicture();
}

async function fetchAndShowSuggestedPicture() {
    if (!currentUser) return;
    try {
        const { data, error } = await db
            .from('contact_notifications')
            .select('*')
            .eq('to_user_id', currentUser.id)
            .eq('notification_type', 'profile_picture_suggested')
            .order('created_at', { ascending: false })
            .limit(1);
        if (error || !data || data.length === 0) return;
        const notification = await hydrateContactNotificationData(data[0]);
        showSuggestedPictureDialog(notification);
    } catch (e) {
        console.error('fetchAndShowSuggestedPicture error:', e);
    }
}

async function hydrateContactNotificationData(notificationRow) {
    const notification = Object.assign({}, notificationRow);
    if (notification.data?.image_url) return notification;
    try {
        const { data: notifData } = await db.rpc('get_contact_notification_data', {
            p_notification_id: notification.id
        });
        if (notifData) notification.data = notifData;
    } catch (e) {
        console.warn('get_contact_notification_data fallback failed:', e);
    }
    return notification;
}

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data?.type === 'notification-click') {
            handleNotificationNavigation('/' + (event.data.search || ''));
        }
    });
}


// Toggle password field visibility (eye button on login/signup).
function togglePasswordVisibility(btn) {
    const input = btn.closest('.password-field').querySelector('input');
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    btn.innerHTML = '<i data-lucide="' + (reveal ? 'eye-off' : 'eye') + '" aria-hidden="true"></i>';
    btn.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
}


// Social sign-in (Google / Apple) via Supabase OAuth.
async function handleOAuthLogin(provider) {
    const label = provider === 'apple' ? 'Apple' : 'Google';
    try {
        const { data, error } = await db.auth.signInWithOAuth({ provider: provider, options: { skipBrowserRedirect: true } });
        if (error) { showToast(label + ' sign-in is not enabled yet: ' + error.message, 'error'); return; }
        if (data && data.url) { showToast(label + ' is connected. Redirect handling is the next setup step.', 'success'); }
        else { showToast(label + ' returned no redirect. Check the Supabase provider config.', 'error'); }
    } catch (e) { showToast(label + ' sign-in is not available yet.', 'error'); }
}


// Loading state for the Log In / Create Account buttons.
// Wraps the existing handlers so the submit button disables and shows progress
// while the request runs. If the wrap ever fails, the original handler still
// runs, so auth is never broken by this.
(function () {
    function wrap(name, busyLabel) {
        const orig = window[name];
        if (typeof orig !== 'function' || orig.__loadingWrapped) return;
        async function wrapped(e) {
            const btn = (e && e.target && e.target.querySelector)
                ? e.target.querySelector('button[type="submit"]') : null;
            let prevText;
            if (btn) { prevText = btn.textContent; btn.disabled = true; btn.textContent = busyLabel; }
            try {
                return await orig.call(this, e);
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = prevText; }
            }
        }
        wrapped.__loadingWrapped = true;
        window[name] = wrapped;
    }
    wrap('handleLogin', 'Signing in...');
    wrap('handleSignup', 'Creating account...');
})();
