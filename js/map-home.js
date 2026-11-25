// Map: the home screen. A full-screen Leaflet map of you, everyone sharing
// their location with you, and the offerings you can see (js/offerings.js).
//
// People come from the existing location-sharing data (locationSharesInbound +
// contactLocationsCache, kept fresh by js/location-sharing.js), so the map
// shows nobody who isn't already sharing with you.
//
// Your own position is shown only when location permission is already
// granted; otherwise the locate button asks. Opening the app never pops a
// location prompt by itself.
//
// People (circles) and offerings (rounded squares) that would overlap on
// screen share one bubble with a count; see groupMapHomeItems().

const MAP_HOME_VIEW_KEY_PREFIX = 'union_map_view_';
const MAP_HOME_ME_KEY_PREFIX = 'union_map_me_';  // your last known position
// A position newer than this shows as live (green dot); older shows its age.
const MAP_HOME_LIVE_MS = 15 * APP_TIMING.MINUTE_MS;
// The Map opens centered on you at this zoom: about a mile across on a phone.
const MAP_HOME_START_ZOOM = 15;
// When the fresh fix arrives, recenter only if the map started this far off.
const MAP_HOME_RECENTER_M = 300;
const MAP_HOME_LOCATE_ZOOM = 15;
const MAP_HOME_SHOW_ZOOM = 16;  // showing one offering, e.g. after posting it
const MAP_HOME_WORLD_VIEW = Object.freeze({ lat: 20, lng: 0, zoom: 2 });
const MAP_HOME_HINT_MS = 4000;
const MAP_HOME_AVATAR_COLORS = ['#e0a458', '#5b8def', '#8e6cc9', '#3aa17e', '#d1684e', '#4a90a4', '#c4567a', '#7a8b3c'];
// Things closer than this on screen share one bubble (bubbles are 42-44px).
// Up-and-down distance counts for less, so a bubble can't land on the date
// tag under the one above it.
const MAP_HOME_GROUP_PX = 46;
const MAP_HOME_GROUP_Y_WEIGHT = 0.75;
const MAP_HOME_GROUP_ZOOM_PADDING = 72;

let mapHome = null;             // Leaflet map, created on first open
let mapHomeMeMarker = null;
let mapHomeMyPos = null;        // { lat, lng } once known
// One marker per bubble, keyed by the item whose face it shows
// ('p:<user_id>' or 'o:<offering_id>'). marker.mapHomeGroup holds everything
// in that bubble.
let mapHomeMarkers = {};
let mapHomeProfiles = {};       // user_id -> { display_name, profile_image_url }
let mapHomeProfilesLoading = null;
let mapHomeUserMoved = false;   // once the user pans or zooms, leave the view alone
// Where the opening view came from: 'me' (this session's fix), 'last-me' (your
// last known position), 'view' (the last view, no position ever known) or
// 'world'. The view is set once at the start and at most once more when your
// position arrives, so the map doesn't zoom around as things load.
let mapHomeStart = null;
let mapHomeFittedItems = false;
let mapHomeCardUserId = null;     // person card open for this user
let mapHomeCardOfferingId = null; // or this offering's card
let mapHomeCardGroupKeys = null;  // or the "here" list, for these items
let mapHomeHintTimer = null;

// ---- Open / close -------------------------------------------------------------

function openMapHome() {
    sizeMapHomeScreen();
    if (typeof initOfferingFilter === 'function') initOfferingFilter();
    whenLeafletReady(() => {
        if (activeMainView !== 'map') return;
        if (!mapHome) createMapHome();
        sizeMapHomeScreen();
        mapHome.invalidateSize();
        renderMapHome();
        if (mapHomeMyPos) setMapHomeMyPosition(mapHomeMyPos);
    });
    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
    ensureMapHomeProfiles().then(renderMapHome);
    if (currentUser && typeof loadContactLocations === 'function') {
        loadContactLocations().catch(() => {});
    }
    if (typeof loadOfferings === 'function') loadOfferings();
    locateMapHomeSilently();
}

function onMapHomeHidden() {
    closeMapHomeCard();
}

// The map screen is fixed between the header and the bottom bar. The header's
// height changes with screen size and safe areas, so measure it.
function sizeMapHomeScreen() {
    const screen = document.getElementById('mapScreen');
    const header = document.querySelector('.header');
    if (!screen || !header) return;
    screen.style.top = Math.round(header.getBoundingClientRect().bottom) + 'px';
}

