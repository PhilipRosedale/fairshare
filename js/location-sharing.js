const LOCATION_SHARING_INSTANCE_KEY = 'union_location_sharing_instance_id';
const LOCATION_SHARING_POLL_MS = APP_TIMING.FOREGROUND_LOCATION_POLL_MS;
const NATIVE_LOCATION_STATUS_WARNING_MS = 10 * APP_TIMING.MINUTE_MS;
// How often the viewer polls inbound-sharer positions as a safety net. Realtime
// (when enabled on user_locations) does the heavy lifting; this catches any
// missed events and covers the case where the publication migration hasn't
// been applied yet.
const INBOUND_LOCATION_POLL_MS = APP_TIMING.INBOUND_LOCATION_POLL_MS;
const EARTH_RADIUS_MI = 3958.8;
const FEET_PER_MILE = 5280;
const LOCATION_UPLOAD_FUNCTION_URL = SUPABASE_URL + '/functions/v1/location-upload';
let contactLocationsCache = {}; // contact_id -> { lat, lng }
let nativeLocationStatusWarningLastAt = 0;

function getLocationSharingInstanceId() {
    try {
        let id = localStorage.getItem(LOCATION_SHARING_INSTANCE_KEY);
        if (!id) {
            id = crypto?.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(16).slice(2);
            localStorage.setItem(LOCATION_SHARING_INSTANCE_KEY, id);
        }
        return id;
    } catch (_) {
        return 'volatile-' + String(Date.now());
    }
}

function getLocationSharingPlatform() {
    if (IS_NATIVE) return NATIVE_PLATFORM === 'android' ? 'android' : 'ios';
    return 'web';
}

function getLocationSharingUserAgent() {
    try {
        return String(navigator.userAgent || '').slice(0, 500);
    } catch (_) {
        return '';
    }
}

function getLocationSharingSourceMetadata() {
    return {
        source_instance_id: getLocationSharingInstanceId(),
        source_platform: getLocationSharingPlatform(),
        source_user_agent: getLocationSharingUserAgent()
    };
}

function toggleShareLocation(contactId, enabled) {
    if (!currentUser) return;
    if (!enabled) {
        stopSharingLocation(contactId);
        return;
    }
    const row = contactsLoadedRows.find(r => r.contact.contact_id === contactId);
    shareLocationContactId = contactId;
    shareLocationContactName = row?.profile?.display_name || 'contact';
    showModal('shareLocationDuration');
}

async function shareLocationWithContact(contactId, duration) {
    if (!currentUser) return;
    const expiresAt = duration ? new Date(Date.now() + duration).toISOString() : null;
    const sourceMetadata = getLocationSharingSourceMetadata();
    try {
        const { error } = await db
            .from('location_shares')
            .upsert({
                from_user_id: currentUser.id,
                to_user_id: contactId,
                started_at: new Date().toISOString(),
                expires_at: expiresAt,
                ...sourceMetadata
            }, { onConflict: 'from_user_id,to_user_id' });
        if (error) throw error;

        try {
            await claimAllLocationSharesForThisDevice();
        } catch (claimErr) {
            console.warn('claim location shares after sharing failed:', claimErr);
        }
        locationSharesOutbound[contactId] = {
            expires_at: expiresAt,
            source_instance_id: sourceMetadata.source_instance_id,
            source_platform: sourceMetadata.source_platform
        };
        updateShareLocationCheckbox(contactId, true, expiresAt);
        checkAndStartLocationSharing();

        const displayName = currentProfile?.display_name || 'Someone';
        const msg = displayName + ' started sharing location with you';
        db.from('contact_notifications').insert({
            to_user_id: contactId,
            from_user_id: currentUser.id,
            notification_type: 'location_share_started',
            message: msg
        }).then(({ error: nErr }) => {
            if (nErr) console.warn('location share notification error:', nErr);
        });
        db.rpc('send_push_to_users', {
            p_user_ids: [contactId],
            p_actor_id: currentUser.id,
            p_title: APP_NAME,
            p_body: msg
        }).then(({ error: pErr }) => {
            if (pErr) console.warn('location share push error:', pErr);
        });
    } catch (e) {
        console.error('shareLocationWithContact error:', e);
        showToast('Could not share location.', 'error');
        updateShareLocationCheckbox(contactId, false, null);
    }
}

