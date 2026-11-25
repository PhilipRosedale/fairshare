// Offerings: things people lend, sell, do for someone, or gather around.
//
// Three parts:
//   1. Data: the offerings you can see (offerings_near), shared by the Map
//      and the Feed, plus the kind filter both screens use.
//   2. The Offer screen: Union button -> camera -> one screen of details ->
//      Post, with sheets for Where, Visible and the currency. The same screen
//      edits an offering you posted. Up to six photos; the first is the cover.
//   3. Acting on an offering: Message and Directions; for your own, Edit,
//      Mark taken and Delete; for someone else's, Report and Block.
//
// Database side: sql/offerings-schema.sql. Photos go in the avatars bucket
// under your own folder, like chat photos.

const OFFERING_KINDS = Object.freeze({
    lend: {
        label: 'Lend', icon: 'repeat-2', unit: 'day', closeLabel: 'Mark returned',
        titleHint: 'What can people borrow?', detailsHint: 'When and where to pick it up'
    },
    sell: {
        label: 'Sell', icon: 'tag', unit: null, closeLabel: 'Mark sold',
        titleHint: 'What are you selling?', detailsHint: 'Condition, size, how to get it'
    },
    do: {
        label: 'Do', icon: 'hand-helping', unit: 'hour', closeLabel: 'Mark done',
        titleHint: 'What can you do for someone?', detailsHint: 'Fix a bike, an hour of tutoring…'
    },
    gather: {
        label: 'Gather', icon: 'party-popper', unit: null, closeLabel: 'End it',
        titleHint: "What's happening?", detailsHint: 'Who should come, what to bring'
    }
});
const OFFERING_KIND_ORDER = ['lend', 'sell', 'do', 'gather'];
// Lend, Sell and Do are shown within about this distance of the real spot,
// because many things are offered from home.
const OFFERING_APPROX_RADIUS_M = 200;
const OFFERING_RELOAD_MIN_MS = 60 * 1000;
const OFFERING_LABEL_TIMEOUT_MS = 3500;
const OFFERING_DESCRIPTION_MAX = 1000;
const OFFERING_TITLE_MAX = 120;
const OFFERING_DETAILS_MAX = OFFERING_DESCRIPTION_MAX - OFFERING_TITLE_MAX - 1;
const OFFERING_PHOTO_MAX = 6;
const OFFERING_FILTER_KEY_PREFIX = 'union_offer_filter_';
const OFFERING_AUDIENCE_KEY_PREFIX = 'union_offer_audience_';
const OFFERING_CURRENCY_KEY_PREFIX = 'union_offer_currency_';
const OFFERING_STORAGE_PUBLIC_PATH = '/storage/v1/object/public/avatars/';

// ============================================================================
// 1. Data
// ============================================================================

let offeringsCache = [];        // rows from offerings_near, newest first
let offeringsLoadedAt = 0;
let offeringsLoading = null;
let offeringKindFilter = [];    // kinds to show; empty: people and every kind
let offeringFilterUserId = null;

function loadOfferings({ force = false } = {}) {
    if (!currentUser || typeof db === 'undefined' || !db) return Promise.resolve(offeringsCache);
    if (offeringsLoading) return offeringsLoading;
    if (!force && offeringsLoadedAt && Date.now() - offeringsLoadedAt < OFFERING_RELOAD_MIN_MS) {
        return Promise.resolve(offeringsCache);
    }
    offeringsLoading = Promise.resolve(db.rpc('offerings_near', {}))
        .then(({ data, error }) => {
            if (error) throw error;
            offeringsCache = data || [];
            offeringsLoadedAt = Date.now();
            window.dispatchEvent(new CustomEvent('union:offeringsLoaded'));
            return offeringsCache;
        })
        .catch(e => {
            console.warn('[offerings] load failed:', e);
            return offeringsCache;
        })
        .finally(() => { offeringsLoading = null; });
    return offeringsLoading;
}

function getOffering(id) {
    return offeringsCache.find(o => o.id === id) || null;
}

/** Offerings to draw on the Map and in the Feed, after the kind filter. */
function getShownOfferings() {
    return offeringsCache.filter(o =>
        offeringMatchesFilter(o)
        && (o.is_mine || typeof isUserBlocked !== 'function' || !isUserBlocked(o.user_id)));
}

function offeringKindKey(kind) {
    return OFFERING_KINDS[kind] ? kind : 'sell';
}

/** An offering's kinds in the usual order; the first is its main kind (color, icon). */
function getOfferingKinds(o) {
    const list = Array.isArray(o && o.kinds) && o.kinds.length ? o.kinds : [o && o.kind];
    const kinds = OFFERING_KIND_ORDER.filter(k => list.includes(k));
    return kinds.length ? kinds : [offeringKindKey(o && o.kind)];
}

/** "Lend · Sell" */
function getOfferingKindLabels(o) {
    return getOfferingKinds(o).map(k => OFFERING_KINDS[k].label).join(' · ');
}

/** "Mark sold" for one kind; "Mark done" when it's several. */
function getOfferingCloseLabel(o) {
    const kinds = getOfferingKinds(o);
    return kinds.length === 1 ? OFFERING_KINDS[kinds[0]].closeLabel : 'Mark done';
}

function isOfferingFilterOn() {
    return offeringKindFilter.length > 0;
}

/** True when the filter is off, or the offering has any of the chosen kinds. */
function offeringMatchesFilter(o) {
    return !offeringKindFilter.length || getOfferingKinds(o).some(k => offeringKindFilter.includes(k));
}

// ---- Kind filter (chips on the Map and the Feed) ---------------------------

/** Read the saved filter once per signed-in user. */
function initOfferingFilter() {
    if (!currentUser || offeringFilterUserId === currentUser.id) return;
    offeringFilterUserId = currentUser.id;
    let saved = [];
    try {
        const raw = localStorage.getItem(OFFERING_FILTER_KEY_PREFIX + currentUser.id);
        // Older builds saved a single kind as a plain string.
        saved = raw && raw.startsWith('[') ? JSON.parse(raw) : (raw ? [raw] : []);
    } catch (_) { saved = []; }
    offeringKindFilter = OFFERING_KIND_ORDER.filter(k => Array.isArray(saved) && saved.includes(k));
    renderOfferingFilterChips();
}

/** Tap a kind chip to add or remove that kind; '' (All) clears them. */
function setOfferingKindFilter(kind) {
    if (!OFFERING_KINDS[kind]) offeringKindFilter = [];
    else if (offeringKindFilter.includes(kind)) offeringKindFilter = offeringKindFilter.filter(k => k !== kind);
    else offeringKindFilter = OFFERING_KIND_ORDER.filter(k => k === kind || offeringKindFilter.includes(k));
    // Every kind chosen is the same as All, which also shows people.
    if (offeringKindFilter.length === OFFERING_KIND_ORDER.length) offeringKindFilter = [];
    if (currentUser) {
        try {
            if (offeringKindFilter.length) localStorage.setItem(OFFERING_FILTER_KEY_PREFIX + currentUser.id, JSON.stringify(offeringKindFilter));
            else localStorage.removeItem(OFFERING_FILTER_KEY_PREFIX + currentUser.id);
        } catch (_) {}
    }
    renderOfferingFilterChips();
    window.dispatchEvent(new CustomEvent('union:offeringFilterChanged'));
}

function renderOfferingFilterChips() {
    const chips = [['', 'All'], ...OFFERING_KIND_ORDER.map(k => [k, OFFERING_KINDS[k].label])];
    document.querySelectorAll('[data-offering-filter]').forEach(el => {
        el.innerHTML = chips.map(([k, label]) => {
            const on = k ? offeringKindFilter.includes(k) : !offeringKindFilter.length;
            return `<button type="button" class="offer-chip${k ? ' kind-' + k : ''}${on ? ' on' : ''}" aria-pressed="${on}" onclick="setOfferingKindFilter('${k}')">${k ? '<span class="offer-chip-dot"></span>' : ''}${label}</button>`;
        }).join('');
    });
}

// ---- Formatting --------------------------------------------------------------