function whenLeafletReady(fn) {
    if (typeof L !== 'undefined') { fn(); return; }
    let tries = 0;
    const timer = setInterval(() => {
        if (typeof L !== 'undefined') { clearInterval(timer); fn(); }
        else if (++tries > 100) clearInterval(timer);
    }, 100);
}

function createMapHome() {
    const el = document.getElementById('mapHomeMap');
    if (!el) return;
    const fresh = mapHomeMyPos
        || (typeof nativeLocationLastPosition !== 'undefined' && nativeLocationLastPosition) || null;
    const me = fresh || readMapHomeLastPosition();
    let start;
    if (me) {
        start = { lat: me.lat, lng: me.lng, zoom: MAP_HOME_START_ZOOM };
        mapHomeStart = fresh ? 'me' : 'last-me';
    } else {
        start = readMapHomeSavedView();
        mapHomeStart = start ? 'view' : 'world';
        start = start || MAP_HOME_WORLD_VIEW;
    }
    mapHome = L.map(el, {
        zoomControl: false,
        attributionControl: false,
        worldCopyJump: true
    }).setView([start.lat, start.lng], start.zoom);
    addContactLocationTileLayer(mapHome);

    // Once the user moves the map themselves, stop re-fitting it for them.
    mapHome.on('dragstart', () => { mapHomeUserMoved = true; });
    el.addEventListener('wheel', () => { mapHomeUserMoved = true; }, { passive: true });
    el.addEventListener('touchstart', (e) => {
        if (e.touches && e.touches.length > 1) mapHomeUserMoved = true;
    }, { passive: true });
    mapHome.on('dblclick', () => { mapHomeUserMoved = true; });
    mapHome.on('moveend', saveMapHomeView);
    // Who overlaps whom depends on the zoom, so regroup after each one.
    mapHome.on('zoomend', renderMapHome);
    mapHome.on('click', closeMapHomeCard);
}

function readMapHomeSavedView() {
    if (!currentUser) return null;
    try {
        const v = JSON.parse(localStorage.getItem(MAP_HOME_VIEW_KEY_PREFIX + currentUser.id) || 'null');
        if (v && Number.isFinite(v.lat) && Number.isFinite(v.lng) && Number.isFinite(v.zoom)) return v;
    } catch (_) { /* storage unavailable */ }
    return null;
}

function readMapHomeLastPosition() {
    if (!currentUser) return null;
    try {
        const v = JSON.parse(localStorage.getItem(MAP_HOME_ME_KEY_PREFIX + currentUser.id) || 'null');
        if (v && Number.isFinite(v.lat) && Number.isFinite(v.lng)) return v;
    } catch (_) { /* storage unavailable */ }
    return null;
}

function saveMapHomeLastPosition(pos) {
    if (!currentUser) return;
    try {
        localStorage.setItem(MAP_HOME_ME_KEY_PREFIX + currentUser.id, JSON.stringify({ lat: pos.lat, lng: pos.lng }));
    } catch (_) { /* storage full or unavailable */ }
}

function saveMapHomeView() {
    if (!mapHome || !currentUser) return;
    try {
        const c = mapHome.getCenter();
        localStorage.setItem(MAP_HOME_VIEW_KEY_PREFIX + currentUser.id,
            JSON.stringify({ lat: c.lat, lng: c.lng, zoom: mapHome.getZoom() }));
    } catch (_) { /* storage full or unavailable */ }
}

// ---- People -------------------------------------------------------------------

/** Everyone sharing their location with you who has a position, nearest/freshest first. */
function getMapHomeSharers() {
    const inbound = (typeof locationSharesInbound === 'object' && locationSharesInbound) || {};
    const cache = (typeof contactLocationsCache === 'object' && contactLocationsCache) || {};
    const list = [];
    Object.keys(inbound).forEach(uid => {
        const loc = cache[uid];
        if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) return;
        if (typeof isUserBlocked === 'function' && isUserBlocked(uid)) return;
        list.push({ uid, loc, live: isMapHomeLocationLive(loc), miles: getMapHomeDistanceMi(loc) });
    });
    list.sort((a, b) => {
        if (a.live !== b.live) return a.live ? -1 : 1;
        if (a.miles != null && b.miles != null) return a.miles - b.miles;
        return String(b.loc.updated_at || '').localeCompare(String(a.loc.updated_at || ''));
    });
    return list;
}

function isMapHomeLocationLive(loc) {
    if (!loc || !loc.updated_at) return false;
    return (Date.now() - new Date(loc.updated_at).getTime()) < MAP_HOME_LIVE_MS;
}