async function stopSharingLocation(contactId) {
    if (!currentUser) return;
    try {
        const { error } = await db
            .from('location_shares')
            .delete()
            .eq('from_user_id', currentUser.id)
            .eq('to_user_id', contactId);
        if (error) throw error;

        delete locationSharesOutbound[contactId];
        updateShareLocationCheckbox(contactId, false, null);
        checkAndStartLocationSharing();
    } catch (e) {
        console.error('stopSharingLocation error:', e);
        showToast('Could not stop sharing location.', 'error');
        updateShareLocationCheckbox(contactId, true, locationSharesOutbound[contactId]?.expires_at || null);
    }
}

function updateShareLocationCheckbox(contactId, checked, expiresAt) {
    const cb = document.querySelector(`.contact-share-location-checkbox[data-contact-id="${contactId}"]`);
    if (cb) cb.checked = checked;
    const span = document.getElementById('share-loc-remaining-' + contactId);
    if (span) {
        const text = checked ? formatLocationShareRemaining(expiresAt) : '';
        span.textContent = text;
        span.style.display = text ? '' : 'none';
    }
    // Broadcast so the Contact Details screen can re-sync its toggle.
    try {
        window.dispatchEvent(new CustomEvent('union:locationShareChanged', {
            detail: { contactId, sharing: !!checked, expiresAt: expiresAt || null }
        }));
    } catch (_) { /* best effort */ }
}

function hasAnyActiveLocationShares() {
    const now = Date.now();
    return Object.values(locationSharesOutbound).some(s =>
        isLocationShareOwnedByThisDevice(s) &&
        (s.expires_at === null || new Date(s.expires_at).getTime() > now)
    );
}

function isLocationShareOwnedByThisDevice(share) {
    return !share?.source_instance_id || share.source_instance_id === getLocationSharingInstanceId();
}

function describeLocationShareSource(share) {
    if (isLocationShareOwnedByThisDevice(share)) return 'this device';
    switch (share?.source_platform) {
        case 'ios': return 'an iPhone';
        case 'android': return 'an Android phone';
        case 'web': return 'a web browser';
        default: return 'another device';
    }
}

function dispatchLocationSharesChanged() {
    try {
        window.dispatchEvent(new CustomEvent('union:locationShareChanged', { detail: {} }));
    } catch (_) { /* best effort */ }
}

function canReclaimLocationShareOwnership() {
    return IS_NATIVE && NATIVE_PLATFORM !== 'android';
}

// iOS uploads from the native plugin (passive wakes, no polling). Web and
// Android have no native uploader yet, so they poll while the app is open.
function hasNativeBackgroundLocation() {
    return IS_NATIVE && NATIVE_PLATFORM !== 'android';
}

function checkAndStartLocationSharing() {
    const active = hasAnyActiveLocationShares();
    const outboundIds = Object.keys(locationSharesOutbound || {});
    console.log('[location-sharing] checkAndStartLocationSharing: active=', active,
        'outbound contact ids=', outboundIds);
    if (active) {
        startLocationSharingUpdates();
    } else {
        stopLocationSharingUpdates();
    }
}

function startLocationSharingUpdates() {
    if (locationSharingActive) return;
    locationSharingActive = true;

    console.log('[location-sharing] startLocationSharingUpdates: IS_NATIVE=', IS_NATIVE,
        'outboundShares=', Object.keys(locationSharesOutbound || {}).length);

    if (hasNativeBackgroundLocation()) {
        startNativeLocationSharing();
    } else {
        sendSharingLocationPoll();
        locationSharingInterval = setInterval(sendSharingLocationPoll, LOCATION_SHARING_POLL_MS);
    }
    startShareRemainingTimer();
}

async function getNativeLocationSharingConfig() {
    if (!currentUser || !db?.auth?.getSession) return null;
    const { data, error } = await db.auth.getSession();
    if (error) {
        console.warn('[location-sharing] could not read auth session for native grant:', error);
        return null;
    }
    const accessToken = data?.session?.access_token;
    const sourceMetadata = getLocationSharingSourceMetadata();
    if (!accessToken || !sourceMetadata.source_instance_id) return null;

    let grantData = null;
    try {
        const resp = await fetch(LOCATION_UPLOAD_FUNCTION_URL, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + accessToken,
                'apikey': SUPABASE_ANON_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                action: 'grant',
                instanceId: sourceMetadata.source_instance_id,
                sourcePlatform: sourceMetadata.source_platform,
                sourceUserAgent: sourceMetadata.source_user_agent
            })
        });
        grantData = await resp.json().catch(() => null);
        if (!resp.ok || !grantData?.uploadGrant) {
            console.warn('[location-sharing] native grant mint failed:', resp.status, grantData);
            return null;
        }
    } catch (e) {
        console.warn('[location-sharing] native grant request failed:', e);
        return null;
    }

    return {
        anonKey: SUPABASE_ANON_KEY,
        uploadUrl: grantData.uploadUrl || LOCATION_UPLOAD_FUNCTION_URL,
        uploadGrant: grantData.uploadGrant,
        uploadGrantExpiresAt: grantData.expiresAt || null,
        userId: currentUser.id,
        instanceId: sourceMetadata.source_instance_id,
        sourcePlatform: sourceMetadata.source_platform,
        sourceUserAgent: sourceMetadata.source_user_agent
    };
}