/** Like esc(), but also safe inside a quoted HTML attribute. */
function escOfferAttr(value) {
    return esc(value == null ? '' : String(value)).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function splitOfferingDescription(o) {
    const text = String((o && o.description) || '').trim();
    if (!text) return { title: '', rest: '' };
    const i = text.indexOf('\n');
    if (i < 0) return { title: text, rest: '' };
    return { title: text.slice(0, i).trim(), rest: text.slice(i + 1).trim() };
}

/** The first line of the description, or "Lend · Near Linden St" without one. */
function getOfferingTitle(o) {
    const { title } = splitOfferingDescription(o);
    if (title) return title;
    return [getOfferingKindLabels(o), o.place_label].filter(Boolean).join(' · ');
}

function formatOfferingAmount(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '';
    return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/** "Free", "6 Acorns", "2 Acorns / day". */
function formatOfferingPrice(o) {
    if (o.price == null) return 'Free';
    const unit = o.price_unit === 'day' ? ' / day' : o.price_unit === 'hour' ? ' / hour' : '';
    return `${formatOfferingAmount(o.price)} ${o.currency_name || 'credits'}${unit}`;
}

/** "Today 4 PM", "Tomorrow 7:30 PM", "Sat 4 PM", "Dec 12 4 PM". */
function formatOfferingWhen(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const now = new Date();
    const dayDiff = Math.round(
        (new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate()))
        / (24 * 60 * APP_TIMING.MINUTE_MS));
    const time = d.toLocaleTimeString([], d.getMinutes() ? { hour: 'numeric', minute: '2-digit' } : { hour: 'numeric' });
    if (dayDiff === 0) return `Today ${time}`;
    if (dayDiff === 1) return `Tomorrow ${time}`;
    if (dayDiff > 1 && dayDiff < 7) return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

/** What follows the kind: the price, and for a gathering its time first. */
function getOfferingPriceLine(o) {
    const parts = [];
    if (getOfferingKinds(o).includes('gather') && o.starts_at) parts.push(formatOfferingWhen(o.starts_at));
    parts.push(formatOfferingPrice(o));
    return parts.join(' · ');
}

function getOfferingAge(o) {
    return typeof formatLastSeen === 'function' ? formatLastSeen(o.created_at) : '';
}

function getOfferingMiles(o) {
    if (typeof mapHomeMyPos === 'undefined' || !mapHomeMyPos || typeof haversineDistance !== 'function') return null;
    return haversineDistance(mapHomeMyPos.lat, mapHomeMyPos.lng, o.lat, o.lng);
}

function getOfferingDistanceText(o) {
    const miles = getOfferingMiles(o);
    if (miles == null || typeof formatDistance !== 'function') return '';
    return formatDistance(miles, { compact: true }).replace(/ away$/, '');
}

// Marker HTML is rebuilt on every redraw, so draw icons inline instead of
// running Lucide over the map each time.
const offeringIconSvgCache = {};
function offeringIconSvg(name) {
    if (offeringIconSvgCache[name] !== undefined) return offeringIconSvgCache[name];
    let svg = '';
    try {
        const pascal = name.split('-').map(p => p[0].toUpperCase() + p.slice(1)).join('');
        const node = typeof lucide !== 'undefined' && lucide.icons && lucide.icons[pascal];
        if (node) {
            const kids = Array.isArray(node[0]) ? node : (node[2] || []);
            const inner = kids.map(([tag, attrs]) =>
                `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`).join('');
            svg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
        }
    } catch (_) { svg = ''; }
    offeringIconSvgCache[name] = svg;
    return svg;
}

/** One pill per kind: "Lend" "Sell". */
function offeringKindPillHtml(o) {
    return getOfferingKinds(o).map(k =>
        `<span class="offer-kind kind-${k}">${offeringIconSvg(OFFERING_KINDS[k].icon)}${OFFERING_KINDS[k].label}</span>`).join('');
}

/** The offering's photos in order; the first is the cover. */
function getOfferingPhotoUrls(o) {
    if (o && Array.isArray(o.photo_urls) && o.photo_urls.length) return o.photo_urls.filter(Boolean);
    return o && o.photo_url ? [o.photo_url] : [];
}

/** One photo, or several side by side to swipe through, with dots. */
function offeringPhotosHtml(o, className) {
    const urls = getOfferingPhotoUrls(o);
    if (!urls.length) return '';
    const img = u => `<img class="${className}" src="${escOfferAttr(u)}" alt="" loading="lazy">`;
    if (urls.length === 1) return img(urls[0]);
    return `
        <div class="offer-carousel">
            <div class="offer-carousel-track" onscroll="onOfferCarouselScroll(this)">${urls.map(img).join('')}</div>
            <div class="offer-carousel-dots">${urls.map((_, i) =>
                `<button type="button"${i ? '' : ' class="on"'} onclick="scrollOfferCarousel(this, ${i})" aria-label="Photo ${i + 1} of ${urls.length}"></button>`).join('')}</div>
        </div>`;
}

function onOfferCarouselScroll(track) {
    const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
    track.parentNode.querySelectorAll('.offer-carousel-dots button')
        .forEach((b, j) => b.classList.toggle('on', j === i));
}

function scrollOfferCarousel(dot, i) {
    const track = dot.closest('.offer-carousel').querySelector('.offer-carousel-track');
    if (track) track.scrollTo({ left: i * track.clientWidth, behavior: 'smooth' });
}

/** The offering's cover photo, or its kind icon on the kind color. */
function offeringThumbHtml(o, className) {
    const k = offeringKindKey(o.kind);
    if (o.photo_url) return `<img class="${className}" src="${escOfferAttr(o.photo_url)}" alt="" loading="lazy">`;
    return `<span class="${className} offer-noimg kind-${k}">${offeringIconSvg(OFFERING_KINDS[k].icon)}</span>`;
}

function offeringPosterAvatarHtml(o, className) {
    if (o.poster_photo) return `<img class="${className}" src="${escOfferAttr(o.poster_photo)}" alt="">`;
    const name = String(o.poster_name || '?').trim();
    const color = typeof getMapHomeColor === 'function' ? getMapHomeColor(o.user_id) : '#5b8def';
    return `<span class="${className} offer-avatar-initial" style="background:${color}">${esc((name[0] || '?').toUpperCase())}</span>`;
}

/** "Contact · Near Linden St · 2h ago" (or "Your offering · …"). */
function getOfferingPosterLine(o) {
    return [o.is_mine ? 'Your offering' : o.known_as, o.place_label, getOfferingAge(o)].filter(Boolean).join(' · ');
}

/** The Map's card for one offering. */
function buildOfferingSheetHtml(o) {
    const id = escOfferAttr(o.id);
    const { title, rest } = splitOfferingDescription(o);
    const dist = getOfferingDistanceText(o);
    const actions = o.is_mine ? `
            <button type="button" class="map-home-card-btn primary" onclick="offeringEdit('${id}')"><i data-lucide="pencil" aria-hidden="true"></i>Edit</button>
            <button type="button" class="map-home-card-btn" onclick="offeringClose('${id}')"><i data-lucide="check" aria-hidden="true"></i>${esc(getOfferingCloseLabel(o))}</button>`
        : `
            <button type="button" class="map-home-card-btn primary" onclick="offeringMessage('${id}')"><i data-lucide="message-circle" aria-hidden="true"></i>Message</button>
            <button type="button" class="map-home-card-btn" onclick="offeringDirections('${id}')"><i data-lucide="navigation" aria-hidden="true"></i>Directions</button>`;
    return `
        ${offeringPhotosHtml(o, 'offer-sheet-photo')}
        <div class="offer-sheet-body">
            <div class="offer-sheet-top">
                <span class="offer-kinds-row">${offeringKindPillHtml(o)}</span>
                <span class="offer-sheet-price">${esc(getOfferingPriceLine(o))}</span>
                <button type="button" class="map-home-card-close" onclick="closeMapHomeCard()" aria-label="Close"><i data-lucide="x" aria-hidden="true"></i></button>
            </div>
            ${title ? `<div class="offer-sheet-title">${esc(title)}</div>` : `<div class="offer-sheet-title">${esc(getOfferingTitle(o))}</div>`}
            ${rest ? `<div class="offer-sheet-text">${esc(rest)}</div>` : ''}
            <div class="offer-sheet-poster">
                ${offeringPosterAvatarHtml(o, 'offer-sheet-avatar')}
                <div class="offer-sheet-who">
                    <b>${esc(o.is_mine ? 'You' : (o.poster_name || 'Someone'))}</b>
                    <span>${esc(getOfferingPosterLine(o))}</span>
                </div>
                ${dist ? `<span class="offer-sheet-dist">${esc(dist)}</span>` : ''}
            </div>
            <div class="map-home-card-actions">
                ${actions}
                <button type="button" class="map-home-card-btn icon" onclick="openOfferingMenu('${id}')" aria-label="More"><i data-lucide="ellipsis" aria-hidden="true"></i></button>
            </div>
        </div>`;
}

// ============================================================================
// 2. The Offer screen
// ============================================================================
//
// One screen: photos, a title and details, the kinds, the price, and two rows,
// Where and Visible, that each open a sheet from the bottom. The price's
// currency and unit open a third. A sheet's changes apply at once; Done just
// closes it.

let offerDraft = null;        // what's being posted or edited; null when closed
let offerGroups = [];         // your active groups: { id, name, logo_url, currency_name, currency_enabled }
let offerDrawer = null;       // the open sheet: 'where', 'visible', 'price' or null
let offerWhereMap = null;     // the Where sheet's map; the pin stays in the middle
let offerWhereCircle = null;
let offerWhereDragging = false;
let offerWhereLabelTimer = null;
let offerPhotoInput = null;
let offeringActionSheetEl = null;

function newOfferingId() {
    if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    // Older WebViews: RFC 4122 version 4 from getRandomValues.
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Union button -> Offer. Opens the camera first; the details screen waits underneath. */
function openOfferFlow() {
    if (!currentUser) return;
    openOfferScreen({
        id: newOfferingId(),
        editing: false,
        kinds: new Set(),
        title: '',
        details: '',
        photos: [],            // in order, cover first: { file, preview } new, or { url } already posted
        oldPhotoUrls: [],
        lat: null,
        lng: null,
        exact: false,
        exactTouched: false,
        storedBlurred: false,
        locationChanged: false,
        locating: true,
        placeLabels: {},
        priceMode: 'free',
        priceStr: '',
        priceGroupId: null,
        unit: 'each',          // 'each', 'day' (Lend) or 'hour' (Do)
        unitTouched: false,
        toContacts: true,
        groupIds: new Set(),
        audienceFromSaved: true,
        startsAt: '',
        posting: false
    });
    // iOS only lets the camera start inside the tap, so open it before any await.
    openOfferCamera();
    locateOfferDraft(offerDraft);
}

function draftFromOffering(o) {
    const { title, rest } = splitOfferingDescription(o);
    const urls = getOfferingPhotoUrls(o);
    return {
        id: o.id,
        editing: true,
        kinds: new Set(getOfferingKinds(o)),
        title,
        details: rest,
        photos: urls.map(url => ({ url })),
        oldPhotoUrls: urls.slice(),
        lat: o.lat,
        lng: o.lng,
        exact: !!o.exact,
        exactTouched: true,
        storedBlurred: !o.exact,  // the stored point is already moved; don't move it again
        locationChanged: false,
        locating: false,
        placeLabels: { [o.exact ? 'exact' : 'approx']: o.place_label || '' },
        priceMode: o.price == null ? 'free' : 'price',
        priceStr: o.price == null ? '' : formatOfferingAmount(o.price),
        priceGroupId: o.price_group_id || null,
        unit: o.price_unit || 'each',
        unitTouched: true,
        toContacts: !!o.to_contacts,
        groupIds: new Set(o.group_ids || []),
        audienceFromSaved: false,
        startsAt: o.starts_at ? toLocalDateTimeInput(o.starts_at) : '',
        posting: false
    };
}

function offeringEdit(id) {
    const o = getOffering(id);
    if (!o || !o.is_mine) return;
    openOfferScreen(draftFromOffering(o));
    if (Number.isFinite(o.lat)) setOfferLocation(o.lat, o.lng, { moved: false, keepLabels: true });
}

function openOfferScreen(draft) {
    closeOfferScreen();
    offerDraft = draft;
    const screen = document.getElementById('offerScreen');
    if (!screen) return;
    const chevron = offeringIconSvg('chevron-right');
    screen.innerHTML = `
        <header class="offer-head">
            <button type="button" class="offer-head-btn" onclick="closeOfferScreen()">Cancel</button>
            <h2 id="offerTitle">${draft.editing ? 'Edit offering' : 'New offering'}</h2>
            <button type="button" class="offer-head-btn post" id="offerPostBtn" onclick="postOffering()">${draft.editing ? 'Save' : 'Post'}</button>
        </header>
        <div class="offer-body">
            <div class="offer-photos" id="offerPhotos"></div>

            <div class="offer-text">
                <input type="text" id="offerTitleInput" class="offer-title-input" maxlength="${OFFERING_TITLE_MAX}"
                    enterkeyhint="next" autocapitalize="sentences" aria-label="Title"
                    oninput="onOfferTitleInput(this)" onkeydown="onOfferTitleKey(event)">
                <textarea id="offerDesc" class="offer-desc-input" rows="1" maxlength="${OFFERING_DETAILS_MAX}"
                    aria-label="Details" oninput="onOfferDescriptionInput(this)"></textarea>
            </div>

            <div class="offer-kinds" id="offerKinds" role="group" aria-label="What kind: choose one or more"></div>
            <div class="offer-price" id="offerPrice"></div>

            <div class="offer-rows">
                <button type="button" class="offer-row" onclick="openOfferDrawer('where')">
                    <span class="offer-row-label">Where</span>
                    <span class="offer-row-value" id="offerWhereVal"></span>${chevron}
                </button>
                <div class="offer-row hidden" id="offerWhenRow">
                    <label class="offer-row-label" for="offerWhen">When</label>
                    <input type="datetime-local" id="offerWhen" class="offer-row-input" onchange="onOfferWhenInput(this)" oninput="onOfferWhenInput(this)">
                </div>
                <button type="button" class="offer-row" onclick="openOfferDrawer('visible')">
                    <span class="offer-row-label">Visible</span>
                    <span class="offer-row-value" id="offerVisibleVal"></span>${chevron}
                </button>
            </div>

            <p class="offer-foot" id="offerFoot"></p>
        </div>
        <div class="offer-drawer hidden" id="offerDrawer">
            <div class="offer-drawer-backdrop" onclick="closeOfferDrawer()"></div>
            <div class="offer-drawer-panel" role="dialog" aria-modal="true" aria-labelledby="offerDrawerTitle">
                <div class="offer-drawer-grab" aria-hidden="true"></div>
                <header class="offer-drawer-head">
                    <h3 id="offerDrawerTitle"></h3>
                    <button type="button" class="offer-drawer-done" onclick="closeOfferDrawer()">Done</button>
                </header>
                <div class="offer-drawer-content" id="offerDrawerContent"></div>
            </div>
        </div>`;
    const title = document.getElementById('offerTitleInput');
    if (title) title.value = draft.title;
    const when = document.getElementById('offerWhen');
    if (when) when.value = draft.startsAt;
    screen.classList.remove('hidden');
    screen.setAttribute('aria-hidden', 'false');
    document.body.classList.add('offer-screen-open');
    const desc = document.getElementById('offerDesc');
    if (desc) {
        desc.value = draft.details;
        autoGrowOfferDetails(desc);   // needs the screen showing to measure
    }

    renderOfferPhotos();
    renderOfferKinds();
    renderOfferWhen();
    renderOfferPrice();
    renderOfferPlace();
    renderOfferAudience();
    renderOfferFoot();
    updateOfferPostButton();
    loadOfferGroups().then(() => {
        if (offerDraft !== draft) return;
        applyOfferAudienceDefaults(draft);
        renderOfferPrice();
        renderOfferAudience();
        updateOfferPostButton();
    });
}

function closeOfferScreen() {
    const screen = document.getElementById('offerScreen');
    closeOfferDrawer({ now: true });
    if (offerDraft) offerDraft.photos.forEach(p => { if (p.preview) URL.revokeObjectURL(p.preview); });
    offerDraft = null;
    if (screen) {
        screen.classList.add('hidden');
        screen.setAttribute('aria-hidden', 'true');
        screen.innerHTML = '';
    }
    document.body.classList.remove('offer-screen-open');
}

// ---- Sheets --------------------------------------------------------------------

function openOfferDrawer(which) {
    const d = offerDraft;
    const drawer = document.getElementById('offerDrawer');
    if (!d || !drawer) return;
    if (which === 'price' && !getOfferCurrencyGroups(d).length) return;
    // Put the keyboard away first; it would cover the sheet.
    if (document.activeElement && typeof document.activeElement.blur === 'function') document.activeElement.blur();
    if (offerDrawer && offerDrawer !== which) closeOfferDrawer({ now: true });
    offerDrawer = which;
    const title = document.getElementById('offerDrawerTitle');
    if (title) {
        title.textContent = which === 'where' ? 'Where'
            : which === 'visible' ? 'Who can see it'
            : (getOfferUnits(d).length ? 'Currency and unit' : 'Currency');
    }
    renderOfferDrawerContent();
    drawer.classList.remove('hidden');
    requestAnimationFrame(() => {
        drawer.classList.add('open');
        if (which === 'where') createOfferWhereMap();
    });
}

function renderOfferDrawerContent() {
    const content = document.getElementById('offerDrawerContent');
    if (!content || !offerDraft || !offerDrawer) return;
    if (offerDrawer === 'where') {
        // Built once per opening, so the map isn't torn down while you drag it.
        if (!document.getElementById('offerWhereMap')) renderOfferWhereDrawer(content);
        renderOfferPlace();
        renderOfferExact();
    } else if (offerDrawer === 'visible') {
        renderOfferVisibleDrawer(content);
    } else {
        renderOfferPriceDrawer(content);
    }
}

function closeOfferDrawer({ now = false } = {}) {
    const drawer = document.getElementById('offerDrawer');
    const map = offerWhereMap;
    offerDrawer = null;
    offerWhereMap = null;
    offerWhereCircle = null;
    offerWhereDragging = false;
    clearTimeout(offerWhereLabelTimer);
    const finish = () => {
        if (map) map.remove();
        if (offerDrawer || !drawer) return;  // reopened meanwhile
        drawer.classList.add('hidden');
        const content = document.getElementById('offerDrawerContent');
        if (content) content.innerHTML = '';
    };
    if (drawer) drawer.classList.remove('open');
    if (now) finish();
    else setTimeout(finish, 220);  // after it slides down
}

// ---- Photos ------------------------------------------------------------------

function renderOfferPhotos({ scroll } = {}) {
    const el = document.getElementById('offerPhotos');
    const d = offerDraft;
    if (!el || !d) return;
    const oldStrip = el.querySelector('.offer-photo-strip');
    const keepLeft = oldStrip ? oldStrip.scrollLeft : 0;
    if (!d.photos.length) {
        el.innerHTML = `
            <button type="button" class="offer-photo-empty" onclick="openOfferAddPhotoMenu()">
                ${offeringIconSvg('camera')}<b>Add photos</b><small>Up to ${OFFERING_PHOTO_MAX}. The first is the cover.</small>
            </button>`;
        return;
    }
    const tiles = d.photos.map((p, i) => `
        <div class="offer-photo-tile">
            <button type="button" class="offer-photo-open" onclick="openOfferPhotoMenu(${i})" aria-label="Photo ${i + 1}${i === 0 ? ', the cover' : ''}">
                <img src="${escOfferAttr(p.preview || p.url)}" alt="">
            </button>
            ${i === 0 && d.photos.length > 1 ? '<span class="offer-photo-cover">Cover</span>' : ''}
            <button type="button" class="offer-photo-x" onclick="removeOfferPhotoAt(${i})" aria-label="Remove photo ${i + 1}">${offeringIconSvg('x')}</button>
        </div>`).join('');
    const add = d.photos.length < OFFERING_PHOTO_MAX ? `
        <button type="button" class="offer-photo-add" onclick="openOfferAddPhotoMenu()">
            ${offeringIconSvg('camera')}<span>Add</span>
        </button>` : '';
    el.innerHTML = `<div class="offer-photo-strip">${tiles}${add}</div>`;
    const strip = el.querySelector('.offer-photo-strip');
    if (!strip) return;
    if (scroll === 'end') strip.scrollLeft = strip.scrollWidth;
    else if (scroll === 'start') strip.scrollLeft = 0;
    else strip.scrollLeft = keepLeft;
}

function openOfferAddPhotoMenu() {
    const d = offerDraft;
    if (!d) return;
    if (d.photos.length >= OFFERING_PHOTO_MAX) {
        showToast(`Up to ${OFFERING_PHOTO_MAX} photos`, 'info');
        return;
    }
    openOfferingActionSheet([
        { label: 'Take photo', action: openOfferCamera },
        { label: 'Choose from library', action: chooseOfferPhotosFromLibrary }
    ]);
}

function openOfferPhotoMenu(i) {
    const d = offerDraft;
    if (!d || !d.photos[i]) return;
    const items = [];
    if (i > 0) items.push({ label: 'Make it the cover', action: () => moveOfferPhotoToFront(i) });
    items.push({ label: 'Remove photo', danger: true, action: () => removeOfferPhotoAt(i) });
    openOfferingActionSheet(items);
}

function openOfferCamera() {
    if (typeof openCameraOverlay !== 'function') return;
    openCameraOverlay({
        banner: "Take a photo of what you're offering",
        facingMode: 'environment',
        onUse: async (canvas) => {
            if (!offerDraft) return;
            addOfferPhoto(await canvasToChatFile(canvas));
        }
    });
}

function chooseOfferPhotosFromLibrary() {
    if (!offerPhotoInput) {
        offerPhotoInput = document.createElement('input');
        offerPhotoInput.type = 'file';
        offerPhotoInput.accept = 'image/*';
        offerPhotoInput.multiple = true;
        offerPhotoInput.hidden = true;
        offerPhotoInput.addEventListener('change', async (e) => {
            const files = Array.from((e.target.files) || []);
            offerPhotoInput.value = '';
            const d = offerDraft;
            if (!files.length || !d) return;
            const room = OFFERING_PHOTO_MAX - d.photos.length;
            if (files.length > room) {
                showToast(`Up to ${OFFERING_PHOTO_MAX} photos, so ${room === 1 ? 'only 1 was' : `only ${room} were`} added`, 'info');
            }
            // One at a time, so they keep the order you picked them in.
            for (const file of files.slice(0, Math.max(0, room))) {
                try {
                    const resized = await resizeImageFileForChat(file);
                    if (offerDraft !== d) return;
                    addOfferPhoto(resized);
                } catch (err) {
                    showToast(err.message || 'Could not use that photo', 'error');
                }
            }
        });
        document.body.appendChild(offerPhotoInput);
    }
    offerPhotoInput.click();
}

function addOfferPhoto(file) {
    const d = offerDraft;
    if (!d || !file || d.photos.length >= OFFERING_PHOTO_MAX) return;
    d.photos.push({ file, preview: URL.createObjectURL(file) });
    renderOfferPhotos({ scroll: 'end' });
}

function removeOfferPhotoAt(i) {
    const d = offerDraft;
    if (!d || !d.photos[i]) return;
    const [p] = d.photos.splice(i, 1);
    if (p.preview) URL.revokeObjectURL(p.preview);
    renderOfferPhotos();
}

function moveOfferPhotoToFront(i) {
    const d = offerDraft;
    if (!d || !d.photos[i] || i === 0) return;
    const [p] = d.photos.splice(i, 1);
    d.photos.unshift(p);
    renderOfferPhotos({ scroll: 'start' });
}

// ---- Title and details -------------------------------------------------------

function onOfferTitleInput(el) {
    if (offerDraft) offerDraft.title = el.value;
}

function onOfferTitleKey(e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const desc = document.getElementById('offerDesc');
    if (desc) desc.focus();
}

function onOfferDescriptionInput(el) {
    if (offerDraft) offerDraft.details = el.value;
    autoGrowOfferDetails(el);
}

function autoGrowOfferDetails(el) {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
}

/** Stored as one description: the title is its first line, shown in bold. */
function getOfferDescription(d) {
    const title = String(d.title || '').replace(/\s+/g, ' ').trim();
    const details = String(d.details || '').trim();
    return [title, details].filter(Boolean).join('\n');
}

// ---- Location ----------------------------------------------------------------

/** Start where you are; if that fails, where the Map is looking. */
async function locateOfferDraft(draft) {
    let pos = null;
    try {
        pos = await getGPSLocation({ maxAgeMs: APP_TIMING.RELAXED_GPS_MAX_AGE_MS });
    } catch (_) { pos = null; }
    if (offerDraft !== draft) return;
    let guessed = false;
    if (!pos && typeof mapHomeMyPos !== 'undefined' && mapHomeMyPos) pos = mapHomeMyPos;
    if (!pos && typeof mapHome !== 'undefined' && mapHome) {
        const c = mapHome.getCenter();
        pos = { lat: c.lat, lng: c.lng };
        guessed = true;
    }
    draft.locating = false;
    if (!pos) {
        renderOfferPlace();
        updateOfferPostButton();
        return;
    }
    draft.locationGuessed = guessed;
    setOfferLocation(pos.lat, pos.lng, { moved: false });
}

function setOfferLocation(lat, lng, { moved, keepLabels } = {}) {
    const d = offerDraft;
    if (!d || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
    d.lat = lat;
    d.lng = lng;
    // Pick the shifted point now, so the place label matches what's posted.
    const blurred = blurLocationWithinRadius(lat, lng, OFFERING_APPROX_RADIUS_M);
    d.blurLat = blurred.lat;
    d.blurLng = blurred.lng;
    if (moved) {
        d.locationChanged = true;
        d.locationGuessed = false;
    }
    if (!keepLabels) d.placeLabels = {};
    // Dragging the sheet's map already put it there; anything else moves the map.
    if (!moved) updateOfferWhereMap({ recenter: true });
    renderOfferPlace();
    refreshOfferPlaceLabel();
    updateOfferPostButton();
}

/** The point that gets saved: exact, or moved within ~200 m. */
function getOfferStoredPoint(d) {
    if (d.exact || (d.storedBlurred && !d.locationChanged)) return { lat: d.lat, lng: d.lng };
    return { lat: d.blurLat, lng: d.blurLng };
}

function shortenStreetName(name) {
    return String(name || '')
        .replace(/\bStreet\b/, 'St').replace(/\bAvenue\b/, 'Ave').replace(/\bBoulevard\b/, 'Blvd')
        .replace(/\bRoad\b/, 'Rd').replace(/\bDrive\b/, 'Dr').replace(/\bPlace\b/, 'Pl').replace(/\bLane\b/, 'Ln');
}

/** "Near Linden St" (approximate) or "Dolores Park" / "Linden St" (exact). */
async function fetchOfferingPlaceLabel(lat, lng, exact) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => ctrl && ctrl.abort(), OFFERING_LABEL_TIMEOUT_MS);
    try {
        const resp = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${lat.toFixed(5)}&lon=${lng.toFixed(5)}&format=json&zoom=17&addressdetails=1`,
            { headers: { 'Accept-Language': 'en' }, signal: ctrl ? ctrl.signal : undefined }
        );
        if (!resp.ok) return '';
        const data = await resp.json();
        const a = data.address || {};
        const road = shortenStreetName(a.road || a.pedestrian || a.footway || a.path || '');
        const area = a.neighbourhood || a.suburb || a.quarter || a.village || a.town || a.city || '';
        if (exact) {
            const name = data.name && data.name !== a.road ? data.name : '';
            return (name || road || area).slice(0, 120);
        }
        if (road) return `Near ${road}`.slice(0, 120);
        return area ? `Near ${area}`.slice(0, 120) : '';
    } catch (_) {
        return '';
    } finally {
        clearTimeout(timer);
    }
}

async function refreshOfferPlaceLabel() {
    const d = offerDraft;
    if (!d || !Number.isFinite(d.lat)) return;
    const mode = d.exact ? 'exact' : 'approx';
    if (d.placeLabels[mode] !== undefined) { renderOfferPlace(); return; }
    d.placeLabels[mode] = null;  // loading
    renderOfferPlace();
    const pt = getOfferStoredPoint(d);
    const label = await fetchOfferingPlaceLabel(pt.lat, pt.lng, d.exact);
    if (offerDraft !== d) return;
    d.placeLabels[mode] = label || '';
    renderOfferPlace();
}

/** The Where row and the Where sheet: the street, or what's still missing. */
function getOfferPlaceText(d) {
    if (d.locating) return { text: 'Finding where you are…', missing: false };
    if (!Number.isFinite(d.lat)) return { text: 'Choose the spot', missing: true };
    if (d.locationGuessed) return { text: 'Move the pin to the spot', missing: true };
    const label = d.placeLabels[d.exact ? 'exact' : 'approx'];
    if (label === null) return { text: 'Looking up the street…', missing: false };
    return { text: label || (d.exact ? 'Exact spot' : `Within about ${OFFERING_APPROX_RADIUS_M} m`), missing: false };
}

function renderOfferPlace() {
    const d = offerDraft;
    if (!d) return;
    const { text, missing } = getOfferPlaceText(d);
    const row = document.getElementById('offerWhereVal');
    if (row) {
        row.textContent = text;
        row.classList.toggle('missing', missing);
    }
    const inSheet = document.getElementById('offerWherePlace');
    if (inSheet) inSheet.textContent = text;
}

function renderOfferExact() {
    const el = document.getElementById('offerExactOpts');
    const d = offerDraft;
    if (!el || !d) return;
    const opt = (exact, title, sub) => `
        <button type="button" class="offer-opt${d.exact === exact ? ' on' : ''}" role="radio" aria-checked="${d.exact === exact}" onclick="setOfferExact(${exact})">
            <span class="offer-radio" aria-hidden="true"></span>
            <span class="offer-opt-text"><b>${title}</b><small>${sub}</small></span>
        </button>`;
    el.innerHTML = opt(false, 'Approximate', `Shown somewhere within about ${OFFERING_APPROX_RADIUS_M} m`)
        + opt(true, 'Exact', 'Shows the precise spot. Best for gatherings.');
}

function setOfferExact(exact) {
    const d = offerDraft;
    if (!d || d.exact === !!exact) return;
    d.exact = !!exact;
    d.exactTouched = true;
    renderOfferExact();
    updateOfferWhereMap({ zoom: true });
    refreshOfferPlaceLabel();
}

function renderOfferWhereDrawer(content) {
    content.innerHTML = `
        <div class="offer-where-map">
            <div class="offer-where-leaflet" id="offerWhereMap"></div>
            <div class="offer-picker-pin" aria-hidden="true">${offeringIconSvg('map-pin')}</div>
            <span class="offer-where-hint">Drag the map to move the pin</span>
        </div>
        <div class="offer-where-place" id="offerWherePlace"></div>
        <div class="offer-opts" id="offerExactOpts" role="radiogroup" aria-label="How exact"></div>`;
}

/** Close enough to see the street, or for Approximate the whole circle. */
function getOfferWhereZoom(d) {
    return d.exact ? 17 : 15;
}

function createOfferWhereMap() {
    const d = offerDraft;
    const el = document.getElementById('offerWhereMap');
    if (!d || !el || offerWhereMap || typeof L === 'undefined' || offerDrawer !== 'where') return;
    let start = Number.isFinite(d.lat) ? [d.lat, d.lng] : null;
    if (!start && typeof mapHome !== 'undefined' && mapHome) {
        const c = mapHome.getCenter();
        start = [c.lat, c.lng];
    }
    // Zooming keeps the middle where it is, so only a drag moves the pin.
    offerWhereMap = L.map(el, {
        zoomControl: false, attributionControl: false,
        touchZoom: 'center', scrollWheelZoom: 'center', doubleClickZoom: 'center'
    });
    addContactLocationTileLayer(offerWhereMap);
    offerWhereMap.setView(start || [MAP_HOME_WORLD_VIEW.lat, MAP_HOME_WORLD_VIEW.lng],
        start ? getOfferWhereZoom(d) : MAP_HOME_WORLD_VIEW.zoom, { animate: false });
    offerWhereMap.on('move', syncOfferWhereCircle);
    offerWhereMap.on('dragstart', () => {
        offerWhereDragging = true;
        clearTimeout(offerWhereLabelTimer);
    });
    offerWhereMap.on('moveend', () => {
        if (!offerWhereDragging || !offerWhereMap) return;
        offerWhereDragging = false;
        const c = offerWhereMap.getCenter();
        // Wait for the map to settle before looking up the street.
        clearTimeout(offerWhereLabelTimer);
        offerWhereLabelTimer = setTimeout(() => setOfferLocation(c.lat, c.lng, { moved: true }), 400);
    });
    syncOfferWhereCircle();
    // The sheet is still sliding up; measure again once it's in place.
    setTimeout(() => { if (offerWhereMap) offerWhereMap.invalidateSize(); }, 260);
}

/** Approximate: a circle around the pin of the area it's shown within. */
function syncOfferWhereCircle() {
    const d = offerDraft;
    if (!offerWhereMap || !d) return;
    if (d.exact) {
        if (offerWhereCircle) offerWhereMap.removeLayer(offerWhereCircle);
        offerWhereCircle = null;
        return;
    }
    const c = offerWhereMap.getCenter();
    if (offerWhereCircle) offerWhereCircle.setLatLng(c);
    else {
        offerWhereCircle = L.circle(c, {
            radius: OFFERING_APPROX_RADIUS_M, color: '#3a7ca5', weight: 1.5, dashArray: '4 4',
            fillColor: '#3a7ca5', fillOpacity: 0.14, interactive: false
        }).addTo(offerWhereMap);
    }
}

function updateOfferWhereMap({ recenter = false, zoom = false } = {}) {
    const d = offerDraft;
    if (!offerWhereMap || !d) return;
    if (recenter && Number.isFinite(d.lat)) {
        offerWhereMap.setView([d.lat, d.lng], getOfferWhereZoom(d), { animate: false });
    } else if (zoom) {
        offerWhereMap.setZoom(getOfferWhereZoom(d), { animate: false });
    }
    syncOfferWhereCircle();
}

// ---- Kind, when ----------------------------------------------------------------

/** The draft's main kind: the first chosen, in the usual order. */
function getOfferDraftMainKind(d) {
    return OFFERING_KIND_ORDER.find(k => d.kinds.has(k)) || null;
}

function renderOfferKinds() {
    const el = document.getElementById('offerKinds');
    const d = offerDraft;
    if (!el || !d) return;
    el.innerHTML = OFFERING_KIND_ORDER.map(k => {
        const on = d.kinds.has(k);
        return `<button type="button" class="offer-kind-pill kind-${k}${on ? ' on' : ''}" aria-pressed="${on}" onclick="toggleOfferKind('${k}')">${OFFERING_KINDS[k].label}</button>`;
    }).join('');
    const one = d.kinds.size === 1 ? OFFERING_KINDS[getOfferDraftMainKind(d)] : null;
    const title = document.getElementById('offerTitleInput');
    if (title) title.placeholder = one ? one.titleHint : 'What are you offering?';
    const desc = document.getElementById('offerDesc');
    if (desc) desc.placeholder = `${one ? one.detailsHint : 'Add details'} (optional)`;
}

/** Price units the chosen kinds allow: per day (Lend), per hour (Do). */
function getOfferUnits(d) {
    return OFFERING_KIND_ORDER.filter(k => d.kinds.has(k)).map(k => OFFERING_KINDS[k].unit).filter(Boolean);
}

/** Kinds are multi-select: an offering can be Lend and Sell, say. */
function toggleOfferKind(kind) {
    const d = offerDraft;
    if (!d || !OFFERING_KINDS[kind]) return;
    if (d.kinds.has(kind)) d.kinds.delete(kind);
    else d.kinds.add(kind);
    // Gatherings are public by nature; the rest start approximate.
    if (!d.exactTouched && d.exact !== d.kinds.has('gather')) {
        d.exact = d.kinds.has('gather');
        renderOfferExact();
        updateOfferWhereMap({ zoom: true });
        refreshOfferPlaceLabel();
    }
    const units = getOfferUnits(d);
    if (!d.unitTouched) d.unit = units[0] || 'each';
    else if (d.unit !== 'each' && !units.includes(d.unit)) d.unit = 'each';
    renderOfferKinds();
    renderOfferWhen();
    renderOfferPrice();
    renderOfferFoot();
    updateOfferPostButton();
}

function renderOfferWhen() {
    const row = document.getElementById('offerWhenRow');
    if (row && offerDraft) row.classList.toggle('hidden', !offerDraft.kinds.has('gather'));
}

function onOfferWhenInput(el) {
    if (!offerDraft) return;
    offerDraft.startsAt = el.value;
    renderOfferFoot();
}

function toLocalDateTimeInput(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderOfferFoot() {
    const el = document.getElementById('offerFoot');
    const d = offerDraft;
    if (!el || !d) return;
    el.textContent = d.kinds.has('gather') && d.startsAt
        ? 'Shown until a few hours after it starts, or until you end it.'
        : 'Shown for 2 weeks, or until you mark it taken.';
}

// ---- Price ---------------------------------------------------------------------

/** Currencies you can price in: the chosen groups', or any of yours for contacts only. */
function getOfferCurrencyGroups(d) {
    const withCurrency = offerGroups.filter(g => g.currency_enabled !== false && g.currency_name);
    return d.groupIds.size ? withCurrency.filter(g => d.groupIds.has(g.id)) : withCurrency;
}

function getOfferUnitSuffix(unit) {
    return unit === 'day' ? ' / day' : unit === 'hour' ? ' / hour' : '';
}

/** Free | Price, then the amount and a button for the currency and unit. */
function renderOfferPrice() {
    const el = document.getElementById('offerPrice');
    const d = offerDraft;
    if (!el || !d) return;
    const options = getOfferCurrencyGroups(d);
    if (!options.length) d.priceMode = 'free';
    if (options.length && !options.some(g => g.id === d.priceGroupId)) {
        let saved = null;
        try { saved = localStorage.getItem(OFFERING_CURRENCY_KEY_PREFIX + currentUser.id); } catch (_) {}
        d.priceGroupId = options.some(g => g.id === saved) ? saved : options[0].id;
    }
    const priced = d.priceMode === 'price';
    const units = getOfferUnits(d);
    const group = options.find(g => g.id === d.priceGroupId);
    const label = group ? `${group.currency_name}${getOfferUnitSuffix(d.unit)}` : '';
    let currency = '';
    if (priced && (options.length > 1 || units.length)) {
        currency = `<button type="button" class="offer-cur-btn" onclick="openOfferDrawer('price')" aria-label="Currency and unit: ${escOfferAttr(label)}"><span>${esc(label)}</span>${offeringIconSvg('chevron-down')}</button>`;
    } else if (priced) {
        currency = `<span class="offer-cur-static">${esc(label)}</span>`;
    }
    el.innerHTML = `
        <div class="offer-price-row">
            <div class="offer-seg" role="group" aria-label="Price">
                <button type="button" class="${priced ? '' : 'on'}" aria-pressed="${!priced}" onclick="setOfferPriceMode('free')">Free</button>
                <button type="button" class="${priced ? 'on' : ''}" aria-pressed="${priced}" onclick="setOfferPriceMode('price')"${options.length ? '' : ' disabled'}>Price</button>
            </div>
            ${priced ? `<input type="text" id="offerAmount" class="offer-amount" inputmode="decimal" placeholder="0" value="${escOfferAttr(d.priceStr)}" oninput="onOfferAmountInput(this)" aria-label="Amount">${currency}` : ''}
        </div>
        ${options.length ? '' : `<p class="offer-note">${offerGroups.length ? 'None of these groups uses a currency, so this one is free.' : 'Join a group that uses a currency to set a price.'}</p>`}`;
    if (offerDrawer === 'price') {
        if (priced && options.length) renderOfferDrawerContent();
        else closeOfferDrawer();
    }
}

function renderOfferPriceDrawer(content) {
    const d = offerDraft;
    const options = getOfferCurrencyGroups(d);
    const units = getOfferUnits(d);
    const group = options.find(g => g.id === d.priceGroupId);
    const unitBtn = (unit, label) =>
        `<button type="button" class="${d.unit === unit ? 'on' : ''}" aria-pressed="${d.unit === unit}" onclick="setOfferUnit('${unit}')">${label}</button>`;
    const rows = options.map(g => {
        const on = g.id === d.priceGroupId;
        return `
            <button type="button" class="offer-list-row" role="radio" aria-checked="${on}" data-id="${escOfferAttr(g.id)}" onclick="setOfferCurrency(this.dataset.id)">
                <span class="offer-list-text"><b>${esc(g.currency_name)}</b></span>
                <span class="offer-list-side">${esc(g.name)}</span>
                <span class="offer-tick" aria-hidden="true">${on ? offeringIconSvg('check') : ''}</span>
            </button>`;
    }).join('');
    // Paying in a group's currency takes membership; say so when others can see it.
    const others = group && (d.toContacts || d.groupIds.size > 1);
    content.innerHTML = `
        ${units.length ? `<div class="offer-seg offer-seg-full" role="group" aria-label="Unit">${unitBtn('each', 'Once')}${units.map(u => unitBtn(u, u === 'day' ? 'Per day' : 'Per hour')).join('')}</div>` : ''}
        <div class="offer-drawer-label">Currency</div>
        <div class="offer-list" role="radiogroup" aria-label="Currency">${rows}</div>
        ${others ? `<p class="offer-drawer-note">Only members of ${esc(group.name)} can pay in ${esc(group.currency_name)}. Anyone else who sees it can still message you.</p>` : ''}`;
}

function setOfferPriceMode(mode) {
    const d = offerDraft;
    if (!d) return;
    d.priceMode = mode === 'price' ? 'price' : 'free';
    renderOfferPrice();
    updateOfferPostButton();
    if (d.priceMode === 'price') {
        const amount = document.getElementById('offerAmount');
        if (amount) amount.focus();
    }
}

function onOfferAmountInput(el) {
    if (!offerDraft) return;
    offerDraft.priceStr = el.value.replace(/[^\d.,]/g, '');
    if (el.value !== offerDraft.priceStr) el.value = offerDraft.priceStr;
    updateOfferPostButton();
}

function setOfferCurrency(groupId) {
    if (!offerDraft) return;
    offerDraft.priceGroupId = groupId;
    renderOfferPrice();
}

/** Once (a plain price), per day or per hour. */
function setOfferUnit(unit) {
    if (!offerDraft) return;
    offerDraft.unit = unit === 'day' || unit === 'hour' ? unit : 'each';
    offerDraft.unitTouched = true;
    renderOfferPrice();
}

function parseOfferAmount(str) {
    const v = parseFloat(String(str || '').replace(',', '.'));
    return Number.isFinite(v) ? Math.round(v * 100) / 100 : NaN;
}

// ---- Audience ------------------------------------------------------------------

async function loadOfferGroups() {
    if (!currentUser) return offerGroups;
    try {
        const { data, error } = await db
            .from('members')
            .select('group_id, groups(id, name, logo_url, logo_updated_at, currency_name, currency_enabled)')
            .eq('user_id', currentUser.id)
            .eq('status', 'active');
        if (error) throw error;
        offerGroups = (data || []).map(m => m.groups).filter(Boolean)
            .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    } catch (e) {
        console.warn('[offerings] could not load groups:', e);
    }
    return offerGroups;
}

/** First time: contacts and every group. After that, your last choice. */
function applyOfferAudienceDefaults(d) {
    const ids = new Set(offerGroups.map(g => g.id));
    if (!d.audienceFromSaved) {
        d.groupIds = new Set([...d.groupIds].filter(id => ids.has(id)));
        return;
    }
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(OFFERING_AUDIENCE_KEY_PREFIX + currentUser.id) || 'null'); } catch (_) {}
    if (saved && typeof saved === 'object') {
        d.toContacts = !!saved.contacts;
        d.groupIds = new Set((saved.groups || []).filter(id => ids.has(id)));
    } else {
        d.toContacts = true;
        d.groupIds = new Set(ids);
    }
    if (!d.toContacts && !d.groupIds.size) {
        d.toContacts = true;
        d.groupIds = new Set(ids);
    }
}

/** The Visible row: "Contacts, Oak Park Neighbors". */
function renderOfferAudience() {
    const el = document.getElementById('offerVisibleVal');
    const d = offerDraft;
    if (!el || !d) return;
    const names = [];
    if (d.toContacts) names.push('Contacts');
    offerGroups.forEach(g => { if (d.groupIds.has(g.id)) names.push(g.name); });
    el.textContent = names.join(', ') || 'Choose who';
    el.classList.toggle('missing', !names.length);
    if (offerDrawer === 'visible') renderOfferDrawerContent();
}

function renderOfferVisibleDrawer(content) {
    const d = offerDraft;
    const contactCount = (typeof contactsLoadedRows !== 'undefined' && Array.isArray(contactsLoadedRows)) ? contactsLoadedRows.length : 0;
    const row = (key, on, avatar, name, sub) => `
        <button type="button" class="offer-list-row" role="checkbox" aria-checked="${on}" data-key="${escOfferAttr(key)}" onclick="toggleOfferAudience(this.dataset.key)">
            ${avatar}
            <span class="offer-list-text"><b>${esc(name)}</b><small>${esc(sub)}</small></span>
            <span class="offer-check${on ? ' on' : ''}" aria-hidden="true">${on ? offeringIconSvg('check') : ''}</span>
        </button>`;
    const logo = g => {
        if (g.logo_url) {
            const src = typeof withImageCacheBust === 'function' ? withImageCacheBust(g.logo_url, g.logo_updated_at) : g.logo_url;
            return `<span class="offer-list-avatar"><img src="${escOfferAttr(src)}" alt=""></span>`;
        }
        const color = typeof getMapHomeColor === 'function' ? getMapHomeColor(g.id) : '#5b8def';
        return `<span class="offer-list-avatar" style="background:${color}">${esc((String(g.name || '?').trim()[0] || '?').toUpperCase())}</span>`;
    };
    content.innerHTML = `
        <div class="offer-list">
            ${row('contacts', d.toContacts, `<span class="offer-list-avatar contacts">${offeringIconSvg('user-round')}</span>`,
                'Contacts', contactCount ? `${contactCount} ${contactCount === 1 ? 'person' : 'people'}` : 'People you know')}
            ${offerGroups.map(g => row(g.id, d.groupIds.has(g.id), logo(g), g.name,
                g.currency_enabled !== false && g.currency_name ? `Group · uses ${g.currency_name}` : 'Group')).join('')}
        </div>
        <p class="offer-drawer-note">At least one has to stay on. Your choice is remembered for next time.</p>`;
}

function toggleOfferAudience(key) {
    const d = offerDraft;
    if (!d) return;
    const on = key === 'contacts' ? d.toContacts : d.groupIds.has(key);
    if (on && (d.toContacts ? 1 : 0) + d.groupIds.size === 1) {
        showToast('Choose at least one: your contacts or a group', 'info');
        return;
    }
    if (key === 'contacts') d.toContacts = !on;
    else if (on) d.groupIds.delete(key);
    else d.groupIds.add(key);
    renderOfferAudience();
    renderOfferPrice();
    updateOfferPostButton();
}

// ---- Posting -------------------------------------------------------------------

/** Why it can't be posted yet, or '' when it can. */
function getOfferProblem(d) {
    if (!d.kinds.size) return 'Choose what kind of offering this is';
    if (d.locating) return 'Still finding where you are';
    if (!Number.isFinite(d.lat)) return 'Tap Where to choose the spot';
    if (!d.toContacts && !d.groupIds.size) return 'Choose who can see it';
    if (d.priceMode === 'price') {
        const amount = parseOfferAmount(d.priceStr);
        if (!(amount > 0)) return 'Enter a price, or choose Free';
        if (!d.priceGroupId) return 'Choose a currency';
    }
    if (getOfferDescription(d).length > OFFERING_DESCRIPTION_MAX) return 'The description is too long';
    return '';
}

function updateOfferPostButton() {
    const btn = document.getElementById('offerPostBtn');
    const d = offerDraft;
    if (!btn || !d) return;
    // Stays tappable when incomplete, so a tap can say what's missing.
    btn.classList.toggle('dim', !!getOfferProblem(d));
    btn.disabled = !!d.posting;
    btn.textContent = d.posting ? (d.editing ? 'Saving…' : 'Posting…') : (d.editing ? 'Save' : 'Post');
}

async function uploadOfferingPhoto(file, offeringId, n) {
    const path = `${currentUser.id}/offering_${offeringId}_${Date.now()}_${n}.jpg`;
    const { error } = await db.storage.from('avatars').upload(path, file, { upsert: false, contentType: 'image/jpeg' });
    if (error) throw error;
    const { data } = db.storage.from('avatars').getPublicUrl(path);
    if (!data || !data.publicUrl) throw new Error('Could not create the photo link');
    return data.publicUrl;
}

/** Best effort: delete one of your own offering photos from storage. */
function removeOfferingPhoto(url) {
    if (!currentUser || !url) return;
    const i = String(url).indexOf(OFFERING_STORAGE_PUBLIC_PATH);
    if (i < 0) return;
    const path = decodeURIComponent(String(url).slice(i + OFFERING_STORAGE_PUBLIC_PATH.length).split('?')[0]);
    if (!path.startsWith(`${currentUser.id}/offering_`)) return;
    Promise.resolve(db.storage.from('avatars').remove([path]))
        .then(({ error }) => { if (error) console.warn('[offerings] photo cleanup failed:', error); })
        .catch(() => {});
}

/** Uploads the new photos side by side; returns every photo's link, in order. */
async function uploadOfferPhotos(d) {
    const results = await Promise.allSettled(d.photos.map((p, i) =>
        p.url ? Promise.resolve(p.url) : uploadOfferingPhoto(p.file, d.id, i)));
    const urls = results.map(r => (r.status === 'fulfilled' ? r.value : null));
    const fresh = urls.filter((u, i) => u && !d.photos[i].url);
    const failed = results.find(r => r.status === 'rejected');
    if (failed) {
        fresh.forEach(removeOfferingPhoto);
        throw failed.reason;
    }
    return { urls, fresh };
}

async function postOffering() {
    const d = offerDraft;
    if (!d || d.posting || !currentUser) return;
    const problem = getOfferProblem(d);
    if (problem) {
        showToast(problem, 'error');
        return;
    }
    d.posting = true;
    updateOfferPostButton();
    let fresh = [];
    try {
        const uploaded = await uploadOfferPhotos(d);
        const urls = uploaded.urls;
        fresh = uploaded.fresh;

        const pt = getOfferStoredPoint(d);
        const mode = d.exact ? 'exact' : 'approx';
        let label = d.placeLabels[mode];
        if (typeof label !== 'string') label = await fetchOfferingPlaceLabel(pt.lat, pt.lng, d.exact);

        const price = d.priceMode === 'price' ? parseOfferAmount(d.priceStr) : null;
        const kinds = OFFERING_KIND_ORDER.filter(k => d.kinds.has(k));
        const unit = getOfferUnits(d).includes(d.unit) ? d.unit : 'each';
        const startsAt = d.kinds.has('gather') && d.startsAt ? new Date(d.startsAt) : null;
        const { error } = await db.rpc('save_offering', {
            p_id: d.id,
            p_kind: kinds[0],
            p_kinds: kinds,
            p_description: getOfferDescription(d) || null,
            p_photo_url: urls[0] || null,
            p_photo_urls: urls,
            p_lat: pt.lat,
            p_lng: pt.lng,
            p_exact: d.exact,
            p_place_label: label || null,
            p_price: price,
            p_price_group_id: price == null ? null : d.priceGroupId,
            p_price_unit: price == null ? null : unit,
            p_to_contacts: d.toContacts,
            p_group_ids: [...d.groupIds],
            p_starts_at: startsAt && !Number.isNaN(startsAt.getTime()) ? startsAt.toISOString() : null
        });
        if (error) throw error;
        fresh = [];

        // Photos you removed or replaced are no longer needed.
        d.oldPhotoUrls.filter(u => !urls.includes(u)).forEach(removeOfferingPhoto);
        try {
            localStorage.setItem(OFFERING_AUDIENCE_KEY_PREFIX + currentUser.id,
                JSON.stringify({ contacts: d.toContacts, groups: [...d.groupIds] }));
            if (price != null && d.priceGroupId) localStorage.setItem(OFFERING_CURRENCY_KEY_PREFIX + currentUser.id, d.priceGroupId);
        } catch (_) {}

        const { id, editing } = d;
        closeOfferScreen();
        showToast(editing ? 'Offering updated' : 'Offering posted', 'success');
        // Make sure the filter doesn't hide what you just posted.
        if (!offeringMatchesFilter({ kinds })) setOfferingKindFilter('');
        await loadOfferings({ force: true });
        if (typeof mapHomeShowOffering === 'function') mapHomeShowOffering(id);
    } catch (e) {
        // The save failed after the upload: those copies would be orphans.
        fresh.forEach(removeOfferingPhoto);
        console.error('[offerings] post failed:', e);
        showToast('Could not post: ' + (e.message || 'error'), 'error');
    } finally {
        if (offerDraft === d) {
            d.posting = false;
            updateOfferPostButton();
        }
    }
}

// ============================================================================
// 3. Acting on an offering
// ============================================================================

// Anyone who can see an offering can message its poster about it, contact or
// not (sql/offering-messages.sql). The first message carries the offering.
function offeringMessage(id) {
    const o = getOffering(id);
    if (!o || o.is_mine) return;
    openDirectMessageAboutOffering(o.user_id, o.id);
}

function offeringDirections(id) {
    const o = getOffering(id);
    if (o && typeof openLocationInExternalMaps === 'function') openLocationInExternalMaps(o.lat, o.lng);
}

function afterOfferingRemoved() {
    if (typeof closeMapHomeCard === 'function') closeMapHomeCard();
    return loadOfferings({ force: true });
}

async function offeringClose(id) {
    const o = getOffering(id);
    if (!o || !o.is_mine) return;
    const { error } = await db.rpc('close_offering', { p_id: id });
    if (error) {
        showToast('Could not update: ' + (error.message || 'error'), 'error');
        return;
    }
    showToast("Done. It's off the map now.", 'success');
    await afterOfferingRemoved();
}

function confirmDeleteOffering(id) {
    const overlay = document.getElementById('modalOverlay');
    const body = document.getElementById('modalBody');
    if (!overlay || !body) return;
    body.innerHTML = `
        <h3>Delete this offering?</h3>
        <p style="font-size:0.92rem;color:var(--dark-gray);margin-bottom:0.75rem;">
            It disappears from everyone's Map and Feed. This can't be undone.
        </p>
        <div class="form-actions">
            <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
            <button type="button" class="btn btn-danger" onclick="deleteOffering('${escOfferAttr(id)}')">Delete</button>
        </div>`;
    overlay.classList.remove('hidden');
}

async function deleteOffering(id) {
    if (typeof closeModal === 'function') closeModal();
    const o = getOffering(id);
    if (!o || !o.is_mine) return;
    const { error } = await db.from('offerings').delete().eq('id', id);
    if (error) {
        showToast('Could not delete: ' + (error.message || 'error'), 'error');
        return;
    }
    getOfferingPhotoUrls(o).forEach(removeOfferingPhoto);
    showToast('Offering deleted', 'success');
    await afterOfferingRemoved();
}

function openOfferingMenu(id) {
    const o = getOffering(id);
    if (!o) return;
    if (o.is_mine) {
        openOfferingActionSheet([
            { label: 'Edit', action: () => offeringEdit(id) },
            { label: getOfferingCloseLabel(o), action: () => offeringClose(id) },
            { label: 'Delete', danger: true, action: () => confirmDeleteOffering(id) }
        ]);
        return;
    }
    const name = o.poster_name || 'this person';
    openOfferingActionSheet([
        { label: 'Directions', action: () => offeringDirections(id) },
        { label: 'Report offering', danger: true, action: () => openReportDialog({ userId: o.user_id, contentType: 'offering', contentId: o.id, contextLabel: 'offering' }) },
        { label: `Block ${name}`, danger: true, action: () => openBlockUserConfirm(o.user_id, name) }
    ]);
}

// A bottom action sheet, styled like the chat photo picker's.
function openOfferingActionSheet(items) {
    closeOfferingActionSheet();
    const sheet = document.createElement('div');
    sheet.className = 'chat-photo-action-sheet';
    sheet.innerHTML = `
        <div class="chat-photo-action-sheet-backdrop" data-cancel></div>
        <div class="chat-photo-action-sheet-panel">
            ${items.map((it, i) => `<button type="button" class="chat-photo-action-item${it.danger ? ' danger' : ''}" data-i="${i}">${esc(it.label)}</button>`).join('')}
            <button type="button" class="chat-photo-action-item chat-photo-action-cancel" data-cancel>Cancel</button>
        </div>`;
    sheet.addEventListener('click', (e) => {
        const target = e.target.closest('[data-i], [data-cancel]');
        if (!target) return;
        const item = target.hasAttribute('data-i') ? items[Number(target.dataset.i)] : null;
        closeOfferingActionSheet();
        // Run inside the same tap: a file picker or camera only opens from one.
        if (item && typeof item.action === 'function') item.action();
    });
    document.body.appendChild(sheet);
    offeringActionSheetEl = sheet;
    requestAnimationFrame(() => sheet.classList.add('active'));
}

function closeOfferingActionSheet() {
    const sheet = offeringActionSheetEl;
    offeringActionSheetEl = null;
    if (!sheet) return;
    sheet.classList.remove('active');
    setTimeout(() => { if (sheet.parentNode) sheet.parentNode.removeChild(sheet); }, 200);
}

document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !offerDraft) return;
    if (offerDrawer) closeOfferDrawer();
    else closeOfferScreen();
});

// Blocking someone hides their offerings at once; unblocking brings them back
// on the reload, since the server leaves blocked posters out too.
window.addEventListener('union:blockedUsersChanged', () => {
    window.dispatchEvent(new CustomEvent('union:offeringsLoaded'));
    loadOfferings({ force: true });
});
