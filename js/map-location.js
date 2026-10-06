const LOCATION_PATTERN = /^📍location:([-\d.]+),([-\d.]+),([\d.]+)$/;
const DEFAULT_RADIUS = 100;
const MIN_RADIUS = 10;
const MAX_RADIUS = 50000;

function parseLocationBody(body) {
    const m = body && body.trim().match(LOCATION_PATTERN);
    if (!m) return null;
    const lat = parseFloat(m[1]);
    const lng = parseFloat(m[2]);
    const radius = parseFloat(m[3]);
    if (isNaN(lat) || isNaN(lng) || isNaN(radius)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng, radius };
}

function formatRadius(meters) {
    if (meters >= 1000) return (meters / 1000).toFixed(1).replace(/\.0$/, '') + ' km';
    return Math.round(meters) + ' m';
}

/** Open coordinates in the platform default maps app (or browser fallback). */
function openLocationInExternalMaps(lat, lng) {
    const ua = navigator.userAgent || '';
    const isAndroid = /Android/i.test(ua);
    const isApple = /(iPhone|iPad|iPod)/i.test(ua)
        || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    if (isApple) {
        const url = `https://maps.apple.com/?ll=${encodeURIComponent(lat)},${encodeURIComponent(lng)}&q=${encodeURIComponent('Location')}`;
        window.open(url, '_blank', 'noopener,noreferrer');
        return;
    }
    if (isAndroid) {
        window.location.href = `geo:${lat},${lng}?q=${lat},${lng}`;
        return;
    }
    window.open(
        `https://www.openstreetmap.org/?mlat=${encodeURIComponent(lat)}&mlon=${encodeURIComponent(lng)}&zoom=15`,
        '_blank',
        'noopener,noreferrer'
    );
}

function attachLocationPreviewOpenHandler(container, lat, lng) {
    container.classList.add('chat-location-clickable');
    container.setAttribute('role', 'button');
    container.setAttribute('tabindex', '0');
    container.setAttribute('aria-label', 'Open location in Maps');

    function openIt(e) {
        e.preventDefault();
        e.stopPropagation();
        openLocationInExternalMaps(lat, lng);
    }

    container.addEventListener('click', openIt);
    container.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openLocationInExternalMaps(lat, lng);
        }
    });
}