async function startNativeLocationSharing() {
    if (!IS_NATIVE || NATIVE_PLATFORM === 'android') return;
    try {
        const plugin = Capacitor.Plugins.BackgroundLocation;
        if (!plugin) {
            console.warn('[location-sharing] BackgroundLocation plugin not registered on this native build');
            return;
        }
        if (!startNativeLocationSharing._listenerAttached) {
            plugin.addListener('locationUpdate', (pos) => {
                console.log('[location-sharing] native locationUpdate', pos);
                nativeLocationLastPosition = { lat: pos.lat, lng: pos.lng };
                nativeLocationLastAt = Date.now();
            });
            startNativeLocationSharing._listenerAttached = true;
        }
        const config = await getNativeLocationSharingConfig();
        if (!config) {
            console.warn('[location-sharing] native start skipped: missing auth config');
            maybeWarnNativeLocationSharingStatus({ hasSupabaseConfig: false });
            return;
        }
        await plugin.start(config);
        console.log('[location-sharing] native plugin.start resolved');
        await logNativeLocationSharingStatus(plugin);
    } catch (e) {
        console.warn('Native BackgroundLocation start failed:', e);
    }
}

function refreshNativeLocationSharingAuth() {
    if (!IS_NATIVE || !hasAnyActiveLocationShares()) return;
    startNativeLocationSharing();
}

/**
 * Logs sharer/viewer ground truth for background-location debugging (Supabase row,
 * share expiry, instance_id vs native plugin diagnostics). Call after resume or
 * when uploads appear stale.
 */
async function logLocationSharingDiagnostics(context) {
    if (!currentUser) return;
    const label = context ? String(context) : 'manual';
    const prefix = '[location-diagnostics]';
    const instanceId = getLocationSharingInstanceId();
    const now = Date.now();
    const outboundSummary = {};
    let anyExpired = false;
    let anyInstanceMismatch = false;

    for (const [contactId, share] of Object.entries(locationSharesOutbound || {})) {
        const expiresAt = share?.expires_at || null;
        const expired = expiresAt ? new Date(expiresAt).getTime() <= now : false;
        const owned = isLocationShareOwnedByThisDevice(share);
        if (expired) anyExpired = true;
        if (!owned) anyInstanceMismatch = true;
        outboundSummary[contactId] = {
            expires_at: expiresAt,
            expired,
            source_instance_id: share?.source_instance_id || null,
            owned_by_this_device: owned
        };
    }

    let ownLocation = null;
    try {
        const { data, error } = await db
            .from('user_locations')
            .select('user_id, lat, lng, updated_at, source_instance_id, source_platform')
            .eq('user_id', currentUser.id)
            .maybeSingle();
        if (error) throw error;
        ownLocation = data;
        if (ownLocation?.updated_at) {
            const ageMin = Math.round((now - new Date(ownLocation.updated_at).getTime()) / APP_TIMING.MINUTE_MS);
            ownLocation._ageMinutes = ageMin;
        }
    } catch (e) {
        console.warn(prefix, label, 'user_locations read failed:', e);
    }

    console.log(prefix, label, {
        instanceId,
        outbound: outboundSummary,
        inboundContactIds: Object.keys(locationSharesInbound || {}),
        ownLocation,
        anyExpired,
        anyInstanceMismatch
    });

    if (anyExpired) {
        console.warn(prefix, label, 'One or more outbound shares are expired — RLS may block uploads until sharing is restarted.');
    }
    if (anyInstanceMismatch) {
        console.warn(prefix, label, 'source_instance_id does not match this device — uploads may be rejected by RLS.');
    }
    // iOS only uploads after movement or app open, so an old row is expected there.
    if (!hasNativeBackgroundLocation() && ownLocation?._ageMinutes != null &&
        ownLocation._ageMinutes >= 5 && hasAnyActiveLocationShares()) {
        console.warn(prefix, label, 'user_locations.updated_at is', ownLocation._ageMinutes, 'min old while sharing is active.');
    }

    if (IS_NATIVE && NATIVE_PLATFORM !== 'android') {
        try {
            const plugin = Capacitor.Plugins.BackgroundLocation;
            if (plugin && typeof plugin.getStatus === 'function') {
                const status = await plugin.getStatus();
                console.log(prefix, label, 'native', status);
            }
        } catch (e) {
            console.warn(prefix, label, 'native getStatus failed:', e);
        }
    }
}