function getMapHomeDistanceMi(loc) {
    if (!mapHomeMyPos || !loc || typeof haversineDistance !== 'function') return null;
    return haversineDistance(mapHomeMyPos.lat, mapHomeMyPos.lng, loc.lat, loc.lng);
}

/** Load names and photos for sharers we don't know yet. */
function ensureMapHomeProfiles() {
    const ids = Object.keys((typeof locationSharesInbound === 'object' && locationSharesInbound) || {});
    (typeof contactsLoadedRows !== 'undefined' ? contactsLoadedRows : []).forEach(r => {
        const id = r?.contact?.contact_id;
        if (id && r.profile && r.profile.display_name) {
            mapHomeProfiles[id] = { display_name: r.profile.display_name, profile_image_url: r.profile.profile_image_url || null };
        }
    });
    const missing = ids.filter(id => !mapHomeProfiles[id]);
    if (!missing.length || !currentUser) return Promise.resolve();
    if (mapHomeProfilesLoading) return mapHomeProfilesLoading;
    mapHomeProfilesLoading = db.from('profiles')
        .select('id, display_name, profile_image_url')
        .in('id', missing)
        .then(({ data, error }) => {
            if (error) throw error;
            (data || []).forEach(p => {
                mapHomeProfiles[p.id] = { display_name: p.display_name || '', profile_image_url: p.profile_image_url || null };
            });
        })
        .catch(e => console.warn('[map-home] profile load failed:', e))
        .finally(() => { mapHomeProfilesLoading = null; });
    return mapHomeProfilesLoading;
}

function getMapHomeName(uid) {
    return (mapHomeProfiles[uid] && mapHomeProfiles[uid].display_name) || 'Contact';
}

function getMapHomeInitial(uid) {
    const name = getMapHomeName(uid).trim();
    return name ? name[0].toUpperCase() : '?';
}

function getMapHomeColor(uid) {
    let h = 0;
    for (let i = 0; i < uid.length; i++) h = (h * 31 + uid.charCodeAt(i)) >>> 0;
    return MAP_HOME_AVATAR_COLORS[h % MAP_HOME_AVATAR_COLORS.length];
}

/** Round avatar: photo if there is one, else an initial on a color from their id. */
function getMapHomeAvatarHtml(uid, className) {
    const url = mapHomeProfiles[uid] && mapHomeProfiles[uid].profile_image_url;
    if (url) return `<img class="${className}" src="${esc(url)}" alt="">`;
    return `<span class="${className} map-home-initial" style="background:${getMapHomeColor(uid)}">${esc(getMapHomeInitial(uid))}</span>`;
}

function getMapHomeAgeLabel(loc) {
    if (!loc || !loc.updated_at || typeof formatLastSeen !== 'function') return '';
    return formatLastSeen(loc.updated_at).replace(/ ago$/, '');
}

// ---- Items: people and offerings ---------------------------------------------

/**
 * Everything to draw, in the order that picks each bubble's face: live
 * people, then offerings (newest first), then people whose location is old.
 * Choosing a kind in the filter shows only offerings of that kind.
 */
function getMapHomeItems() {
    const people = typeof isOfferingFilterOn === 'function' && isOfferingFilterOn() ? [] : getMapHomeSharers();
    const offerings = typeof getShownOfferings === 'function' ? getShownOfferings() : [];
    const person = s => ({ key: 'p:' + s.uid, type: 'person', lat: s.loc.lat, lng: s.loc.lng, sharer: s });
    const offering = o => ({ key: 'o:' + o.id, type: 'offering', lat: o.lat, lng: o.lng, offering: o });
    return [
        ...people.filter(s => s.live).map(person),
        ...offerings.map(offering),
        ...people.filter(s => !s.live).map(person)
    ];
}

/**
 * Split items into bubbles that don't overlap at this zoom. The first item in
 * each group (by the order above) is its lead: the bubble sits where it is
 * and shows its face. Every other bubble is at least MAP_HOME_GROUP_PX from
 * it, so bubbles never cover each other.
 */
function groupMapHomeItems(items, zoom) {
    const points = items.map(it => mapHome.project([it.lat, it.lng], zoom));
    const taken = new Array(items.length).fill(false);
    const groups = [];
    items.forEach((lead, i) => {
        if (taken[i]) return;
        taken[i] = true;
        const members = [lead];
        for (let j = i + 1; j < items.length; j++) {
            if (taken[j]) continue;
            const dx = points[j].x - points[i].x;
            const dy = (points[j].y - points[i].y) * MAP_HOME_GROUP_Y_WEIGHT;
            if (Math.hypot(dx, dy) < MAP_HOME_GROUP_PX) {
                taken[j] = true;
                members.push(items[j]);
            }
        }
        groups.push({ lead, members });
    });
    return groups;
}

