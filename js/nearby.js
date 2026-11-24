const NEARBY_POLL_INTERVAL_MS = APP_TIMING.FOREGROUND_LOCATION_POLL_MS;

// Reverse-geocode cache: only re-hit Nominatim when we've moved more than
// ~500m (≈0.005°) from the last geocoded fix. Polling every minute would
// otherwise hammer the public OSM endpoint even when the user is stationary.
const NEARBY_GEOCODE_MOVE_DEG = 0.005;
let nearbyGeocodeLat = null;
let nearbyGeocodeLng = null;
let nearbyGeocodeLabel = '';

async function nearbyResolveLocationLabel(lat, lng) {
    const moved =
        nearbyGeocodeLat == null ||
        Math.abs(lat - nearbyGeocodeLat) > NEARBY_GEOCODE_MOVE_DEG ||
        Math.abs(lng - nearbyGeocodeLng) > NEARBY_GEOCODE_MOVE_DEG;
    if (!moved && nearbyGeocodeLabel) return nearbyGeocodeLabel;
    if (typeof reverseGeocode !== 'function') return nearbyGeocodeLabel || '';
    try {
        const label = await reverseGeocode(lat, lng);
        nearbyGeocodeLat = lat;
        nearbyGeocodeLng = lng;
        nearbyGeocodeLabel = label || '';
        return nearbyGeocodeLabel;
    } catch {
        return nearbyGeocodeLabel || '';
    }
}

function hasAnyNearbyContacts() {
    return contactsLoadedRows.some(r => r.contact && r.contact.notify_nearby);
}

function startNearbyTracking() {
    if (nearbyTrackingInterval) return;
    if (!IS_NATIVE && !('geolocation' in navigator)) return;
    nearbyTrackingActive = true;
    sendLocationUpdate();
    nearbyTrackingInterval = setInterval(sendLocationUpdate, NEARBY_POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', handleNearbyVisibility);
}

function stopNearbyTracking() {
    nearbyTrackingActive = false;
    if (nearbyTrackingInterval) {
        clearInterval(nearbyTrackingInterval);
        nearbyTrackingInterval = null;
    }
    document.removeEventListener('visibilitychange', handleNearbyVisibility);
}

function handleNearbyVisibility() {
    if (document.visibilityState === 'visible') {
        if (nearbyTrackingActive && !nearbyTrackingInterval) {
            sendLocationUpdate();
            nearbyTrackingInterval = setInterval(sendLocationUpdate, NEARBY_POLL_INTERVAL_MS);
        }
    } else {
        if (nearbyTrackingInterval) {
            clearInterval(nearbyTrackingInterval);
            nearbyTrackingInterval = null;
        }
    }
}

async function sendLocationUpdate() {
    if (!currentUser || document.visibilityState !== 'visible') return;
    try {
        const pos = await getGPSLocation();
        if (!pos) return;
        const label = await nearbyResolveLocationLabel(pos.lat, pos.lng);
        const sourceMetadata = typeof getLocationSharingSourceMetadata === 'function'
            ? getLocationSharingSourceMetadata()
            : {};
        await db.rpc('update_location_and_check_nearby', {
            p_lat: pos.lat,
            p_lng: pos.lng,
            p_location_label: label || null,
            p_source_instance_id: sourceMetadata.source_instance_id || null,
            p_source_platform: sourceMetadata.source_platform || null,
            p_source_user_agent: sourceMetadata.source_user_agent || null
        });
    } catch (e) {
        console.warn('Nearby location update failed:', e);
    }
}

// The foreground poller only runs while the app is visible. On iOS/Android
// the native BackgroundLocation plugin keeps uploading in the background, and
// the server checks for nearby contacts on every upload (trigger on
// user_locations), so alerts arrive without anyone opening the app.
function checkAndStartNearbyTracking() {
    if (hasAnyNearbyContacts()) {
        startNearbyTracking();
        if (typeof wantsNativeBackgroundLocation === 'function' && wantsNativeBackgroundLocation()) {
            startNativeLocationSharing();
        }
    } else {
        stopNearbyTracking();
        // Stops the native uploader unless a location share still needs it.
        if (typeof syncNativeBackgroundLocation === 'function') {
            syncNativeBackgroundLocation();
        }
    }
}