if (typeof window !== 'undefined') {
    window.logLocationSharingDiagnostics = logLocationSharingDiagnostics;
}

function resumeLocationSharingAfterForeground() {
    if (!currentUser) return;
    refreshShareRemainingTimers();
    checkAndStartLocationSharing();
    refreshNativeLocationSharingAuth();
    resubscribeContactLocationsRealtime();
    startContactLocationsPolling();
    void logLocationSharingDiagnostics('foreground-resume');
}

async function logNativeLocationSharingStatus(plugin) {
    if (!plugin || typeof plugin.getStatus !== 'function') return;
    try {
        const status = await plugin.getStatus();
        console.log('[location-sharing] native status', status);
        maybeWarnNativeLocationSharingStatus(status);
    } catch (e) {
        console.warn('[location-sharing] native getStatus failed:', e);
    }
}

function maybeWarnNativeLocationSharingStatus(status) {
    if (!status) return;
    const now = Date.now();
    if ((now - nativeLocationStatusWarningLastAt) < NATIVE_LOCATION_STATUS_WARNING_MS) return;

    let message = '';
    if (status.authorizationStatus && status.authorizationStatus !== 'authorizedAlways') {
        message = 'Background sharing needs Location set to Always in iOS Settings.';
    } else if (status.allowsBackgroundLocationUpdates === false) {
        message = 'Background location is not active yet. Keep Union open briefly, then try again.';
    } else if (status.hasSupabaseConfig === false || status.hasUploadGrant === false) {
        message = 'Background sharing could not read your session. Reopen Union and try sharing again.';
    }

    if (!message) return;
    nativeLocationStatusWarningLastAt = now;
    console.warn('[location-sharing] native background sharing warning:', message, status);
    if (typeof showToast === 'function') {
        showToast(message, 'error');
    }
}

function stopLocationSharingUpdates() {
    locationSharingActive = false;
    if (locationSharingInterval) {
        clearInterval(locationSharingInterval);
        locationSharingInterval = null;
    }
    stopShareRemainingTimer();

    // Always disable native background uploads when sharing stops. One-shot GPS
    // lookups can restart Core Location later without keeping uploads armed.
    if (IS_NATIVE && NATIVE_PLATFORM !== 'android') {
        try {
            const plugin = Capacitor.Plugins.BackgroundLocation;
            if (plugin) {
                plugin.stop().catch(err => console.warn('[location-sharing] plugin.stop rejected:', err));
            }
        } catch (e) {
            console.warn('Native BackgroundLocation stop failed:', e);
        }
    }
}

async function sendSharingLocationPoll() {
    if (!currentUser) return;
    try {
        console.log('[location-sharing] poll tick, requesting GPS');
        const pos = await getGPSLocation();
        if (!pos) {
            console.warn('[location-sharing] poll got no GPS position');
            return;
        }
        console.log('[location-sharing] poll got GPS', pos);
        await sendSharingLocationUpdate(pos.lat, pos.lng);
    } catch (e) {
        console.warn('Location sharing poll failed:', e);
    }
}

async function sendSharingLocationUpdate(lat, lng) {
    if (!currentUser) return;
    if (!hasAnyActiveLocationShares()) return;
    // This is one of three intentional user_locations writers: foreground
    // sharing, nearby notifications, and the native background plugin.
    try {
        const { error } = await db
            .from('user_locations')
            .upsert({
                user_id: currentUser.id,
                lat: lat,
                lng: lng,
                updated_at: new Date().toISOString(),
                ...getLocationSharingSourceMetadata()
            }, { onConflict: 'user_id' });
        if (error) {
            console.warn('[location-sharing] upsert error:', error);
        } else {
            console.log('[location-sharing] upserted user_locations', { lat, lng });
        }
    } catch (e) {
        console.warn('Location sharing update failed:', e);
    }
}