function getMapHomeSelectedKey() {
    if (mapHomeCardUserId) return 'p:' + mapHomeCardUserId;
    if (mapHomeCardOfferingId) return 'o:' + mapHomeCardOfferingId;
    return null;
}

function isMapHomeGroupSelected(group) {
    const key = getMapHomeSelectedKey();
    return group.members.some(it => it.key === key ||
        (mapHomeCardGroupKeys && mapHomeCardGroupKeys.includes(it.key)));
}

function getMapHomeItemName(item) {
    return item.type === 'person' ? getMapHomeName(item.sharer.uid) : getOfferingTitle(item.offering);
}

function getMapHomeMarkerTitle(group) {
    const name = getMapHomeItemName(group.lead);
    const others = group.members.length - 1;
    if (!others) return name;
    return `${name} and ${others} ${others === 1 ? 'other' : 'others'}`;
}

function getMapHomeMarkerIcon(group) {
    const isGroup = group.members.length > 1;
    // While something's card is open, it is the face of its bubble.
    const selectedKey = getMapHomeSelectedKey();
    const face = group.members.find(it => it.key === selectedKey) || group.lead;
    const selected = isMapHomeGroupSelected(group) ? ' selected' : '';
    const count = isGroup
        ? `<span class="map-home-count">${group.members.length > 99 ? '99+' : group.members.length}</span>`
        : '';

    if (face.type === 'offering') {
        const o = face.offering;
        const k = offeringKindKey(o.kind);
        const img = o.photo_url
            ? `<img class="map-home-offer-img" src="${escOfferAttr(o.photo_url)}" alt="">`
            : `<span class="map-home-offer-img offer-noimg kind-${k}">${offeringIconSvg(OFFERING_KINDS[k].icon)}</span>`;
        const badge = o.photo_url ? `<span class="map-home-offer-badge kind-${k}">${offeringIconSvg(OFFERING_KINDS[k].icon)}</span>` : '';
        return L.divIcon({
            className: 'map-home-pin',
            html: `<span class="map-home-offer${o.is_mine ? ' mine' : ''}${isGroup ? ' group' : ''}${selected}">${img}${badge}${count}</span>`,
            iconSize: [44, 44],
            iconAnchor: [22, 22]
        });
    }

    const s = face.sharer;
    // A bubble for several things has no single age to show.
    const age = (!isGroup && !s.live)
        ? `<span class="map-home-age">${esc(getMapHomeAgeLabel(s.loc))}</span>`
        : '';
    const classes = `map-home-person ${s.live ? 'live' : 'stale'}${isGroup ? ' group' : ''}${selected}`;
    return L.divIcon({
        className: 'map-home-pin',
        html: `<span class="${classes}">${getMapHomeAvatarHtml(s.uid, 'map-home-person-img')}${count}${age}</span>`,
        iconSize: [42, 42],
        iconAnchor: [21, 21]
    });
}