function openMapPicker() {
    if (!selectedGroup || !currentUser) return;

    const overlay = document.createElement('div');
    overlay.className = 'map-picker-overlay';
    overlay.innerHTML = `
        <div class="map-picker-modal">
            <div class="map-picker-header">
                <h3>Share Location</h3>
                <span class="map-picker-radius" id="mapPickerRadius">Radius: ${formatRadius(DEFAULT_RADIUS)}</span>
            </div>
            <div id="mapPickerMap" class="map-picker-map"></div>
            <div class="map-picker-actions">
                <button class="btn btn-secondary" id="mapPickerCancel">Cancel</button>
                <button class="btn btn-primary" id="mapPickerSend">Send Location</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const mapEl = document.getElementById('mapPickerMap');
    const radiusLabel = document.getElementById('mapPickerRadius');

    const map = L.map(mapEl, {
        zoomControl: true,
        attributionControl: false
    }).setView([0, 0], 2);

    L.tileLayer(APP_MAP.TILE_URL, {
        maxZoom: 20,
        subdomains: 'abcd'
    }).addTo(map);

    let currentLat = null;
    let currentLng = null;
    let currentRadius = DEFAULT_RADIUS;
    let marker = null;
    let circle = null;
    const sendBtn = document.getElementById('mapPickerSend');

    function setSendEnabled(enabled) {
        if (!sendBtn) return;
        sendBtn.disabled = !enabled;
    }

    function initMapAt(lat, lng) {
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
        currentLat = lat;
        currentLng = lng;
        map.setView([lat, lng], 15);

        circle = L.circle([lat, lng], {
            radius: currentRadius,
            color: '#3a7ca5',
            fillColor: '#3a7ca5',
            fillOpacity: 0.15,
            weight: 2
        }).addTo(map);

        marker = L.marker([lat, lng], { draggable: true }).addTo(map);

        marker.on('drag', function () {
            const pos = marker.getLatLng();
            currentLat = pos.lat;
            currentLng = pos.lng;
            circle.setLatLng(pos);
        });

        marker.on('dragend', function () {
            const pos = marker.getLatLng();
            currentLat = pos.lat;
            currentLng = pos.lng;
        });

        map.on('click', function (e) {
            if (!marker || !circle || currentLat == null || currentLng == null) return;
            const center = L.latLng(currentLat, currentLng);
            const dist = center.distanceTo(e.latlng);
            const clamped = Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, dist));
            currentRadius = clamped;
            circle.setRadius(clamped);
            radiusLabel.textContent = 'Radius: ' + formatRadius(clamped);
        });

        setSendEnabled(true);
    }

    function initMapWithGPS() {
        getGPSLocation().then(function (pos) {
            if (pos) {
                initMapAt(pos.lat, pos.lng);
            } else {
                showToast('Could not get GPS location yet. Try again when location permission is enabled.', 'error');
            }
        });
    }

    setSendEnabled(false);
    if (IS_NATIVE || 'geolocation' in navigator) {
        initMapWithGPS();
    } else {
        showToast('Geolocation not available', 'error');
    }

    document.getElementById('mapPickerCancel').addEventListener('click', function () {
        overlay.remove();
    });

    overlay.addEventListener('click', function (e) {
        if (e.target === overlay) overlay.remove();
    });

    document.getElementById('mapPickerSend').addEventListener('click', function () {
        if (!Number.isFinite(currentLat) || !Number.isFinite(currentLng)) {
            showToast('Waiting for your location fix. Please try again in a moment.', 'error');
            return;
        }
        sendLocationMessage(currentLat, currentLng, currentRadius);
        overlay.remove();
    });

    setTimeout(function () { map.invalidateSize(); }, APP_TIMING.MAP_INVALIDATE_SHORT_MS);
}

async function sendLocationMessage(lat, lng, radius) {
    if (!selectedGroup || !currentUser) return;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        showToast('Location unavailable. Please retry after location permission is granted.', 'error');
        return;
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        showToast('Invalid location. Please pick a valid point on the map.', 'error');
        return;
    }
    const body = `📍location:${lat.toFixed(6)},${lng.toFixed(6)},${Math.round(radius)}`;

    const { data: msg, error } = await db.from('chat_messages').insert({
        group_id: selectedGroup.id,
        user_id: currentUser.id,
        body: body
    }).select().single();

    if (error) {
        showToast('Failed to send location: ' + error.message, 'error');
    } else if (msg) {
        appendChatMessage(msg);
    }
}

let _locationMapCounter = 0;

function renderLocationPreview(container, lat, lng, radius) {
    _locationMapCounter++;
    const mapId = 'locPreview_' + _locationMapCounter;

    container.innerHTML = `
        <div class="chat-location-preview" id="${mapId}"></div>
        <div class="chat-location-label"><i data-lucide="map-pin" class="chat-location-label-icon" aria-hidden="true"></i> Location (${formatRadius(radius)} radius) · Tap to open in Maps</div>
    `;

    attachLocationPreviewOpenHandler(container, lat, lng);

    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();

    requestAnimationFrame(function () {
        const el = document.getElementById(mapId);
        if (!el) return;

        const previewMap = L.map(el, {
            zoomControl: false,
            dragging: false,
            scrollWheelZoom: false,
            doubleClickZoom: false,
            touchZoom: false,
            boxZoom: false,
            keyboard: false,
            attributionControl: false
        }).setView([lat, lng], APP_MAP.LOCATION_PREVIEW_ZOOM);

        L.tileLayer(APP_MAP.TILE_URL, {
            maxZoom: APP_MAP.MAX_ZOOM,
            subdomains: APP_MAP.TILE_SUBDOMAINS
        }).addTo(previewMap);

        L.circle([lat, lng], {
            radius: radius,
            color: '#3a7ca5',
            fillColor: '#3a7ca5',
            fillOpacity: 0.15,
            weight: 2
        }).addTo(previewMap);

        L.marker([lat, lng]).addTo(previewMap);

        // Fit the circle in view
        const circleBounds = L.latLng(lat, lng).toBounds(radius * 2.5);
        previewMap.fitBounds(circleBounds);

        setTimeout(function () { previewMap.invalidateSize(); }, APP_TIMING.MAP_INVALIDATE_MEDIUM_MS);
    });
}