function formatLocationShareRemaining(expiresAt) {
    if (!expiresAt) return '';
    const remaining = new Date(expiresAt).getTime() - Date.now();
    if (remaining <= 0) return '';
    const minutes = Math.ceil(remaining / APP_TIMING.MINUTE_MS);
    if (minutes < 60) return 'For next ' + minutes + ' minute' + (minutes === 1 ? '' : 's');
    const hours = Math.ceil(remaining / APP_TIMING.HOUR_MS);
    if (hours < 24) return 'For next ' + hours + ' hour' + (hours === 1 ? '' : 's');
    const days = Math.ceil(remaining / APP_TIMING.DAY_MS);
    return 'For next ' + days + ' day' + (days === 1 ? '' : 's');
}

function startShareRemainingTimer() {
    if (shareRemainingTimer) return;
    shareRemainingTimer = setInterval(refreshShareRemainingTimers, APP_TIMING.SHARE_REMAINING_REFRESH_MS);
}

function stopShareRemainingTimer() {
    if (shareRemainingTimer) {
        clearInterval(shareRemainingTimer);
        shareRemainingTimer = null;
    }
}

function refreshShareRemainingTimers() {
    const now = Date.now();
    let anyExpired = false;
    for (const [contactId, share] of Object.entries(locationSharesOutbound)) {
        if (share.expires_at && new Date(share.expires_at).getTime() <= now) {
            delete locationSharesOutbound[contactId];
            updateShareLocationCheckbox(contactId, false, null);
            anyExpired = true;
            continue;
        }
        updateShareLocationCheckbox(contactId, true, share.expires_at);
    }
    if (anyExpired) {
        checkAndStartLocationSharing();
    }
}

async function loadLocationShares() {
    if (!currentUser) return;
    try {
        let { data: shares, error } = await db
            .from('location_shares')
            .select('from_user_id, to_user_id, expires_at, source_instance_id, source_platform')
            .or('from_user_id.eq.' + currentUser.id + ',to_user_id.eq.' + currentUser.id);
        if (error && /source_instance_id/i.test(error.message || '')) {
            const fallback = await db
                .from('location_shares')
                .select('from_user_id, to_user_id, expires_at')
                .or('from_user_id.eq.' + currentUser.id + ',to_user_id.eq.' + currentUser.id);
            shares = fallback.data;
            error = fallback.error;
        }
        if (error) throw error;

        locationSharesOutbound = {};
        locationSharesInbound = {};
        const now = new Date().toISOString();
        (shares || []).forEach(s => {
            if (s.expires_at && s.expires_at < now) return;
            if (s.from_user_id === currentUser.id) {
                locationSharesOutbound[s.to_user_id] = {
                    expires_at: s.expires_at,
                    source_instance_id: s.source_instance_id || null,
                    source_platform: s.source_platform || null
                };
            } else {
                locationSharesInbound[s.from_user_id] = { expires_at: s.expires_at };
            }
        });
    } catch (e) {
        console.error('loadLocationShares error:', e);
    }
}

async function claimUnownedLocationSharesForThisDevice() {
    if (!currentUser) return;
    const meta = getLocationSharingSourceMetadata();
    const instanceId = meta.source_instance_id;
    if (!instanceId) return;
    const nowIso = new Date().toISOString();
    const notExpired = 'expires_at.is.null,expires_at.gt.' + nowIso;
    try {
        // Rows never bound to a device are legacy and safe for the current
        // signed-in client to adopt.
        const { error: e1 } = await db
            .from('location_shares')
            .update(meta)
            .eq('from_user_id', currentUser.id)
            .is('source_instance_id', null)
            .or(notExpired);
        if (e1) throw e1;
        if (canReclaimLocationShareOwnership()) {
            // A native reinstall creates a new localStorage instance id while
            // the DB still has active shares tied to the old install. Let iOS
            // reclaim those rows, but do not let web logins steal ownership
            // from the phone that is responsible for background uploads.
            const { error: e2 } = await db
                .from('location_shares')
                .update(meta)
                .eq('from_user_id', currentUser.id)
                .neq('source_instance_id', instanceId)
                .or(notExpired);
            if (e2) throw e2;
        }
        await loadLocationShares();
    } catch (e) {
        console.warn('claimUnownedLocationSharesForThisDevice failed:', e);
    }
}