function renderMapHome() {
    if (!mapHome) return;
    const items = getMapHomeItems();

    // Drop cards for things no longer on the map (stopped sharing, taken,
    // filtered out) before drawing, so no bubble stays highlighted for them.
    const present = new Set(items.map(it => it.key));
    if (mapHomeCardUserId && !present.has('p:' + mapHomeCardUserId)) hideMapHomeCard();
    if (mapHomeCardOfferingId && !present.has('o:' + mapHomeCardOfferingId)) hideMapHomeCard();
    if (mapHomeCardGroupKeys) {
        mapHomeCardGroupKeys = mapHomeCardGroupKeys.filter(key => present.has(key));
        if (!mapHomeCardGroupKeys.length) hideMapHomeCard();
    }

    const seen = new Set();
    groupMapHomeItems(items, mapHome.getZoom()).forEach(group => {
        const key = group.lead.key;
        const latLng = [group.lead.lat, group.lead.lng];
        const icon = getMapHomeMarkerIcon(group);
        const title = getMapHomeMarkerTitle(group);
        seen.add(key);
        let marker = mapHomeMarkers[key];
        if (marker) {
            marker.setLatLng(latLng);
            marker.options.title = title;   // setIcon re-reads it
            marker.setIcon(icon);
        } else {
            marker = L.marker(latLng, { icon, title, keyboard: true }).addTo(mapHome);
            marker.on('click', (e) => {
                if (e && e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
                onMapHomeMarkerTap(marker.mapHomeGroup);
            });
            mapHomeMarkers[key] = marker;
        }
        marker.mapHomeGroup = group;
        // The selected bubble grows a little; keep it on top of its neighbors.
        marker.setZIndexOffset(isMapHomeGroupSelected(group) ? 1000 : 0);
    });
    Object.keys(mapHomeMarkers).forEach(key => {
        if (seen.has(key)) return;
        mapHome.removeLayer(mapHomeMarkers[key]);
        delete mapHomeMarkers[key];
    });
    if (mapHomeCardUserId || mapHomeCardOfferingId || mapHomeCardGroupKeys) renderMapHomeCard();
    autoFitMapHome(items);
}

// The map opens on you (see createMapHome). Only when your position has
// never been known, and there's no earlier view either, does it fit to
// what's around, once, so a first launch doesn't show the whole world.
function autoFitMapHome(items) {
    if (!mapHome || mapHomeUserMoved || mapHomeStart !== 'world' || mapHomeFittedItems) return;
    items = items || getMapHomeItems();
    if (!items.length) return;
    mapHomeFittedItems = true;
    mapHome.fitBounds(L.latLngBounds(items.map(it => [it.lat, it.lng])),
        { padding: [56, 56], maxZoom: MAP_HOME_START_ZOOM, animate: false });
}

/** The bubble that currently holds this item, alone or in a group. */
function findMapHomeMarker(itemKey) {
    return Object.values(mapHomeMarkers)
        .find(m => m.mapHomeGroup && m.mapHomeGroup.members.some(it => it.key === itemKey)) || null;
}

// One thing: its card. Several: zoom in until they separate, or list them if
// they're too close together to separate (about the same building).
function onMapHomeMarkerTap(group) {
    if (!mapHome || !group) return;
    if (group.members.length === 1) {
        openMapHomeItemCard(group.lead);
        return;
    }
    // Stop at the last zoom with real map tiles. Past it the streets are only
    // enlarged and blurry, so things still sharing a bubble there are listed.
    const maxZoom = Math.min(mapHome.getMaxZoom(), APP_MAP.MAX_NATIVE_ZOOM);
    if (mapHome.getZoom() >= maxZoom || groupMapHomeItems(group.members, maxZoom).length === 1) {
        openMapHomeGroupCard(group);
        return;
    }
    mapHomeUserMoved = true;
    closeMapHomeCard();
    const bounds = L.latLngBounds(group.members.map(it => [it.lat, it.lng]));
    mapHome.fitBounds(bounds, { padding: [MAP_HOME_GROUP_ZOOM_PADDING, MAP_HOME_GROUP_ZOOM_PADDING], maxZoom });
}

function openMapHomeItemCard(item) {
    if (item.type === 'person') openMapHomeCard(item.sharer.uid);
    else openMapHomeOfferingCard(item.offering.id);
}

/** Show one offering on the Map with its card open (after posting, or from the Feed). */
function mapHomeShowOffering(id) {
    const o = typeof getOffering === 'function' ? getOffering(id) : null;
    if (!o) return;
    if (!offeringMatchesFilter(o)) setOfferingKindFilter('');
    if (activeMainView !== 'map') navigateTo('map');
    whenLeafletReady(() => {
        if (!mapHome || activeMainView !== 'map') return;
        mapHomeUserMoved = true;
        mapHome.setView([o.lat, o.lng], Math.max(mapHome.getZoom(), MAP_HOME_SHOW_ZOOM), { animate: false });
        openMapHomeOfferingCard(id);
    });
}

// ---- You ----------------------------------------------------------------------

function setMapHomeMyPosition(pos) {
    if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) return;
    mapHomeMyPos = { lat: pos.lat, lng: pos.lng };
    saveMapHomeLastPosition(mapHomeMyPos);
    if (!mapHome) return;
    // This session's first fix: center on it once, unless the map already
    // opened close by or you've moved it yourself.
    if (mapHomeStart !== 'me' && !mapHomeUserMoved) {
        const c = mapHome.getCenter();
        const offM = mapHomeStart === 'last-me' && typeof haversineDistance === 'function'
            ? haversineDistance(c.lat, c.lng, pos.lat, pos.lng) * 1609.34 : Infinity;
        if (offM > MAP_HOME_RECENTER_M) {
            const zoom = mapHomeStart === 'last-me' ? mapHome.getZoom() : MAP_HOME_START_ZOOM;
            mapHome.setView([pos.lat, pos.lng], zoom, { animate: false });
        }
    }
    mapHomeStart = 'me';
    if (mapHomeMeMarker) {
        mapHomeMeMarker.setLatLng([pos.lat, pos.lng]);
    } else {
        mapHomeMeMarker = L.marker([pos.lat, pos.lng], {
            icon: L.divIcon({ className: 'map-home-pin', html: '<span class="map-home-me"></span>', iconSize: [18, 18], iconAnchor: [9, 9] }),
            interactive: false,
            keyboard: false,
            zIndexOffset: -500
        }).addTo(mapHome);
    }
}

/** True when we can read the location without the OS or browser asking. */
async function canLocateMapHomeSilently() {
    try {
        if (IS_NATIVE) {
            if (typeof hasNativeBackgroundLocation !== 'function' || !hasNativeBackgroundLocation()) return false;
            const plugin = window.Capacitor?.Plugins?.BackgroundLocation;
            if (!plugin || typeof plugin.getStatus !== 'function') return false;
            const status = await plugin.getStatus();
            return /^authorized/.test(status?.authorizationStatus || '');
        }
        if (typeof BROWSER_GEOLOCATION_SUPPRESSED !== 'undefined' && BROWSER_GEOLOCATION_SUPPRESSED) return false;
        if (!navigator.permissions || !navigator.permissions.query) return false;
        const result = await navigator.permissions.query({ name: 'geolocation' });
        return result.state === 'granted';
    } catch (_) {
        return false;
    }
}

async function locateMapHomeSilently() {
    if (typeof nativeLocationLastPosition !== 'undefined' && nativeLocationLastPosition) {
        applyMapHomeMyPosition(nativeLocationLastPosition);
    }
    if (!(await canLocateMapHomeSilently())) return;
    const pos = await getGPSLocation({ maxAgeMs: APP_TIMING.RELAXED_GPS_MAX_AGE_MS }).catch(() => null);
    if (pos) applyMapHomeMyPosition(pos);
}

function applyMapHomeMyPosition(pos) {
    setMapHomeMyPosition(pos);
    if (mapHome) {
        renderMapHome();
    }
    if (activeMainView === 'feed' && typeof renderFeed === 'function') renderFeed();
}

/** Locate button: an explicit tap, so it may ask for permission. */
async function mapHomeLocateMe() {
    const btn = document.getElementById('mapHomeLocateBtn');
    if (btn) btn.classList.add('locating');
    let pos = null;
    try {
        pos = await getGPSLocation({ maxAgeMs: APP_TIMING.NATIVE_GPS_CACHE_MAX_AGE_MS });
    } catch (_) { pos = null; }
    if (btn) btn.classList.remove('locating');
    if (!pos) {
        showMapHomeHint('Turn on location for Union to see where you are.');
        return;
    }
    setMapHomeMyPosition(pos);
    if (mapHome) {
        mapHomeUserMoved = true;
        mapHome.setView([pos.lat, pos.lng], Math.max(mapHome.getZoom(), MAP_HOME_LOCATE_ZOOM));
        renderMapHome();
    }
}

function showMapHomeHint(text) {
    const el = document.getElementById('mapHomeHint');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(mapHomeHintTimer);
    mapHomeHintTimer = setTimeout(() => el.classList.add('hidden'), MAP_HOME_HINT_MS);
}

// ---- Cards: a person, an offering, or a "here" list ---------------------------

function openMapHomeCard(uid) {
    mapHomeCardUserId = uid;
    mapHomeCardOfferingId = null;
    mapHomeCardGroupKeys = null;
    // Like opening someone in Find My: a stale position asks their phone for a fresh one.
    if (typeof requestContactLocationRefresh === 'function') requestContactLocationRefresh(uid);
    renderMapHomeCard();
    renderMapHome();
    keepMapHomeMarkerAboveCard('p:' + uid);
}

function openMapHomeOfferingCard(id) {
    mapHomeCardOfferingId = id;
    mapHomeCardUserId = null;
    mapHomeCardGroupKeys = null;
    renderMapHomeCard();
    renderMapHome();
    keepMapHomeMarkerAboveCard('o:' + id);
}