// A user has a single `user_locations` row, so one device uploads for all of
// their shares. Turning sharing on (or "Share from this device") moves every
// active outbound share here; the previous device sees the change and stops.
async function claimAllLocationSharesForThisDevice() {
    if (!currentUser) return;
    const meta = getLocationSharingSourceMetadata();
    if (!meta.source_instance_id) return;
    const { error } = await db
        .from('location_shares')
        .update(meta)
        .eq('from_user_id', currentUser.id)
        .or('expires_at.is.null,expires_at.gt.' + new Date().toISOString());
    if (error) throw error;
    await loadLocationShares();
}

async function shareLocationFromThisDevice() {
    if (!currentUser) return;
    try {
        await claimAllLocationSharesForThisDevice();
    } catch (e) {
        console.error('shareLocationFromThisDevice error:', e);
        showToast('Could not move location sharing to this device.', 'error');
        return;
    }
    checkAndStartLocationSharing();
    dispatchLocationSharesChanged();
}

function subscribeToLocationShares() {
    if (locationSharesChannel) {
        db.removeChannel(locationSharesChannel);
        locationSharesChannel = null;
    }
    if (!currentUser) return;
    locationSharesChannel = db.channel('location-shares')
        .on('postgres_changes', {
            event: '*',
            schema: 'public',
            table: 'location_shares',
            filter: 'to_user_id=eq.' + currentUser.id
        }, () => {
            handleLocationSharesChanged();
        })
        .on('postgres_changes', {
            event: '*',
            schema: 'public',
            table: 'location_shares',
            filter: 'from_user_id=eq.' + currentUser.id
        }, () => {
            handleLocationSharesChanged();
        })
        .subscribe();
}

function unsubscribeFromLocationShares() {
    if (locationSharesChannel) {
        db.removeChannel(locationSharesChannel);
        locationSharesChannel = null;
    }
}

async function handleLocationSharesChanged() {
    await loadLocationShares();
    checkAndStartLocationSharing();
    dispatchLocationSharesChanged();
    await loadContactLocations();
    refreshContactLocationsSubscriptions();
    if (activeMainView === 'contacts') {
        const openRow = document.querySelector('.contact-row.expanded');
        const openCid = openRow?.dataset?.contactId;
        await loadAndRenderContactList();
        if (openCid) expandContactRow(openCid);
    }
}

// Keep the viewer's view of each inbound sharer's position fresh. We both
// subscribe to Realtime UPDATE/INSERT events on `user_locations` (server-side
// filtered by RLS to rows this user is allowed to see) and run a slow poll as
// a fallback in case Realtime is not enabled on the table yet.
function refreshContactLocationsSubscriptions() {
    const inboundIds = Object.keys(locationSharesInbound || {});
    if (inboundIds.length === 0) {
        stopContactLocationsRefresh();
        return;
    }
    startContactLocationsRealtime();
    startContactLocationsPolling();
}

/** Drop and recreate the viewer Realtime channel (e.g. after long background). */
function resubscribeContactLocationsRealtime() {
    if (contactLocationsChannel) {
        try { db.removeChannel(contactLocationsChannel); } catch (_) { /* noop */ }
        contactLocationsChannel = null;
    }
    if (Object.keys(locationSharesInbound || {}).length > 0) {
        startContactLocationsRealtime();
    }
}

function startContactLocationsRealtime() {
    if (contactLocationsChannel) return;
    if (!currentUser) return;
    try {
        contactLocationsChannel = db.channel('contact-locations')
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'user_locations'
            }, (payload) => {
                const row = payload.new || payload.old;
                if (!row || !row.user_id) return;
                // We only care about inbound sharers. RLS should already limit
                // what we receive, but double-check client-side.
                if (!locationSharesInbound[row.user_id]) return;
                if (payload.eventType === 'DELETE') {
                    delete contactLocationsCache[row.user_id];
                } else if (typeof row.lat === 'number' && typeof row.lng === 'number') {
                    contactLocationsCache[row.user_id] = {
                        lat: row.lat,
                        lng: row.lng,
                        updated_at: row.updated_at || new Date().toISOString()
                    };
                }
                try {
                    window.dispatchEvent(new CustomEvent('union:contactLocationsLoaded'));
                } catch (_) { /* best effort */ }
            })
            .subscribe();
    } catch (e) {
        console.warn('startContactLocationsRealtime failed:', e);
    }
}

function startContactLocationsPolling() {
    if (contactLocationsPollInterval) return;
    document.addEventListener('visibilitychange', handleContactLocationsVisibility);
    window.addEventListener('focus', handleContactLocationsFocus);
    contactLocationsPollInterval = setInterval(() => {
        loadContactLocations();
    }, INBOUND_LOCATION_POLL_MS);
}

function stopContactLocationsRefresh() {
    if (contactLocationsChannel) {
        try { db.removeChannel(contactLocationsChannel); } catch (_) { /* noop */ }
        contactLocationsChannel = null;
    }
    if (contactLocationsPollInterval) {
        clearInterval(contactLocationsPollInterval);
        contactLocationsPollInterval = null;
    }
    document.removeEventListener('visibilitychange', handleContactLocationsVisibility);
    window.removeEventListener('focus', handleContactLocationsFocus);
}

function handleContactLocationsVisibility() {
    if (document.visibilityState === 'visible') {
        resubscribeContactLocationsRealtime();
        loadContactLocations();
    }
}

function handleContactLocationsFocus() {
    loadContactLocations();
}

function shareLocationDurationChoice(duration) {
    if (!shareLocationContactId) return;
    const contactId = shareLocationContactId;
    shareLocationContactId = null;
    shareLocationContactName = '';
    closeModal({ refreshContactList: false });
    shareLocationWithContact(contactId, duration);
}

function cancelShareLocationDialog() {
    const contactId = shareLocationContactId;
    shareLocationContactId = null;
    shareLocationContactName = '';
    closeModal({ refreshContactList: false });
    if (contactId) {
        updateShareLocationCheckbox(contactId, false, null);
    }
}