/** List everything in a bubble that zooming in can't split. */
function openMapHomeGroupCard(group) {
    mapHomeCardUserId = null;
    mapHomeCardOfferingId = null;
    mapHomeCardGroupKeys = group.members.map(it => it.key);
    renderMapHomeCard();
    renderMapHome();
    keepMapHomeMarkerAboveCard(group.lead.key);
}

function mapHomeOpenItemFromList(btn) {
    const key = btn && btn.dataset ? btn.dataset.key || '' : '';
    if (key.startsWith('p:')) openMapHomeCard(key.slice(2));
    else if (key.startsWith('o:')) openMapHomeOfferingCard(key.slice(2));
}

// Pan so the bubble sits fully above the card. The card and the map share
// #mapScreen, so the card's offsetTop is in the map's coordinates.
function keepMapHomeMarkerAboveCard(itemKey) {
    const marker = findMapHomeMarker(itemKey);
    if (!mapHome || !marker) return;
    const card = document.getElementById('mapHomeCard');
    const cardTop = card && !card.classList.contains('hidden') ? card.offsetTop : mapHome.getSize().y - 160;
    const limit = cardTop - 36;  // half a bubble, grown when selected, plus a gap
    const pt = mapHome.latLngToContainerPoint(marker.getLatLng());
    if (pt.y > limit) mapHome.panBy([0, pt.y - limit], { animate: true });
}

/** "Live · 0.5 mi", "Updated 2h ago", plus "Locating…" while a fresh fix is on its way. */
function getMapHomeStatusText(sharer, { withLocating = true } = {}) {
    const loc = sharer ? sharer.loc : null;
    const parts = [];
    if (sharer && sharer.live) parts.push('Live');
    else if (loc && loc.updated_at) parts.push('Updated ' + formatLastSeen(loc.updated_at));
    if (sharer && sharer.miles != null && typeof formatDistance === 'function') parts.push(formatDistance(sharer.miles, { compact: true }));
    if (withLocating && sharer && typeof isContactLocationRefreshPending === 'function' && isContactLocationRefreshPending(sharer.uid)) {
        parts.push('Locating…');
    }
    return parts.join(' · ');
}

// Cards redraw whenever the map does (people move every few seconds), so
// only touch the DOM when the content changed: photos don't flicker and a
// scrolled list stays put.
function setMapHomeCardHtml(card, html, label, kind) {
    if (card.dataset.kind !== kind || card._mapHomeHtml !== html) {
        card.innerHTML = html;
        card._mapHomeHtml = html;
        card.dataset.kind = kind;
        if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
    }
    card.setAttribute('aria-label', label);
    card.classList.remove('hidden');
}

function renderMapHomeCard() {
    const card = document.getElementById('mapHomeCard');
    if (!card) return;
    if (mapHomeCardGroupKeys) {
        renderMapHomeGroupCard(card);
        return;
    }
    if (mapHomeCardOfferingId) {
        const o = typeof getOffering === 'function' ? getOffering(mapHomeCardOfferingId) : null;
        if (!o) { hideMapHomeCard(); return; }
        setMapHomeCardHtml(card, buildOfferingSheetHtml(o), getOfferingTitle(o), 'offering');
        return;
    }
    if (!mapHomeCardUserId) return;
    const uid = mapHomeCardUserId;
    const sharer = getMapHomeSharers().find(s => s.uid === uid);
    const name = getMapHomeName(uid);
    setMapHomeCardHtml(card, `
        <div class="map-home-card-row">
            ${getMapHomeAvatarHtml(uid, 'map-home-card-avatar')}
            <div class="map-home-card-text">
                <div class="map-home-card-name">${esc(name)}</div>
                <div class="map-home-card-sub${sharer && sharer.live ? ' live' : ''}">${esc(getMapHomeStatusText(sharer || { uid }))}</div>
            </div>
            <button type="button" class="map-home-card-close" onclick="closeMapHomeCard()" aria-label="Close"><i data-lucide="x" aria-hidden="true"></i></button>
        </div>
        <div class="map-home-card-actions">
            <button type="button" class="map-home-card-btn primary" onclick="mapHomeOpenMessage()"><i data-lucide="message-circle" aria-hidden="true"></i>Message</button>
            <button type="button" class="map-home-card-btn" onclick="mapHomeOpenDetails()"><i data-lucide="user-round" aria-hidden="true"></i>Details</button>
        </div>`, name, 'person');
}