function haversineDistance(lat1, lng1, lat2, lng2) {
    const toRad = v => v * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return EARTH_RADIUS_MI * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDistance(miles, options = {}) {
    const { compact = false } = options;
    if (compact && miles < 0.1) return 'Right here';
    if (miles < 1) {
        if (compact) return miles.toFixed(1) + ' mi away';
        const feet = Math.round(miles * FEET_PER_MILE);
        return feet + ' feet away';
    }
    if (miles < 10) return miles.toFixed(1) + (compact ? ' mi away' : ' miles away');
    return Math.round(miles) + (compact ? ' mi away' : ' miles away');
}

function addContactLocationTileLayer(map) {
    return L.tileLayer(APP_MAP.TILE_URL, {
        maxZoom: APP_MAP.MAX_ZOOM,
        subdomains: APP_MAP.TILE_SUBDOMAINS
    }).addTo(map);
}

function invalidateLeafletMapSize(map, delays) {
    delays.forEach(delay => setTimeout(() => map.invalidateSize(), delay));
}

async function loadContactLocations() {
    if (!currentUser) return;
    const inboundIds = Object.keys(locationSharesInbound);
    if (inboundIds.length === 0) {
        contactLocationsCache = {};
        return;
    }
    try {
        const { data, error } = await db
            .from('user_locations')
            .select('user_id, lat, lng, updated_at')
            .in('user_id', inboundIds);
        if (error) throw error;
        contactLocationsCache = {};
        (data || []).forEach(r => {
            contactLocationsCache[r.user_id] = {
                lat: r.lat,
                lng: r.lng,
                updated_at: r.updated_at || null
            };
        });
        try {
            window.dispatchEvent(new CustomEvent('union:contactLocationsLoaded'));
        } catch (_) { /* best effort */ }
    } catch (e) {
        console.error('loadContactLocations error:', e);
    }
}

function renderContactLocationMap(contactId) {
    const loc = contactLocationsCache[contactId];
    if (!loc) return;
    const mapElId = 'contact-loc-map-' + contactId;
    const el = document.getElementById(mapElId);
    if (!el) return;

    updateContactLocationDistance(contactId);

    // If we've already built a Leaflet map in this element, just move it to
    // the new position instead of rebuilding. This lets realtime updates
    // animate the marker while the card stays open.
    if (el._leafletMap && el._leafletMarker) {
        try {
            el._leafletMap.setView([loc.lat, loc.lng], el._leafletMap.getZoom() || APP_MAP.CONTACT_LOCATION_MINI_ZOOM);
            el._leafletMarker.setLatLng([loc.lat, loc.lng]);
        } catch (_) { /* best effort */ }
        return;
    }

    el.dataset.rendered = '1';

    requestAnimationFrame(() => {
        const target = document.getElementById(mapElId);
        if (!target) return;
        const miniMap = L.map(target, {
            zoomControl: false,
            dragging: false,
            scrollWheelZoom: false,
            doubleClickZoom: false,
            touchZoom: false,
            boxZoom: false,
            keyboard: false,
            attributionControl: false
        }).setView([loc.lat, loc.lng], APP_MAP.CONTACT_LOCATION_MINI_ZOOM);

        addContactLocationTileLayer(miniMap);

        const marker = L.marker([loc.lat, loc.lng]).addTo(miniMap);
        target._leafletMap = miniMap;
        target._leafletMarker = marker;
        invalidateLeafletMapSize(miniMap, [
            APP_TIMING.MAP_INVALIDATE_SHORT_MS,
            APP_TIMING.MAP_INVALIDATE_LONG_MS
        ]);
    });
}

function updateContactLocationDistance(contactId) {
    const loc = contactLocationsCache[contactId];
    if (!loc) return;
    const distEl = document.getElementById('contact-loc-dist-' + contactId);
    if (!distEl) return;
    try {
        getGPSLocation().then(myPos => {
            if (myPos) {
                const miles = haversineDistance(myPos.lat, myPos.lng, loc.lat, loc.lng);
                distEl.textContent = formatDistance(miles);
            }
        }).catch(() => {});
    } catch (_) { /* non-critical */ }
}

// When any inbound sharer's position updates, nudge any rendered mini-map(s)
// to the new spot and refresh the distance label. The contact details pane
// re-renders itself via its own `union:contactLocationsLoaded` listener, and
// the fullscreen map always reads from the cache when opened — so together
// these keep every surface live.
window.addEventListener('union:contactLocationsLoaded', () => {
    Object.keys(contactLocationsCache || {}).forEach(cid => {
        const el = document.getElementById('contact-loc-map-' + cid);
        if (el) renderContactLocationMap(cid);
    });

    const overlay = document.getElementById('contact-location-fullscreen');
    if (!overlay || !overlay.classList.contains('active')) return;
    const cid = overlay._contactId;
    if (!cid) return;
    const loc = contactLocationsCache[cid];
    if (!loc || !overlay._leafletMap || !overlay._leafletMarker) return;
    try {
        overlay._leafletMarker.setLatLng([loc.lat, loc.lng]);
        overlay._leafletMap.panTo([loc.lat, loc.lng]);
    } catch (_) { /* best effort */ }
});

function openContactLocationFullscreen(contactId, contactName) {
    const loc = contactLocationsCache[contactId];
    if (!loc) return;

    let overlay = document.getElementById('contact-location-fullscreen');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'contact-location-fullscreen';
        overlay.className = 'contact-location-fullscreen';
        overlay.innerHTML = `
            <div class="contact-location-fullscreen-frame">
                <div class="contact-location-fullscreen-map" id="contact-location-fullscreen-map"></div>
                <button class="contact-location-fullscreen-close" aria-label="Close"><i data-lucide="x" aria-hidden="true"></i></button>
            </div>`;
        overlay.querySelector('.contact-location-fullscreen-close')
            .addEventListener('click', closeContactLocationFullscreen);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeContactLocationFullscreen();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay.classList.contains('active')) closeContactLocationFullscreen();
        });
        document.body.appendChild(overlay);
        if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
    }

    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';

    const mapEl = document.getElementById('contact-location-fullscreen-map');
    mapEl.innerHTML = '';

    requestAnimationFrame(() => {
        const fullMap = L.map(mapEl, {
            zoomControl: true,
            attributionControl: false
        }).setView([loc.lat, loc.lng], APP_MAP.CONTACT_LOCATION_FULLSCREEN_ZOOM);

        addContactLocationTileLayer(fullMap);

        const fullMarker = L.marker([loc.lat, loc.lng])
            .addTo(fullMap)
            .bindPopup(esc(contactName || 'Contact'))
            .openPopup();

        overlay._leafletMap = fullMap;
        overlay._leafletMarker = fullMarker;
        overlay._contactId = contactId;
        invalidateLeafletMapSize(fullMap, [APP_TIMING.MAP_INVALIDATE_MEDIUM_MS]);
    });
}

function closeContactLocationFullscreen() {
    const overlay = document.getElementById('contact-location-fullscreen');
    if (!overlay) return;
    overlay.classList.remove('active');
    document.body.style.overflow = '';
    if (overlay._leafletMap) {
        overlay._leafletMap.remove();
        overlay._leafletMap = null;
    }
}