function getMapHomeHereTitle(people, offerings) {
    const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    if (people && offerings) return `${count(people, 'person', 'people')}, ${count(offerings, 'offering', 'offerings')} here`;
    if (offerings) return `${count(offerings, 'offering', 'offerings')} here`;
    return `${count(people, 'person', 'people')} here`;
}

function renderMapHomeGroupCard(card) {
    const keys = new Set(mapHomeCardGroupKeys);
    const items = getMapHomeItems().filter(it => keys.has(it.key));
    const people = items.filter(it => it.type === 'person').length;
    const title = getMapHomeHereTitle(people, items.length - people);
    const rows = items.map(it => {
        if (it.type === 'person') {
            const s = it.sharer;
            return `
        <button type="button" class="map-home-group-row" data-key="${escOfferAttr(it.key)}" onclick="mapHomeOpenItemFromList(this)">
            ${getMapHomeAvatarHtml(s.uid, 'map-home-group-avatar')}
            <span class="map-home-card-text">
                <span class="map-home-card-name">${esc(getMapHomeName(s.uid))}</span>
                <span class="map-home-card-sub${s.live ? ' live' : ''}">${esc(getMapHomeStatusText(s, { withLocating: false }))}</span>
            </span>
            <i data-lucide="chevron-right" aria-hidden="true"></i>
        </button>`;
        }
        const o = it.offering;
        return `
        <button type="button" class="map-home-group-row" data-key="${escOfferAttr(it.key)}" onclick="mapHomeOpenItemFromList(this)">
            ${offeringThumbHtml(o, 'map-home-group-thumb')}
            <span class="map-home-card-text">
                <span class="map-home-card-name">${esc(getOfferingTitle(o))}</span>
                <span class="map-home-card-sub">${esc(getOfferingKindLabels(o) + ' · ' + getOfferingPriceLine(o))}</span>
            </span>
            <i data-lucide="chevron-right" aria-hidden="true"></i>
        </button>`;
    }).join('');
    setMapHomeCardHtml(card, `
        <div class="map-home-card-row">
            <div class="map-home-card-text"><div class="map-home-card-name">${esc(title)}</div></div>
            <button type="button" class="map-home-card-close" onclick="closeMapHomeCard()" aria-label="Close"><i data-lucide="x" aria-hidden="true"></i></button>
        </div>
        <div class="map-home-group-list">${rows}</div>`, title, 'list');
}

/** Hide whichever card is open without redrawing the bubbles; true if one was open. */
function hideMapHomeCard() {
    const card = document.getElementById('mapHomeCard');
    const wasOpen = !!(mapHomeCardUserId || mapHomeCardOfferingId || mapHomeCardGroupKeys);
    mapHomeCardUserId = null;
    mapHomeCardOfferingId = null;
    mapHomeCardGroupKeys = null;
    if (card) {
        card.classList.add('hidden');
        card.innerHTML = '';
        card._mapHomeHtml = '';
        card.dataset.kind = '';
    }
    return wasOpen;
}

function closeMapHomeCard() {
    if (hideMapHomeCard()) renderMapHome();
}

function mapHomeOpenMessage() {
    const uid = mapHomeCardUserId;
    if (!uid) return;
    navigateTo('directMessage', uid);
}

function mapHomeOpenDetails() {
    const uid = mapHomeCardUserId;
    if (!uid) return;
    navigateTo('contactDetails', uid);
}

// ---- Live updates -------------------------------------------------------------

function onMapHomeLocationsChanged() {
    if (!mapHome && activeMainView !== 'feed') return;
    ensureMapHomeProfiles().then(() => {
        if (mapHome) renderMapHome();
        if (activeMainView === 'feed' && typeof renderFeed === 'function') renderFeed();
    });
    if (mapHome) renderMapHome();
}

window.addEventListener('union:contactLocationsLoaded', onMapHomeLocationsChanged);
window.addEventListener('union:locationShareChanged', onMapHomeLocationsChanged);
window.addEventListener('union:offeringsLoaded', () => { if (mapHome) renderMapHome(); });
window.addEventListener('union:offeringFilterChanged', () => { if (mapHome) renderMapHome(); });
// The header animates its padding when the window changes size (or the phone
// rotates), so measure again once that settles.
let mapHomeResizeTimer = null;
function resizeMapHome() {
    if (activeMainView !== 'map') return;
    sizeMapHomeScreen();
    if (mapHome) mapHome.invalidateSize();
}
window.addEventListener('resize', () => {
    resizeMapHome();
    clearTimeout(mapHomeResizeTimer);
    mapHomeResizeTimer = setTimeout(resizeMapHome, 400);
});
