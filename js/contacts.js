let contactsSearchQuery = '';
let contactsLoadedRows = [];
let contactsSortMode = 'trust';
let _dragJustEnded = false;

function getContactsSearchInput() {
    return document.getElementById('contactsSearchInput');
}

function getContactsSearchClearBtn() {
    return document.getElementById('contactsSearchClearBtn');
}

function updateContactsSearchClearVisibility() {
    const clearBtn = getContactsSearchClearBtn();
    if (!clearBtn) return;
    clearBtn.classList.toggle('hidden', !contactsSearchQuery);
}

function normalizeContactsSearchQuery(query) {
    return (query || '').trim().toLowerCase();
}

function setContactsSearchQuery(query, options = {}) {
    const { syncInput = true } = options;
    contactsSearchQuery = normalizeContactsSearchQuery(query);
    if (syncInput) {
        const input = getContactsSearchInput();
        if (input) input.value = query || '';
    }
    updateContactsSearchClearVisibility();
}

function clearContactSearchState() {
    setContactsSearchQuery('');
}

function bindContactsSearchInput() {
    const input = getContactsSearchInput();
    const clearBtn = getContactsSearchClearBtn();
    if (!input || input.dataset.bound === '1') return;
    input.addEventListener('input', () => {
        setContactsSearchQuery(input.value, { syncInput: false });
        renderContactsForCurrentQuery();
    });
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            setContactsSearchQuery('');
            renderContactsForCurrentQuery();
            input.focus();
        });
    }
    updateContactsSearchClearVisibility();
    input.dataset.bound = '1';
}

function bindContactsSortButton() {
    const btn = document.getElementById('contactsSortBtn');
    const label = document.getElementById('contactsSortLabel');
    if (!btn || btn.dataset.bound === '1') return;
    btn.addEventListener('click', () => {
        if (contactsSortMode === 'recent') contactsSortMode = 'age';
        else if (contactsSortMode === 'age') contactsSortMode = 'trust';
        else if (contactsSortMode === 'trust') contactsSortMode = 'custom';
        else contactsSortMode = 'recent';
        updateSortLabel();
        scheduleSortPrefsSave();
        renderContactsForCurrentQuery();
    });
    btn.dataset.bound = '1';
}

function updateSortLabel() {
    const label = document.getElementById('contactsSortLabel');
    if (!label) return;
    if (contactsSortMode === 'recent') label.textContent = 'Met';
    else if (contactsSortMode === 'age') label.textContent = 'Known';
    else if (contactsSortMode === 'trust') label.textContent = 'Trust';
    else label.textContent = 'Custom';
}

function getCustomOrderKey() {
    return `fairshare_contact_order_${currentUser ? currentUser.id : 'anon'}`;
}

function loadCustomOrder() {
    try {
        return JSON.parse(localStorage.getItem(getCustomOrderKey()) || '[]');
    } catch (_) {
        return [];
    }
}

function saveCustomOrder(ids) {
    try {
        localStorage.setItem(getCustomOrderKey(), JSON.stringify(ids));
    } catch (_) { /* storage full or unavailable */ }
    scheduleSortPrefsSave();
}

let _sortSaveTimer = null;
function scheduleSortPrefsSave() {
    if (_sortSaveTimer) clearTimeout(_sortSaveTimer);
    _sortSaveTimer = setTimeout(async () => {
        _sortSaveTimer = null;
        if (!currentUser) return;
        const order = contactsSortMode === 'custom' ? loadCustomOrder() : null;
        try {
            await db.from('profiles')
                .update({ contacts_sort_mode: contactsSortMode, contacts_sort_order: order })
                .eq('id', currentUser.id);
        } catch (e) {
            console.error('Failed to save sort preferences:', e);
        }
    }, 1500);
}

function initContactsSortPrefs() {
    if (!currentProfile) return;
    const mode = currentProfile.contacts_sort_mode;
    if (mode === 'recent' || mode === 'age' || mode === 'trust' || mode === 'custom') {
        contactsSortMode = mode;
    }
    // Seed localStorage from DB value so the order is available instantly on next render
    if (mode === 'custom' && Array.isArray(currentProfile.contacts_sort_order)) {
        try {
            localStorage.setItem(getCustomOrderKey(), JSON.stringify(currentProfile.contacts_sort_order));
        } catch (_) { /* storage full */ }
    }
    updateSortLabel();
}

function sortContactRows(rows) {
    if (contactsSortMode === 'recent') {
        return rows.slice().sort((a, b) => {
            const aDate = a.contact.met_at || '';
            const bDate = b.contact.met_at || '';
            return (bDate || '0').localeCompare(aDate || '0');
        });
    }
    if (contactsSortMode === 'age') {
        return rows.slice().sort((a, b) => {
            const aDate = a.contact.first_met_at || a.contact.created_at || a.contact.met_at || '';
            const bDate = b.contact.first_met_at || b.contact.created_at || b.contact.met_at || '';
            return (aDate || '9').localeCompare(bDate || '9');
        });
    }
    if (contactsSortMode === 'trust') {
        return rows.slice().sort((a, b) => {
            const aScore = Number(a.contact.trust_score) || 0;
            const bScore = Number(b.contact.trust_score) || 0;
            return bScore - aScore;
        });
    }
    if (contactsSortMode === 'custom') {
        const order = loadCustomOrder();
        if (order.length === 0) return rows;
        const indexMap = {};
        order.forEach((id, i) => { indexMap[id] = i; });
        return rows.slice().sort((a, b) => {
            const ai = indexMap[a.contact.contact_id];
            const bi = indexMap[b.contact.contact_id];
            const aPos = ai !== undefined ? ai : order.length;
            const bPos = bi !== undefined ? bi : order.length;
            return aPos - bPos;
        });
    }
    return rows.slice();
}

function getNoContactsHtml() {
    return '<p style="color:var(--dark-gray);text-align:center;padding:2rem;">No contacts yet. Use the handshake icon to add someone.</p>';
}

function getNoMatchingContactsHtml() {
    return '<p style="color:var(--dark-gray);text-align:center;padding:2rem;">No matching contacts.</p>';
}

async function openContactListScreen() {
    if (!currentUser) return;
    navigateTo('contacts');
}

function getContactRow(contactId) {
    if (!contactId) return null;
    return Array.from(document.querySelectorAll('.contact-row')).find((el) => el.dataset.contactId === contactId) || null;
}

function expandContactRow(contactId) {
    // Legacy entry point: now navigates to the dedicated Contact Details screen
    // instead of inline-expanding the row in the contacts list.
    if (!contactId) return false;
    navigateTo('contactDetails', contactId);
    return true;
}

function updateContactSelfieInList(contactId, selfieUrl) {
    // Legacy helper kept for compatibility; now delegates to strip reload
    delete contactSelfiesCache[contactId];
    reloadContactSelfiesStrip(contactId);
    // Also refresh the new full-page Contact Details carousel if it's open
    // for this contact (the legacy strip is usually absent there).
    if (typeof cdRefreshSelfiesIfOpen === 'function') {
        cdRefreshSelfiesIfOpen(contactId);
    }
    return true;
}

// Patch a contact's avatar in the contacts list (both the collapsed row avatar
// and the expanded detail photo) when we learn their picture changed via
// Realtime. `cacheBust` is an optional token (e.g. notification timestamp) used
// to defeat HTTP caching when the public URL is reused for a replaced file.
function updateContactAvatarInList(contactId, avatarUrl, cacheBust) {
    if (!contactId) return;
    const row = (contactsLoadedRows || []).find(r => r.contact?.contact_id === contactId);
    if (row) {
        if (!row.profile) row.profile = {};
        row.profile.profile_image_url = avatarUrl || null;
    }
    const displayUrl = avatarUrl ? withImageCacheBust(avatarUrl, cacheBust) : null;
    const name = row?.profile?.display_name || 'Unknown';
    const cid = esc(contactId);

    const rowEl = document.querySelector(`.contact-row[data-contact-id="${contactId}"]`);
    if (!rowEl) return;

    // Row header avatar (img or placeholder div)
    const rowAvatar = rowEl.querySelector('.contact-row-avatar, .contact-row-avatar-placeholder');
    if (rowAvatar) {
        if (displayUrl) {
            if (rowAvatar.tagName === 'IMG') {
                rowAvatar.src = displayUrl;
            } else {
                const img = document.createElement('img');
                img.className = 'contact-row-avatar';
                img.src = displayUrl;
                img.alt = '';
                rowAvatar.replaceWith(img);
            }
        } else if (rowAvatar.tagName === 'IMG') {
            const placeholder = document.createElement('div');
            placeholder.className = 'contact-row-avatar-placeholder';
            placeholder.textContent = '\u{1F464}';
            rowAvatar.replaceWith(placeholder);
        }
    }

    // Expanded detail photo
    const detailMedia = rowEl.querySelector('.contact-detail-profile-media');
    if (detailMedia) {
        if (displayUrl) {
            detailMedia.innerHTML = `<img class="contact-detail-profile-photo" src="${esc(displayUrl)}" alt="${esc(name)} profile"
                style="cursor:pointer"
                onclick="event.stopPropagation(); openLightbox('${esc(displayUrl)}')">`;
        } else {
            detailMedia.innerHTML = `<div class="contact-detail-profile-placeholder" style="cursor:pointer"
                onclick="event.stopPropagation(); openSuggestPicture('${cid}')">\u{1F464}</div>`;
        }
    }
}

// Patch display name in the contacts list row when we learn it changed (Realtime).
function updateContactDisplayNameInList(contactId, displayName) {
    if (!contactId) return;
    const safeName = displayName || 'Unknown';
    const row = (contactsLoadedRows || []).find(r => r.contact?.contact_id === contactId);
    if (row) {
        if (!row.profile) row.profile = {};
        row.profile.display_name = safeName;
    }
    const rowEl = document.querySelector(`.contact-row[data-contact-id="${contactId}"]`);
    if (!rowEl) return;
    const nameEl = rowEl.querySelector('.contact-row-name-text');
    if (nameEl) nameEl.textContent = safeName;
    rowEl.querySelectorAll('.btn-share-with-contact[data-contact-id], .btn-vouch-with-contact[data-contact-id]').forEach((btn) => {
        btn.setAttribute('data-contact-name', safeName);
    });
    const detailPhoto = rowEl.querySelector('.contact-detail-profile-photo');
    if (detailPhoto) detailPhoto.setAttribute('alt', safeName + ' profile');
}

async function loadContactSelfies(contactId) {
    if (contactSelfiesCache[contactId]) return contactSelfiesCache[contactId];
    try {
        const { data, error } = await db
            .from('contact_selfies')
            .select('id, selfie_url, captured_at, location_label')
            .eq('contact_id', contactId)
            .order('captured_at', { ascending: false });
        if (error) throw error;
        contactSelfiesCache[contactId] = data || [];
    } catch (e) {
        console.error('loadContactSelfies error:', e);
        contactSelfiesCache[contactId] = [];
    }
    return contactSelfiesCache[contactId];
}

function formatSelfieDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function buildSelfiesStripHtml(selfies, contactId) {
    const addTileHtml = `
        <div class="selfie-tile selfie-tile-add" onclick="event.stopPropagation();openContactSelfie('${contactId}')" title="Add a selfie">
            <div class="selfie-tile-add-icon"><i data-lucide="image-plus" aria-hidden="true"></i></div>
        </div>`;
    if (!selfies || selfies.length === 0) {
        return `<div class="selfies-strip">${addTileHtml}</div>`;
    }
    const tilesHtml = selfies.map(s => {
        const dateStr = formatSelfieDate(s.captured_at);
        const locStr = s.location_label || '';
        const caption = [dateStr, locStr].filter(Boolean).join('\n');
        return `
            <div class="selfie-tile"
                 data-lightbox-url="${esc(s.selfie_url)}"
                 ${dateStr ? `data-lightbox-date="${esc(dateStr)}"` : ''}
                 ${locStr ? `data-lightbox-location="${esc(locStr)}"` : ''}>
                <img src="${esc(s.selfie_url)}" alt="Selfie" loading="lazy"
                     onload="if(this.naturalWidth>this.naturalHeight){var t=this.closest('.selfie-tile'),w=Math.round(110*this.naturalWidth/this.naturalHeight);t.style.flex='0 0 '+w+'px';this.style.width=w+'px';}">
                ${caption ? `<div class="selfie-caption">${esc(dateStr)}${locStr ? `<br><span class="selfie-caption-location">${esc(locStr)}</span>` : ''}</div>` : ''}
            </div>`;
    }).join('');
    // Add tile at both ends: left is revealed by swiping right, right is always visible
    return `<div class="selfies-strip">${addTileHtml}${tilesHtml}${addTileHtml}</div>`;
}

// Enable smooth click-drag scrolling on desktop for a selfies strip element
function attachSelfiesStripDragScroll(strip) {
    let isDown = false;
    let startX = 0;
    let scrollStart = 0;
    let moved = false;

    strip.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        isDown = true;
        moved = false;
        startX = e.pageX;
        scrollStart = strip.scrollLeft;
        strip.style.cursor = 'grabbing';
        // Disable scroll-snap during drag so movement is pixel-smooth
        strip.style.scrollSnapType = 'none';
        e.preventDefault();
    });

    const endDrag = () => {
        if (!isDown) return;
        isDown = false;
        strip.style.cursor = '';
        // Re-enable scroll-snap so touch/release snaps to a tile
        strip.style.scrollSnapType = '';
    };

    strip.addEventListener('mousemove', (e) => {
        if (!isDown) return;
        const dx = e.pageX - startX;
        if (Math.abs(dx) > 4) moved = true;
        strip.scrollLeft = scrollStart - dx;
    });

    strip.addEventListener('mouseup', endDrag);
    strip.addEventListener('mouseleave', endDrag);

    // Block clicks on child elements when the gesture was a drag, not a tap
    strip.addEventListener('click', (e) => {
        if (moved) {
            e.stopPropagation();
            e.preventDefault();
        }
    }, true);
}

function ensureLightbox() {
    if (document.getElementById('img-lightbox')) return;
    const el = document.createElement('div');
    el.id = 'img-lightbox';
    el.className = 'img-lightbox';
    el.innerHTML = `
        <button class="img-lightbox-close" aria-label="Close"><i data-lucide="x" aria-hidden="true"></i></button>
        <img class="img-lightbox-img" id="img-lightbox-img" alt="">
        <div class="img-lightbox-caption" id="img-lightbox-caption"></div>
        <div class="img-lightbox-actions" id="img-lightbox-actions"></div>`;
    el.addEventListener('click', (e) => {
        if (
            !e.target.closest('.img-lightbox-img')
            && !e.target.closest('.img-lightbox-caption')
            && !e.target.closest('.img-lightbox-actions')
        ) {
            closeLightbox();
        }
    });
    el.querySelector('.img-lightbox-close').addEventListener('click', closeLightbox);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });
    document.body.appendChild(el);
    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
}

// openLightbox(url, dateStr?, locationStr?, actions?)
//   actions: optional array of { label, onClick, variant? } to render as buttons
//   under the caption. Used e.g. by Contact Details to surface "Suggest a new
//   profile picture" when viewing a contact's avatar.
function openLightbox(url, dateStr, locationStr, actions) {
    ensureLightbox();
    document.getElementById('img-lightbox-img').src = url;
    const cap = document.getElementById('img-lightbox-caption');
    const parts = [dateStr, locationStr].filter(Boolean);
    cap.innerHTML = parts.map(p => `<span>${esc(p)}</span>`).join('<br>');
    cap.style.display = parts.length ? '' : 'none';

    const actionsEl = document.getElementById('img-lightbox-actions');
    if (actionsEl) {
        actionsEl.innerHTML = '';
        const list = Array.isArray(actions) ? actions : [];
        if (list.length === 0) {
            actionsEl.style.display = 'none';
        } else {
            actionsEl.style.display = '';
            list.forEach((action) => {
                if (!action || typeof action.onClick !== 'function') return;
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'img-lightbox-action-btn'
                    + (action.variant ? ' img-lightbox-action-' + action.variant : '');
                btn.textContent = action.label || 'Action';
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    try { action.onClick(); } catch (err) { console.error(err); }
                });
                actionsEl.appendChild(btn);
            });
        }
    }

    document.getElementById('img-lightbox').classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeLightbox() {
    const lb = document.getElementById('img-lightbox');
    if (lb) lb.classList.remove('active');
    document.body.style.overflow = '';
}

async function reloadContactSelfiesStrip(contactId) {
    const container = document.getElementById('selfies-strip-' + contactId);
    if (!container) return;
    const selfies = await loadContactSelfies(contactId);
    container.innerHTML = buildSelfiesStripHtml(selfies, contactId);
    const strip = container.querySelector('.selfies-strip');
    if (strip) {
        attachSelfiesStripDragScroll(strip);
        // When there are existing selfies the add tile is at the far left; start
        // scrolled past it so users discover it by swiping right.
        if (selfies && selfies.length > 0) {
            strip.scrollLeft = 118; // 110px tile + ~8px gap — hides left add tile initially
        }
    }
}

function matchesContactSearch(row) {
    if (!contactsSearchQuery) return true;
    const name = (row.profile?.display_name || '').toLowerCase();
    const profileEmail = (row.profile?.email || '').toLowerCase();
    const profilePhone = (row.profile?.phone || '').toLowerCase();
    const sharedEmail = (row.shared?.shared_email || '').toLowerCase();
    const sharedPhone = (row.shared?.shared_phone || '').toLowerCase();
    return (
        name.includes(contactsSearchQuery)
        || profileEmail.includes(contactsSearchQuery)
        || profilePhone.includes(contactsSearchQuery)
        || sharedEmail.includes(contactsSearchQuery)
        || sharedPhone.includes(contactsSearchQuery)
    );
}

function bindContactRowEvents(content) {
    content.querySelectorAll('.contact-row').forEach((row) => {
        row.addEventListener('click', (e) => {
            if (_dragJustEnded) return;
            // Tapping a row navigates to the redesigned Contact Details screen.
            // The legacy inline-expand markup remains in the DOM but is no longer
            // toggled from this click handler (kept only for the drag-sort ghost).
            if (e.target.closest('input') || e.target.closest('button') || e.target.closest('a')) return;
            const cid = row.dataset.contactId;
            if (cid) navigateTo('contactDetails', cid);
        });
    });
}

function bindContactActionEvents(content) {
    if (content.dataset.contactActionBound) return;
    content.addEventListener('click', (e) => {
        const selfieTile = e.target.closest('.selfie-tile[data-lightbox-url]');
        if (selfieTile) {
            e.stopPropagation();
            openLightbox(
                selfieTile.dataset.lightboxUrl,
                selfieTile.dataset.lightboxDate || '',
                selfieTile.dataset.lightboxLocation || ''
            );
            return;
        }
        const shareBtn = e.target.closest('.btn-share-with-contact');
        if (shareBtn) {
            e.stopPropagation();
            openShareWithContact(shareBtn.dataset.contactId || '', shareBtn.dataset.contactName || 'contact');
            return;
        }
        const vouchBtn = e.target.closest('.btn-vouch-with-contact');
        if (vouchBtn) {
            e.stopPropagation();
            openVouchWithContact(vouchBtn.dataset.contactId || '', vouchBtn.dataset.contactName || 'contact');
        }
    });
    content.dataset.contactActionBound = '1';
}

function renderContactRows(rows) {
    const content = document.getElementById('contactsListContent');
    if (!content) return;
    content.innerHTML = rows.map(({ contact, profile, shared }) => (
        renderContactRow(contact, profile, shared)
    )).join('');
    bindContactRowEvents(content);
    bindContactActionEvents(content);
    bindContactDragSort(content);
    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
}

function renderContactsForCurrentQuery() {
    const content = document.getElementById('contactsListContent');
    if (!content) return;

    if (!contactsLoadedRows.length) {
        content.innerHTML = getNoContactsHtml();
        if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
        return;
    }

    const filteredRows = contactsLoadedRows.filter(matchesContactSearch);
    if (!filteredRows.length) {
        content.innerHTML = getNoMatchingContactsHtml();
        if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
        return;
    }

    renderContactRows(sortContactRows(filteredRows));
}

async function openContactDetailsById(contactId) {
    if (!contactId || !currentUser) return false;
    // Make sure the contacts list is loaded so contactsLoadedRows has the row
    // when the detail screen reads it. The list itself stays mounted but hidden.
    if (!contactsLoadedRows || contactsLoadedRows.length === 0) {
        await loadAndRenderContactList();
    }
    navigateTo('contactDetails', contactId);
    return true;
}

async function openNewestContactDetails() {
    if (!currentUser) return false;
    if (!contactsLoadedRows || contactsLoadedRows.length === 0) {
        await loadAndRenderContactList();
    }
    const firstRow = document.querySelector('.contact-row');
    const contactId = firstRow?.dataset?.contactId
        || contactsLoadedRows?.[0]?.contact?.contact_id
        || '';
    if (!contactId) return false;
    navigateTo('contactDetails', contactId);
    return true;
}

async function openPendingContactDetailsIfAny() {
    if (pendingContactIntroId) {
        const iid = pendingContactIntroId;
        pendingContactIntroId = null;
        if (typeof showContactIntroDialog === 'function') {
            await showContactIntroDialog(iid);
        }
    }
    if (pendingOpenContactId) {
        const cid = pendingOpenContactId;
        pendingOpenContactId = null;
        await openContactDetailsById(cid);
        return;
    }
    if (pendingOpenNewestContact) {
        pendingOpenNewestContact = false;
        await openNewestContactDetails();
    }
}

// After claiming a meet handshake link (new account), mirror the QR-scanner flow:
// full-screen selfie prompt first; skip/capture then opens the sponsor's details.
async function openPostHandshakeSelfieIfPending() {
    if (!pendingPostHandshakeSelfieContactId || !currentUser) return;
    const cid = pendingPostHandshakeSelfieContactId;
    const name = pendingPostHandshakeSelfieContactName || 'your new contact';
    pendingPostHandshakeSelfieContactId = null;
    pendingPostHandshakeSelfieContactName = null;
    await openNewContactSelfieOverlay(cid, name);
}

function closeContactListScreen() {
    clearContactSearchState();
}

async function loadAndRenderContactList() {
    const content = document.getElementById('contactsListContent');
    try {
        if (typeof loadDemoAccountsSetting === 'function') {
            await loadDemoAccountsSetting();
        }
        const { data: contacts, error } = await db
            .from('contacts')
            .select('*')
            .eq('user_id', currentUser.id)
            .order('met_at', { ascending: false });

        if (error) throw error;

        // Strip out any blocked users locally so they never appear in the
        // list, even if the server momentarily races a delete with a fresh
        // contact insert. block_user() also clears the contacts row, so
        // this is just a belt-and-suspenders filter.
        const visibleContacts = (contacts || []).filter(c => {
            if (typeof isUserBlocked === 'function' && isUserBlocked(c.contact_id)) return false;
            if (!demoAccountsVisible && typeof isDemoContact === 'function' && isDemoContact(c.contact_id)) return false;
            return true;
        });

        if (visibleContacts.length === 0) {
            contactsLoadedRows = [];
            content.innerHTML = getNoContactsHtml();
            if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
            return;
        }

        const contactIds = [...new Set(visibleContacts.map(c => c.contact_id))];
        let profileMap = {};
        if (contactIds.length > 0) {
            const { data: profiles } = await db.from('profiles').select('id, display_name, profile_image_url, phone, email, sponsor_id, created_at').in('id', contactIds);
            if (profiles) profiles.forEach(p => { profileMap[p.id] = p; });
        }

        let sharedByThemMap = {};
        let sharedByMeMap = {};
        try {
            const { data: sharedRows } = await db.from('contact_shared').select('user_id, shared_phone, shared_email').eq('contact_id', currentUser.id).in('user_id', contactIds);
            if (sharedRows) sharedRows.forEach(r => { sharedByThemMap[r.user_id] = r; });
        } catch (_) { /* contact_shared table may not exist yet */ }
        try {
            const { data: outRows } = await db.from('contact_shared').select('contact_id, shared_phone, shared_email').eq('user_id', currentUser.id).in('contact_id', contactIds);
            if (outRows) outRows.forEach(r => { sharedByMeMap[r.contact_id] = r; });
        } catch (_) { /* contact_shared table may not exist yet */ }

        try { await loadLocationShares(); } catch (_) { /* location_shares table may not exist yet */ }
        try { await loadContactLocations(); } catch (_) { /* user_locations may not exist yet */ }

        contactsLoadedRows = visibleContacts.map((contact) => ({
            contact,
            profile: profileMap[contact.contact_id] || {},
            shared: sharedByThemMap[contact.contact_id] || {},
            sharedByMe: sharedByMeMap[contact.contact_id] || {}
        }));

        if (contactsSortMode === 'custom') {
            const order = loadCustomOrder();
            const orderSet = new Set(order);
            const newIds = contactsLoadedRows
                .map(r => r.contact.contact_id)
                .filter(id => !orderSet.has(id));
            if (newIds.length > 0) {
                saveCustomOrder([...newIds, ...order]);
            }
        }

        renderContactsForCurrentQuery();
    } catch (e) {
        console.error('Load contacts error:', e);
        contactsLoadedRows = [];
        content.innerHTML = '<p style="color:var(--red);text-align:center;padding:2rem;">Failed to load contacts.</p>';
        if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
    }
}

function formatLastSeen(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / APP_TIMING.MINUTE_MS);
    if (diffMin < 1) return 'Just now';
    if (diffMin < 60) return diffMin + 'm ago';
    const diffHrs = Math.floor(diffMin / 60);
    if (diffHrs < 24) return diffHrs + 'h ago';
    const diffDays = Math.floor(diffHrs / 24);
    if (diffDays < 30) return diffDays + 'd ago';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

function formatFirstMetDisplay(isoStr) {
    if (!isoStr) return 'tap to set';
    const d = new Date(isoStr);
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}


function formatKnownDuration(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const now = new Date();
    let years = now.getFullYear() - d.getFullYear();
    let months = now.getMonth() - d.getMonth();
    if (months < 0) { years--; months += 12; }
    if (years * 12 + months < 1) return '';
    const parts = [];
    if (years > 0) parts.push(years === 1 ? '1 year' : `${years} years`);
    if (months > 0) parts.push(months === 1 ? '1 month' : `${months} months`);
    return parts.join(', ');
}

// iOS' wheel-style <input type="date"> picker fires `change` on every spin
// of the wheel. The underlying RPC (`set_first_met_date`) sends a push
// notification to the contact, so committing on every tick would spam them.
// Strategy: while the picker is open we only mirror the change in the local
// UI. The actual RPC fires once on blur (picker dismiss) and only when the
// value actually changed from what it was before the picker opened.
const _firstMetEdits = {};

function _writeFirstMetAt(contactId, isoDate) {
    return db.rpc('set_first_met_date', {
        p_contact_id: contactId,
        p_met_date: isoDate
    }).then(({ error }) => {
        if (error) throw error;
        updateContactMetDate(contactId, isoDate);
    }).catch((e) => {
        console.error('Failed to save first met date:', e);
    });
}

function saveFirstMetAt(contactId, dateValue) {
    if (!currentUser) return;
    const isoDate = dateValue ? new Date(dateValue + 'T12:00:00').toISOString() : null;

    // First change since the picker opened: capture the original value so we
    // can decide on blur whether anything actually changed.
    if (!_firstMetEdits[contactId]) {
        const row = contactsLoadedRows.find(r => r.contact?.contact_id === contactId);
        const original = row?.contact?.first_met_at || null;
        _firstMetEdits[contactId] = { originalIsoDate: original, pendingIsoDate: isoDate };
    } else {
        _firstMetEdits[contactId].pendingIsoDate = isoDate;
    }

    // Reflect the chosen date in the local UI right away so the change feels
    // instant; the server (and the contact's notification) waits for blur.
    updateContactMetDate(contactId, isoDate);
}

// Commit on picker dismiss: write to the server only if the value actually
// changed from what it was when the picker opened.
function commitPendingFirstMetAt(contactId) {
    const edit = _firstMetEdits[contactId];
    if (!edit) return;
    delete _firstMetEdits[contactId];
    if (edit.pendingIsoDate === edit.originalIsoDate) return;
    _writeFirstMetAt(contactId, edit.pendingIsoDate);
}

function updateContactMetDate(contactId, isoDate) {
    const row = contactsLoadedRows.find(r => r.contact.contact_id === contactId);
    if (row) {
        row.contact.first_met_at = isoDate;
        const rowEl = document.querySelector(`.contact-row[data-contact-id="${contactId}"]`);
        if (rowEl) {
            const durationEl = rowEl.querySelector('.contact-row-known-duration');
            const newDuration = formatKnownDuration(isoDate || row.contact.created_at);
            if (durationEl) {
                durationEl.textContent = newDuration;
                durationEl.style.display = newDuration ? '' : 'none';
            }
            const displayEl = rowEl.querySelector(`#met-on-display-${contactId}`);
            if (displayEl) displayEl.textContent = formatFirstMetDisplay(isoDate);
            const inputEl = rowEl.querySelector(`#met-on-${contactId}`);
            if (inputEl) inputEl.value = isoDate ? new Date(isoDate).toISOString().slice(0, 10) : '';
        }
    }
    // Also patch the contact-details screen if it's currently showing this contact,
    // so a date change pushed from the other party (or from another tab) appears
    // immediately without requiring the user to back out and re-open the screen.
    if (typeof cdCurrentContactId !== 'undefined' && cdCurrentContactId === contactId) {
        const knownDisp = document.getElementById('cd-hero-known-display');
        if (knownDisp && row) {
            const since = isoDate || row.contact.created_at || null;
            const dur = formatKnownDuration(since);
            knownDisp.textContent = dur ? `Known ${dur}` : 'Known';
        }
        const input = document.getElementById('cd-met-input');
        if (input) input.value = isoDate ? new Date(isoDate).toISOString().slice(0, 10) : '';
    }
}

function bindContactDragSort(content) {
    if (!content || content.dataset.dragBound === '1') return;
    content.dataset.dragBound = '1';

    const HOLD_MS = 500;
    const MOVE_THRESHOLD = 12;
    const SCROLL_ZONE = 80;   // px from viewport edge to trigger scroll
    const SCROLL_MAX = 18;    // max px per frame

    let holdTimer = null;
    let dragActive = false;
    let sourceRow = null;
    let ghost = null;
    let indicator = null;
    let pointerStartX = 0;
    let pointerStartY = 0;
    let ghostOffsetY = 0; // fixed: pointer Y minus ghost top, computed once at drag start
    let insertBeforeId = null; // contact_id of the row we'd insert before (null = append)
    let lastPointerY = 0;
    let scrollRAF = null;

    function _preventTouchScroll(e) { e.preventDefault(); }

    function cancelHold() {
        if (holdTimer !== null) { clearTimeout(holdTimer); holdTimer = null; }
    }

    function stopEdgeScroll() {
        if (scrollRAF !== null) { cancelAnimationFrame(scrollRAF); scrollRAF = null; }
    }

    function tickEdgeScroll() {
        scrollRAF = null;
        if (!dragActive) return;
        const vh = window.innerHeight;
        let speed = 0;
        if (lastPointerY < SCROLL_ZONE) {
            speed = -SCROLL_MAX * (1 - lastPointerY / SCROLL_ZONE);
        } else if (lastPointerY > vh - SCROLL_ZONE) {
            speed = SCROLL_MAX * (1 - (vh - lastPointerY) / SCROLL_ZONE);
        }
        if (speed !== 0) {
            window.scrollBy(0, speed);
            updateIndicator(lastPointerY);
            scrollRAF = requestAnimationFrame(tickEdgeScroll);
        }
    }

    function scheduleEdgeScroll(clientY) {
        lastPointerY = clientY;
        const vh = window.innerHeight;
        const inZone = clientY < SCROLL_ZONE || clientY > vh - SCROLL_ZONE;
        if (inZone && scrollRAF === null) {
            scrollRAF = requestAnimationFrame(tickEdgeScroll);
        } else if (!inZone) {
            stopEdgeScroll();
        }
    }

    function startDrag(row, clientX, clientY) {
        dragActive = true;
        sourceRow = row;

        // iOS may have selected text during the hold period; clear it before drag begins.
        window.getSelection()?.removeAllRanges();

        // On iOS, pointer events fire pointercancel as soon as the finger moves even a
        // little, because the browser interprets movement as a scroll gesture and takes
        // over the touch.  The only reliable way to stop this mid-gesture is a
        // non-passive touchmove listener that calls preventDefault(), which tells the
        // browser "this touch is mine, don't scroll."
        document.addEventListener('touchmove', _preventTouchScroll, { passive: false });

        // Ghost clone
        const rect = row.getBoundingClientRect();
        ghost = row.cloneNode(true);
        ghost.className = 'contact-drag-ghost';
        ghost.style.width = rect.width + 'px';
        ghost.style.left = rect.left + 'px';
        document.body.appendChild(ghost);

        // Compute fixed offset once so ghost stays locked to cursor regardless of page scroll
        ghostOffsetY = clientY - rect.top;
        ghost.style.top = (clientY - ghostOffsetY) + 'px';

        // Drag indicator
        indicator = document.createElement('div');
        indicator.className = 'contact-drag-indicator';
        content.style.position = 'relative';
        content.appendChild(indicator);

        row.classList.add('dragging');
        document.body.classList.add('drag-sort-active');
        updateIndicator(clientY);
    }

    function moveGhostTo(clientY) {
        if (!ghost) return;
        ghost.style.top = (clientY - ghostOffsetY) + 'px';
    }

    function getRowsExcludingSource() {
        return Array.from(content.querySelectorAll('.contact-row:not(.dragging)'));
    }

    function updateIndicator(clientY) {
        if (!indicator) return;
        const rows = getRowsExcludingSource();
        if (rows.length === 0) {
            indicator.style.display = 'none';
            insertBeforeId = null;
            return;
        }

        // Find the gap closest to clientY
        const contentRect = content.getBoundingClientRect();
        let bestY = null;
        insertBeforeId = null;

        for (let i = 0; i <= rows.length; i++) {
            let gapY;
            if (i === 0) {
                gapY = rows[0].getBoundingClientRect().top;
            } else if (i === rows.length) {
                const lastRect = rows[rows.length - 1].getBoundingClientRect();
                gapY = lastRect.bottom;
            } else {
                const above = rows[i - 1].getBoundingClientRect();
                const below = rows[i].getBoundingClientRect();
                gapY = (above.bottom + below.top) / 2;
            }

            if (bestY === null || Math.abs(clientY - gapY) < Math.abs(clientY - bestY)) {
                bestY = gapY;
                insertBeforeId = i < rows.length ? rows[i].dataset.contactId : null;
            }
        }

        const indicatorTop = (bestY - contentRect.top) - 1.5;
        indicator.style.top = indicatorTop + 'px';
        indicator.style.display = 'block';
    }

    function endDrag(cancelled) {
        cancelHold();
        stopEdgeScroll();
        document.removeEventListener('touchmove', _preventTouchScroll);
        if (!dragActive) return;
        dragActive = false;

        if (ghost) { ghost.remove(); ghost = null; }
        if (indicator) { indicator.remove(); indicator = null; }
        if (sourceRow) sourceRow.classList.remove('dragging');
        document.body.classList.remove('drag-sort-active');

        if (!cancelled && sourceRow) {
            const sourceId = sourceRow.dataset.contactId;

            // Compute the new order from the DISPLAYED custom order, not from
            // contactsLoadedRows (which is in DB met_at order, not custom order).
            const displayedIds = sortContactRows(contactsLoadedRows).map(r => r.contact.contact_id);
            const srcIndex = displayedIds.indexOf(sourceId);
            if (srcIndex !== -1) {
                displayedIds.splice(srcIndex, 1);
                if (insertBeforeId) {
                    const targetIndex = displayedIds.indexOf(insertBeforeId);
                    displayedIds.splice(targetIndex !== -1 ? targetIndex : displayedIds.length, 0, sourceId);
                } else {
                    displayedIds.push(sourceId);
                }
            }
            saveCustomOrder(displayedIds);

            // Signal to suppress the next click event on any row
            _dragJustEnded = true;
            setTimeout(() => { _dragJustEnded = false; }, 100);

            renderContactsForCurrentQuery();
        }

        sourceRow = null;
        insertBeforeId = null;
    }

    // --- Event listeners ---

    content.addEventListener('pointerdown', (e) => {
        const row = e.target.closest('.contact-row');
        if (!row) return;
        // Don't initiate drag from interactive elements
        if (e.target.closest('button, input, a, .selfies-strip-container')) return;

        pointerStartX = e.clientX;
        pointerStartY = e.clientY;

        holdTimer = setTimeout(() => {
            holdTimer = null;
            const contactId = row.dataset.contactId;

            // Switch to Custom before drag begins so the list re-renders into custom order
            // first — the user can then see exactly where they're placing the card.
            if (contactsSortMode !== 'custom') {
                const prevSortedIds = sortContactRows(contactsLoadedRows).map(r => r.contact.contact_id);
                contactsSortMode = 'custom';
                updateSortLabel();
                const stored = loadCustomOrder();
                const storedSet = new Set(stored);
                const newIds = prevSortedIds.filter(id => !storedSet.has(id));
                saveCustomOrder([...stored.filter(id => prevSortedIds.includes(id)), ...newIds]);
                scheduleSortPrefsSave();
                renderContactsForCurrentQuery();
            }

            // After a possible re-render the original `row` reference may be stale; re-find it.
            const targetRow = content.querySelector(`.contact-row[data-contact-id="${CSS.escape(contactId)}"]`);
            if (!targetRow) return;

            // If the list re-rendered, the card may now be at a different scroll position.
            // Scroll the page so the card sits under the cursor before we lock in ghostOffsetY.
            const targetRect = targetRow.getBoundingClientRect();
            const HOLD_POINT = 25; // natural hold point: ~25px from top of card header
            window.scrollBy(0, targetRect.top - e.clientY + HOLD_POINT);

            targetRow.setPointerCapture(e.pointerId);
            startDrag(targetRow, e.clientX, e.clientY);
        }, HOLD_MS);
    });

    content.addEventListener('pointermove', (e) => {
        if (!dragActive) {
            // Cancel hold if pointer moved too far
            if (holdTimer !== null) {
                const dx = e.clientX - pointerStartX;
                const dy = e.clientY - pointerStartY;
                if (Math.hypot(dx, dy) > MOVE_THRESHOLD) cancelHold();
            }
            return;
        }
        moveGhostTo(e.clientY);
        updateIndicator(e.clientY);
        scheduleEdgeScroll(e.clientY);
    });

    content.addEventListener('pointerup', (e) => {
        cancelHold();
        if (dragActive) endDrag(false);
    });

    content.addEventListener('pointercancel', (e) => {
        cancelHold();
        if (dragActive) endDrag(true);
    });
}

// Maps a raw (weighted, time-decayed) trust score onto the absolute 0..100
// scale used everywhere in the UI: 100 * (1 - 2^(-raw / half)). Mirrors the
// formula in get_contact_trust_summary (sql/contact-details-schema.sql);
// keep TRUST_SCORE_HALF_RAW in sync with c_score_half_raw there.
const TRUST_SCORE_HALF_RAW = 4.0;
function trustScoreFromRaw(raw) {
    const r = Math.max(0, Number(raw) || 0);
    const score = Math.round(100 * (1 - Math.pow(2, -r / TRUST_SCORE_HALF_RAW)));
    return Math.max(0, Math.min(100, score));
}

// Right-edge content for a contact row depends on the active sort mode so the
// data the user is sorting by is always visible. Trust mode maps the raw
// stored score onto the same absolute 0..100 scale the details ring uses,
// so the list and the Contact Details screen always agree.
function renderContactRowRightEdge(contact, knownDuration, lastSeen) {
    if (contactsSortMode === 'age') {
        return knownDuration
            ? `<span class="contact-row-known">${esc(knownDuration)}</span>`
            : '';
    }
    if (contactsSortMode === 'trust') {
        const score = trustScoreFromRaw(contact.trust_score);
        const r = 14;
        const c = 2 * Math.PI * r;
        const offset = c - (score / 100) * c;
        return `
            <span class="contact-row-trust" aria-label="Trust ${score} of 100">
                <svg viewBox="0 0 32 32" width="32" height="32" class="contact-row-trust-svg" aria-hidden="true">
                    <circle cx="16" cy="16" r="${r}" stroke="rgba(0,0,0,0.08)" stroke-width="3" fill="none"/>
                    <circle cx="16" cy="16" r="${r}" stroke="#E3AD4F" stroke-width="3" fill="none"
                        stroke-linecap="round"
                        stroke-dasharray="${c.toFixed(2)}"
                        stroke-dashoffset="${offset.toFixed(2)}"
                        transform="rotate(-90 16 16)"/>
                </svg>
                <span class="contact-row-trust-num">${score}</span>
            </span>`;
    }
    return lastSeen ? `<span class="contact-row-lastseen">${esc(lastSeen)}</span>` : '';
}

function renderContactRow(contact, profile, shared) {
    const name = profile.display_name || 'Unknown';
    const avatarUrl = profile.profile_image_url || null;
    const phone = (shared.shared_phone != null && shared.shared_phone !== '') ? shared.shared_phone : '';
    const email = (shared.shared_email != null && shared.shared_email !== '') ? shared.shared_email : '';
    const hasSharedPhone = !!phone;
    const hasSharedEmail = !!email;
    const cid = esc(contact.contact_id);
    const lastSeen = formatLastSeen(contact.met_at);
    const knownSinceDateStr = contact.first_met_at || contact.created_at || null;
    const knownDuration = formatKnownDuration(knownSinceDateStr);
    const rightEdgeHtml = renderContactRowRightEdge(contact, knownDuration, lastSeen);
    const firstMetValue = knownSinceDateStr ? new Date(knownSinceDateStr).toISOString().slice(0, 10) : '';
    const firstMetDisplayValue = formatFirstMetDisplay(knownSinceDateStr);
    const avatarHtml = avatarUrl
        ? `<img class="contact-row-avatar" src="${esc(avatarUrl)}" alt="">`
        : '<div class="contact-row-avatar-placeholder"><i data-lucide="user-round" aria-hidden="true"></i></div>';
    const largeAvatarHtml = avatarUrl
        ? `<img class="contact-detail-profile-photo" src="${esc(avatarUrl)}" alt="${esc(name)} profile"
               style="cursor:pointer"
               onclick="event.stopPropagation(); openLightbox('${esc(avatarUrl)}')">`
        : `<div class="contact-detail-profile-placeholder" style="cursor:pointer"
               onclick="event.stopPropagation(); openSuggestPicture('${cid}')"><i data-lucide="user-round" aria-hidden="true"></i></div>`;
    const contactLoc = contactLocationsCache[contact.contact_id];
    const isInboundShare = !!locationSharesInbound[contact.contact_id];
    const hasLocationShare = !!(isInboundShare || locationSharesOutbound[contact.contact_id]);
    const hasAnyIcon = hasSharedPhone || hasSharedEmail || hasLocationShare;
    const sharedIconHtml = hasAnyIcon
        ? `<span class="contact-row-shared-icons" aria-label="Contact details shared with you">
                ${hasLocationShare ? '<span class="contact-row-shared-icon" title="Location shared"><i data-lucide="map-pin" aria-hidden="true"></i></span>' : ''}
                ${hasSharedPhone ? '<span class="contact-row-shared-icon" title="Phone shared"><i data-lucide="phone" aria-hidden="true"></i></span>' : ''}
                ${hasSharedEmail ? '<span class="contact-row-shared-icon contact-row-shared-icon-email" title="Email shared"><i data-lucide="mail" aria-hidden="true"></i></span>' : ''}
            </span>`
        : '';
    return `
        <div class="contact-row" data-contact-id="${cid}">
            <div class="contact-row-header">
                ${avatarHtml}
                <span class="contact-row-name">
                    <span class="contact-row-name-top">
                        <span class="contact-row-name-text">${esc(name)}</span>
                        ${sharedIconHtml}
                    </span>
                </span>
                ${rightEdgeHtml}
            </div>
            <div class="contact-detail">
                <div class="contact-detail-top-row">
                    <div class="contact-detail-profile-col">
                        <div class="contact-detail-profile-media">${largeAvatarHtml}</div>
                        <button type="button" class="btn btn-small btn-suggest-picture" onclick="event.stopPropagation(); openSuggestPicture('${cid}')">Suggest new picture</button>
                    </div>
                    ${isInboundShare && contactLoc ? `<div class="contact-location-mini" onclick="event.stopPropagation(); openContactLocationFullscreen('${cid}', '${esc(name)}')">
                        <div class="contact-location-mini-map" id="contact-loc-map-${cid}"></div>
                        <div class="contact-location-mini-distance" id="contact-loc-dist-${cid}"></div>
                    </div>` : ''}
                    <div class="contact-detail-top-actions">
                        <button type="button" class="btn btn-small btn-vouch-with-contact" data-contact-id="${cid}" data-contact-name="${esc(name)}">Vouch</button>
                        <button type="button" class="btn btn-primary btn-small btn-share-with-contact" data-contact-id="${cid}" data-contact-name="${esc(name)}">Share</button>
                    </div>
                </div>
                <div class="contact-detail-met-on">
                    <span class="contact-detail-met-on-label">We met on</span>
                    <span class="contact-detail-met-on-value">
                        <span class="contact-detail-met-on-display" id="met-on-display-${cid}">${firstMetDisplayValue}</span>
                    </span>
                    <input type="date" class="contact-detail-met-on-input" id="met-on-${cid}"
                        value="${firstMetValue}"
                        onclick="try { this.showPicker(); } catch(e) {}"
                        onchange="event.stopPropagation(); saveFirstMetAt('${cid}', this.value)"
                        onblur="commitPendingFirstMetAt('${cid}')">
                </div>
                <div class="contact-detail-selfies-section">
                    <div class="contact-shared-title">Selfies Together</div>
                    <div id="selfies-strip-${cid}" class="selfies-strip-container">
                        <div class="selfies-strip">
                            <div class="selfie-tile selfie-tile-add" onclick="event.stopPropagation();openContactSelfie('${cid}')" title="Add a selfie">
                                <div class="selfie-tile-add-icon"><i data-lucide="image-plus" aria-hidden="true"></i></div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="contact-mutuals" id="mutuals-${cid}"></div>
                <div class="contact-detail-nearby">
                    <label class="contact-nearby-label">
                        <input type="checkbox" class="contact-nearby-checkbox"
                               data-contact-id="${cid}"
                               ${contact.notify_nearby ? 'checked' : ''}
                               onchange="event.stopPropagation(); toggleNotifyNearby('${cid}', this.checked)">
                        Notify if nearby
                    </label>
                </div>
                <div class="contact-detail-share-location">
                    <label class="contact-share-location-label">
                        <input type="checkbox" class="contact-share-location-checkbox"
                               data-contact-id="${cid}"
                               ${locationSharesOutbound[contact.contact_id] ? 'checked' : ''}
                               onchange="event.stopPropagation(); toggleShareLocation('${cid}', this.checked)">
                        Share My Location
                    </label>
                    <span class="contact-share-location-remaining" id="share-loc-remaining-${cid}"
                          ${locationSharesOutbound[contact.contact_id] && formatLocationShareRemaining(locationSharesOutbound[contact.contact_id].expires_at) ? '' : 'style="display:none"'}>${locationSharesOutbound[contact.contact_id] ? formatLocationShareRemaining(locationSharesOutbound[contact.contact_id].expires_at) : ''}</span>
                </div>
                <div class="contact-shared-trust" id="shared-${cid}">
                    <div class="contact-shared-title">Trust</div>
                    <div class="contact-detail-line contact-detail-muted">Loading shared trust…</div>
                </div>
                <div class="contact-shared-details">
                    <div class="contact-shared-title">Shared with you</div>
                    ${phone ? `<div class="contact-detail-line"><span class="contact-detail-inline-icon" aria-hidden="true"><i data-lucide="phone"></i></span><a href="tel:${esc(phone)}">${esc(phone)}</a> <a href="sms:${esc(phone)}" class="contact-action-icon" title="Send message"><i data-lucide="message-circle" aria-hidden="true"></i></a></div>` : ''}
                    ${email ? `<div class="contact-detail-line"><span class="contact-detail-inline-icon" aria-hidden="true"><i data-lucide="mail"></i></span><a href="mailto:${esc(email)}">${esc(email)}</a></div>` : ''}
                    ${!phone && !email ? '<div class="contact-detail-line contact-detail-muted">No phone or email shared with you yet.</div>' : ''}
                </div>
                <div class="pref-sponsor-card" id="contact-sponsor-${cid}">
                    <div id="contactSponsorAvatar-${cid}" class="pref-sponsor-avatar"><i data-lucide="user-round" aria-hidden="true"></i></div>
                    <div>
                        <div class="pref-sponsor-label">${sponsoredAgoLabel(profile.created_at)}</div>
                        <div id="contactSponsorName-${cid}" class="pref-sponsor-name">${profile.sponsor_id ? 'Loading sponsor...' : 'Root user (no sponsor)'}</div>
                    </div>
                </div>
                <div class="family-tree" id="ft-${cid}">
                    <div class="family-tree-title">Family Tree</div>
                    <div class="family-tree-loading">Loading…</div>
                </div>
            </div>
        </div>`;
}

const mutualContactsCache = {};
const MUTUALS_INLINE_LIMIT = 3;

async function loadMutualContacts(contactId) {
    const container = document.getElementById('mutuals-' + contactId);
    if (!container || !currentUser) return;
    if (container.dataset.loaded === '1') return;

    if (mutualContactsCache[contactId]) {
        container.dataset.loaded = '1';
        renderMutualContacts(container, mutualContactsCache[contactId], contactId);
        return;
    }

    try {
        const { data, error } = await db.rpc('get_shared_contacts', { p_contact_id: contactId });
        if (error) throw error;
        const mutuals = Array.isArray(data) ? data : [];
        mutualContactsCache[contactId] = mutuals;
        container.dataset.loaded = '1';
        renderMutualContacts(container, mutuals, contactId);
    } catch (e) {
        console.error('loadMutualContacts error:', e);
        container.dataset.loaded = '1';
    }
}

function renderMutualContacts(container, mutuals, contactId) {
    if (!mutuals || mutuals.length === 0) {
        container.innerHTML = '';
        return;
    }
    const count = mutuals.length;
    const names = mutuals.map(m => m.display_name || 'Unknown');
    const inlineNames = names.slice(0, MUTUALS_INLINE_LIMIT);
    const hasMore = count > MUTUALS_INLINE_LIMIT;

    const nameLink = (m) => `<a href="#" class="contact-mutuals-name" data-mutual-id="${esc(m.id)}">${esc(m.display_name || 'Unknown')}</a>`;
    const inlineMutuals = hasMore ? mutuals.slice(0, MUTUALS_INLINE_LIMIT) : mutuals;

    const label = `<a href="#" class="contact-mutuals-link">${count} Mutual${count === 1 ? '' : 's'}</a>`;
    const nameList = inlineMutuals.map(nameLink).join(', ') + (hasMore ? ', \u2026' : '');

    container.innerHTML = `<span class="contact-mutuals-text">${label}<span class="contact-mutuals-separator">:</span> ${nameList}</span>`;

    container.querySelector('.contact-mutuals-link').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showMutualsPopup(mutuals, contactId);
    });

    container.querySelectorAll('.contact-mutuals-name').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openContactDetailsById(link.dataset.mutualId);
        });
    });
}

function showMutualsPopup(mutuals, contactId) {
    let overlay = document.getElementById('mutuals-popup-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'mutuals-popup-overlay';
        overlay.className = 'mutuals-popup-overlay';
        overlay.innerHTML = `<div class="mutuals-popup">
            <div class="mutuals-popup-header">
                <h3 class="mutuals-popup-title"></h3>
                <button class="mutuals-popup-close" aria-label="Close">\u2715</button>
            </div>
            <ul class="mutuals-popup-list"></ul>
        </div>`;
        overlay.addEventListener('click', (e) => {
            if (!e.target.closest('.mutuals-popup')) closeMutualsPopup();
        });
        overlay.querySelector('.mutuals-popup-close').addEventListener('click', closeMutualsPopup);
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMutualsPopup(); });
        document.body.appendChild(overlay);
    }
    overlay.querySelector('.mutuals-popup-title').textContent = `${mutuals.length} Mutual Contacts`;
    const list = overlay.querySelector('.mutuals-popup-list');
    list.innerHTML = mutuals.map(m =>
        `<li class="mutuals-popup-item" data-mutual-id="${esc(m.id)}">${esc(m.display_name || 'Unknown')}</li>`
    ).join('');
    list.querySelectorAll('.mutuals-popup-item').forEach(item => {
        item.addEventListener('click', () => {
            closeMutualsPopup();
            openContactDetailsById(item.dataset.mutualId);
        });
    });
    overlay.classList.add('active');
}

function closeMutualsPopup() {
    const overlay = document.getElementById('mutuals-popup-overlay');
    if (overlay) overlay.classList.remove('active');
}

const sharedTrustCache = {};
function renderSharedTrust(container, trustData) {
    const contactsCount = trustData?.contactsCount == null
        ? 'Unavailable'
        : (Number.isFinite(Number(trustData.contactsCount)) ? Number(trustData.contactsCount) : 0);
    const attestersCount = trustData?.attestersCount == null
        ? 'Unavailable'
        : (Number.isFinite(Number(trustData.attestersCount)) ? Number(trustData.attestersCount) : 0);
    const profileMatchesCount = trustData?.profileMatchesCount == null
        ? 'Unavailable'
        : (Number.isFinite(Number(trustData.profileMatchesCount)) ? Number(trustData.profileMatchesCount) : 0);
    const groups = Array.isArray(trustData?.groups) ? trustData.groups.filter(g => g && g.name) : null;
    const contactsText = contactsCount === 'Unavailable'
        ? 'Shared contacts unavailable'
        : (Number(contactsCount) > 0
            ? `<span class="contact-shared-key">${Number(contactsCount)}</span> Shared Contacts`
            : 'No Shared Contacts');
    const groupsText = groups == null
        ? 'Shared groups unavailable'
        : (groups.length > 0
            ? `Shared groups: ${groups.map(g =>
                `<a href="#" class="contact-shared-key contact-shared-group-link" data-group-id="${esc(g.id)}">${esc(g.name)}</a>`
              ).join(', ')}`
            : 'No Shared Groups');
    const attestersText = attestersCount === 'Unavailable'
        ? 'Mutual attestations unavailable'
        : (Number(attestersCount) > 0
            ? `<span class="contact-shared-key">${Number(attestersCount)}</span> Mutual Attestations`
            : 'No Mutual Attestations');
    const profileMatchesText = profileMatchesCount === 'Unavailable'
        ? 'Matches Profile unavailable'
        : (Number(profileMatchesCount) > 0
            ? `<span class="contact-shared-key">${Number(profileMatchesCount)}</span> profile picture confirmations`
            : 'No profile picture confirmations');
    container.innerHTML = `
        <div class="contact-shared-title">Trust</div>
        <div class="contact-detail-line">${contactsText}</div>
        <div class="contact-detail-line">${groupsText}</div>
        <div class="contact-detail-line">${attestersText}</div>
        <div class="contact-detail-line">${profileMatchesText}</div>
    `;
    container.querySelectorAll('.contact-shared-group-link').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const groupId = link.dataset.groupId;
            navigateTo('groups');
            selectGroupById(groupId);
        });
    });
}

async function loadContactSponsor(contactId) {
    const nameEl = document.getElementById('contactSponsorName-' + contactId);
    const avatarEl = document.getElementById('contactSponsorAvatar-' + contactId);
    if (!nameEl || !avatarEl || nameEl.dataset.loaded === '1') return;
    nameEl.dataset.loaded = '1';
    const row = contactsLoadedRows.find(r => r.contact.contact_id === contactId);
    const sponsorId = row?.profile?.sponsor_id;
    if (!sponsorId) {
        nameEl.textContent = 'Root user (no sponsor)';
        avatarEl.textContent = '\u2605';
        return;
    }
    try {
        const { data: sp } = await db.from('profiles').select('display_name, profile_image_url').eq('id', sponsorId).single();
        const sponsorName = sp?.display_name || 'Unknown';
        nameEl.textContent = sponsorName;
        if (sp?.profile_image_url) {
            avatarEl.innerHTML = `<img src="${esc(sp.profile_image_url)}" alt="${esc(sponsorName)}">`;
        } else {
            avatarEl.textContent = sponsorName.charAt(0).toUpperCase() || '';
        }
    } catch (_) {
        nameEl.textContent = '';
        avatarEl.innerHTML = '<i data-lucide="user-round" aria-hidden="true"></i>';
        if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
    }
}

async function loadSharedTrust(contactId) {
    const container = document.getElementById('shared-' + contactId);
    if (!container || !currentUser) return;

    if (container.dataset.loaded === '1') return;

    if (sharedTrustCache[contactId]) {
        container.dataset.loaded = '1';
        renderSharedTrust(container, sharedTrustCache[contactId]);
        return;
    }

    try {
        const [sharedContactsRes, sharedGroupsRes, sharedAttestersRes, profileMatchesRes] = await Promise.all([
            db.rpc('get_shared_contacts_count', { p_contact_id: contactId }),
            db.rpc('get_shared_groups', { p_contact_id: contactId }),
            db.rpc('get_shared_attesters_count', { p_contact_id: contactId }),
            db.rpc('get_profile_picture_attesters_count', { p_contact_id: contactId })
        ]);

        if (sharedContactsRes.error) console.error('Shared trust contacts RPC error:', sharedContactsRes.error);
        if (sharedGroupsRes.error) console.error('Shared trust groups RPC error:', sharedGroupsRes.error);
        if (sharedAttestersRes.error) console.error('Shared trust attesters RPC error:', sharedAttestersRes.error);
        if (profileMatchesRes.error) console.error('Shared trust profile match RPC error:', profileMatchesRes.error);

        const trustData = {
            contactsCount: sharedContactsRes.error
                ? null
                : (Number.isFinite(Number(sharedContactsRes.data)) ? Number(sharedContactsRes.data) : 0),
            groups: sharedGroupsRes.error
                ? null
                : (Array.isArray(sharedGroupsRes.data) ? sharedGroupsRes.data.filter(row => row.name) : []),
            attestersCount: sharedAttestersRes.error
                ? null
                : (Number.isFinite(Number(sharedAttestersRes.data)) ? Number(sharedAttestersRes.data) : 0),
            profileMatchesCount: profileMatchesRes.error
                ? null
                : (Number.isFinite(Number(profileMatchesRes.data)) ? Number(profileMatchesRes.data) : 0)
        };

        const allFailed = trustData.contactsCount == null
            && trustData.groups == null
            && trustData.attestersCount == null
            && trustData.profileMatchesCount == null;
        container.dataset.loaded = '1';
        if (allFailed) {
            container.innerHTML = `
                <div class="contact-shared-title">Trust</div>
                <div class="contact-detail-line contact-detail-muted">Could not load shared trust yet.</div>
            `;
            return;
        }

        sharedTrustCache[contactId] = trustData;
        renderSharedTrust(container, trustData);
    } catch (e) {
        console.error('Shared trust error:', e);
        container.dataset.loaded = '1';
        container.innerHTML = `
            <div class="contact-shared-title">Trust</div>
            <div class="contact-detail-line contact-detail-muted">Could not load shared trust yet.</div>
        `;
    }
}

// Family tree: loads ancestor chains for both users and renders the shared tree
const familyTreeCache = {};
async function loadFamilyTree(contactId) {
    const container = document.getElementById('ft-' + contactId);
    if (!container || !currentUser) return;

    // Don't reload if already rendered
    if (container.dataset.loaded === '1') return;

    try {
        const [myChainRes, theirChainRes] = await Promise.all([
            familyTreeCache[currentUser.id]
                ? Promise.resolve({ data: familyTreeCache[currentUser.id], error: null })
                : db.rpc('get_ancestor_chain', { p_user_id: currentUser.id }),
            db.rpc('get_ancestor_chain', { p_user_id: contactId })
        ]);

        const myChain = myChainRes.data || [];
        const theirChain = theirChainRes.data || [];

        if (myChain.length > 0) familyTreeCache[currentUser.id] = myChain;

        container.dataset.loaded = '1';
        renderFamilyTree(container, myChain, theirChain, contactId);
    } catch (e) {
        console.error('Family tree error:', e);
        container.innerHTML = '<div class="family-tree-title">Family Tree</div><div class="family-tree-loading">Could not load tree.</div>';
    }
}

function renderFamilyTree(container, myChain, theirChain, contactId) {
    const normalizeAncestorChain = (chain) => {
        const out = [];
        const seen = new Set();
        for (const node of (chain || [])) {
            if (!node || !node.id) continue;
            // Stop at first cycle so repeating sponsor loops do not render forever.
            if (seen.has(node.id)) break;
            seen.add(node.id);
            out.push(node);
        }
        return out;
    };

    const safeMyChain = normalizeAncestorChain(myChain);
    const safeTheirChain = normalizeAncestorChain(theirChain);
    const theirIdSet = new Set(safeTheirChain.map(n => n.id));
    let lcaIndex = -1;
    for (let i = 0; i < safeMyChain.length; i++) {
        if (theirIdSet.has(safeMyChain[i].id)) {
            lcaIndex = i;
            break;
        }
    }

    if (lcaIndex < 0) {
        container.innerHTML = '<div class="family-tree-title">Family Tree</div><div class="family-tree-loading" style="font-style:italic;">No shared sponsors found.</div>';
        return;
    }

    const lcaId = safeMyChain[lcaIndex].id;
    const theirLcaIndex = safeTheirChain.findIndex(n => n.id === lcaId);
    if (theirLcaIndex < 0) {
        container.innerHTML = '<div class="family-tree-title">Family Tree</div><div class="family-tree-loading" style="font-style:italic;">No shared sponsors found.</div>';
        return;
    }

    // Build root -> ... -> LCA vertical chain
    const sharedTopPath = safeMyChain.slice(lcaIndex).reverse();
    // Build LCA child -> ... -> leaves (you/contact)
    const myDescPath = safeMyChain.slice(0, lcaIndex).reverse();
    const theirDescPath = safeTheirChain.slice(0, theirLcaIndex).reverse();

    const nodeHtml = (node, cls = '') => {
        const name = esc(node.display_name || 'Unknown');
        return `<div class="ft-node ${cls}" title="${name}">${name}</div>`;
    };

    const connectorHtml = '<div class="ft-connector"></div>';
    const buildPathHtml = (pathNodes, leafClass) => {
        if (!pathNodes.length) return '';
        let html = '';
        for (let i = 0; i < pathNodes.length; i++) {
            if (i > 0) html += connectorHtml;
            const cls = i === pathNodes.length - 1 ? leafClass : '';
            html += nodeHtml(pathNodes[i], cls);
        }
        return html;
    };

    let sharedHtml = '';
    for (let i = 0; i < sharedTopPath.length; i++) {
        if (i > 0) sharedHtml += connectorHtml;
        const cls = i === sharedTopPath.length - 1 ? 'ft-lca' : '';
        sharedHtml += nodeHtml(sharedTopPath[i], cls);
    }

    const leftBranch = buildPathHtml(myDescPath, 'ft-you');
    const rightBranch = buildPathHtml(theirDescPath, 'ft-them');
    const hasLeft = myDescPath.length > 0;
    const hasRight = theirDescPath.length > 0;
    const branchStem = (hasLeft || hasRight)
        ? `${connectorHtml}<div class="ft-split-bar"><div></div><div></div></div>`
        : '';

    // Special-case root->descendant: only show right branch below root chain.
    let branchHtml = '';
    if (hasLeft || hasRight) {
        if (!hasLeft && hasRight) {
            branchHtml = `<div class="ft-branches ft-single-right">
                <div class="ft-branch ft-branch-empty"></div>
                <div class="ft-branch">${rightBranch}</div>
            </div>`;
        } else if (hasLeft && !hasRight) {
            branchHtml = `<div class="ft-branches ft-single-left">
                <div class="ft-branch">${leftBranch}</div>
                <div class="ft-branch ft-branch-empty"></div>
            </div>`;
        } else {
            branchHtml = `<div class="ft-branches">
                <div class="ft-branch">${leftBranch}</div>
                <div class="ft-branch">${rightBranch}</div>
            </div>`;
        }
    }

    const treeHtml = `<div class="family-tree-title">Family Tree</div>
        <div class="family-tree-diagram">
            <div class="ft-branch">${sharedHtml}</div>
            ${branchStem}
            ${branchHtml}
        </div>`;

    container.innerHTML = treeHtml;
}

// ============================================================================
// Shared fullscreen camera overlay (#newContactSelfieOverlay)
// ----------------------------------------------------------------------------
// Modes (cameraOverlayMode):
//   - contactSelfie — contactSelfieId / newContactSelfieId set; Use uploads selfie
//   - chatPhoto     — cameraOverlayContext + cameraOverlayOnUse; Use sends chat image
// ============================================================================

function _updateCameraMirrorClasses() {
    const video = document.getElementById('newContactSelfieVideo');
    const preview = document.getElementById('newContactSelfiePreview');
    const isUser = cameraFacingMode === 'user';
    [video, preview].forEach((el) => {
        if (!el) return;
        el.classList.toggle('camera-facing-user', isUser);
    });
}

function openContactSelfie(contactId) {
    cameraOverlayMode = 'contactSelfie';
    cameraOverlayContext = null;
    cameraOverlayOnUse = null;
    contactSelfieId = contactId;
    const row = (contactsLoadedRows || []).find(r => r.contact?.contact_id === contactId);
    const name = row?.profile?.display_name || 'your contact';
    _openCameraOverlay(`Take a selfie with ${name}!`);
}

async function openNewContactSelfieOverlay(contactId, contactName) {
    cameraOverlayMode = 'contactSelfie';
    cameraOverlayContext = null;
    cameraOverlayOnUse = null;
    newContactSelfieId = contactId;
    newContactSelfieContactName = contactName || 'your new contact';
    if (typeof shouldOfferBetaIosPromptAfterSignup === 'function' && shouldOfferBetaIosPromptAfterSignup()) {
        pendingBetaIosPromptAfterPostHandshakeSelfie = true;
    }
    await _openCameraOverlay(`Take a selfie with ${newContactSelfieContactName}!`);
}

// Chat and other features open the same overlay with a custom Use handler.
async function openCameraOverlay({ banner, context, onUse }) {
    cameraOverlayMode = 'chatPhoto';
    cameraOverlayContext = context || null;
    cameraOverlayOnUse = typeof onUse === 'function' ? onUse : null;
    contactSelfieId = null;
    newContactSelfieId = null;
    await _openCameraOverlay(banner || 'Send a photo');
}

function _resetSelfieOverlayUi() {
    pendingSelfieCanvas = null;
    const video = document.getElementById('newContactSelfieVideo');
    const preview = document.getElementById('newContactSelfiePreview');
    const captureBtn = document.getElementById('newContactSelfieCaptureBtn');
    const review = document.getElementById('newContactSelfieReview');
    const flipBtn = document.getElementById('newContactSelfieFlipBtn');
    if (video) video.classList.remove('hidden');
    if (preview) {
        preview.removeAttribute('src');
        preview.classList.add('hidden');
    }
    if (captureBtn) captureBtn.classList.remove('hidden');
    if (review) review.classList.add('hidden');
    if (flipBtn) flipBtn.style.display = '';
    _updateCameraMirrorClasses();
}

function _stopSelfieCamera() {
    if (newContactSelfieStream) {
        newContactSelfieStream.getTracks().forEach(t => t.stop());
        newContactSelfieStream = null;
    }
    const video = document.getElementById('newContactSelfieVideo');
    if (video) video.srcObject = null;
}

async function _startSelfieCamera(facingMode) {
    const video = document.getElementById('newContactSelfieVideo');
    if (!video) return;
    if (facingMode) cameraFacingMode = facingMode;
    _stopSelfieCamera();
    newContactSelfieStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: cameraFacingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
    });
    video.srcObject = newContactSelfieStream;
    await video.play();
    _updateCameraMirrorClasses();
}

function _showSelfieReviewUi(canvas) {
    pendingSelfieCanvas = canvas;
    const video = document.getElementById('newContactSelfieVideo');
    const preview = document.getElementById('newContactSelfiePreview');
    const captureBtn = document.getElementById('newContactSelfieCaptureBtn');
    const review = document.getElementById('newContactSelfieReview');
    const flipBtn = document.getElementById('newContactSelfieFlipBtn');
    _stopSelfieCamera();
    if (video) video.classList.add('hidden');
    if (preview) {
        preview.src = canvas.toDataURL('image/jpeg', 0.9);
        preview.classList.remove('hidden');
    }
    if (captureBtn) captureBtn.classList.add('hidden');
    if (review) review.classList.remove('hidden');
    if (flipBtn) flipBtn.style.display = 'none';
    _updateCameraMirrorClasses();
}

async function _openCameraOverlay(bannerText) {
    const overlay = document.getElementById('newContactSelfieOverlay');
    const banner = document.getElementById('newContactSelfieBanner');
    const video = document.getElementById('newContactSelfieVideo');
    if (!overlay || !video) return;
    if (banner) banner.textContent = bannerText;
    cameraFacingMode = 'user';
    _resetSelfieOverlayUi();
    overlay.classList.remove('hidden');
    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
    try {
        await _startSelfieCamera('user');
        if (cameraOverlayMode === 'contactSelfie') {
            await unlockNativeOrientationForSelfiePreview();
        }
    } catch (e) {
        console.error('Camera overlay error:', e);
        showToast('Camera unavailable: ' + (e.message || 'error'), 'error');
        closeSelfieOverlay();
    }
}

async function flipCameraOverlay() {
    const next = cameraFacingMode === 'user' ? 'environment' : 'user';
    const useBtn = document.getElementById('newContactSelfieUseBtn');
    if (useBtn) useBtn.disabled = true;
    try {
        if (pendingSelfieCanvas) {
            _resetSelfieOverlayUi();
        }
        await _startSelfieCamera(next);
    } catch (e) {
        console.error('Camera flip error:', e);
        showToast('Could not switch camera: ' + (e.message || 'error'), 'error');
    } finally {
        if (useBtn) useBtn.disabled = false;
    }
}

// Close the overlay. In "new contact" mode (newContactSelfieId set) this
// also navigates to the contact's details screen, matching the original
// post-handshake flow.
function closeSelfieOverlay() {
    const overlay = document.getElementById('newContactSelfieOverlay');
    if (overlay) overlay.classList.add('hidden');
    _stopSelfieCamera();
    _resetSelfieOverlayUi();
    const newCid = newContactSelfieId;
    const wasContactSelfie = cameraOverlayMode === 'contactSelfie';
    newContactSelfieId = null;
    newContactSelfieContactName = '';
    contactSelfieId = null;
    cameraOverlayMode = null;
    cameraOverlayContext = null;
    cameraOverlayOnUse = null;
    cameraFacingMode = 'user';
    void lockAppToPortrait();
    if (wasContactSelfie && newCid) {
        const openPromise = openContactDetailsById(newCid);
        if (typeof maybeShowBetaIosPromptAfterSignup === 'function') {
            Promise.resolve(openPromise).then(
                () => maybeShowBetaIosPromptAfterSignup(),
                () => maybeShowBetaIosPromptAfterSignup()
            );
        }
    }
}

// Back-compat wrappers so existing call sites (and index.html inline
// handlers) keep working.
function closeContactSelfieModal() { closeSelfieOverlay(); }
function closeNewContactSelfieOverlay() { closeSelfieOverlay(); }

// Returns true if the selfie overlay is currently open for the given contact
// (either mode). Used by the realtime listener to auto-close our open
// "take a selfie" screen when the other side just posted a selfie.
function isSelfieOverlayOpenFor(contactId) {
    return !!contactId && cameraOverlayMode === 'contactSelfie'
        && (contactSelfieId === contactId || newContactSelfieId === contactId);
}

function _isCameraOverlayActive() {
    if (cameraOverlayMode === 'chatPhoto') return !!cameraOverlayOnUse;
    return !!(contactSelfieId || newContactSelfieId);
}

async function captureContactSelfie() {
    if (!_isCameraOverlayActive() || !currentUser) return;
    const video = document.getElementById('newContactSelfieVideo');
    if (!video || video.readyState < 2) {
        showToast('Camera not ready — please wait a moment and try again.', 'error');
        return;
    }
    const btn = document.getElementById('newContactSelfieCaptureBtn');
    if (btn) btn.disabled = true;

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0);

    _showSelfieReviewUi(canvas);
    if (btn) btn.disabled = false;
}

async function retakeContactSelfie() {
    _resetSelfieOverlayUi();
    const useBtn = document.getElementById('newContactSelfieUseBtn');
    if (useBtn) useBtn.disabled = true;
    try {
        await _startSelfieCamera(cameraFacingMode);
    } catch (e) {
        console.error('Selfie camera error:', e);
        showToast('Camera unavailable: ' + (e.message || 'error'), 'error');
        closeSelfieOverlay();
    } finally {
        if (useBtn) useBtn.disabled = false;
    }
}

async function useContactSelfie() {
    const canvas = pendingSelfieCanvas;
    if (!canvas || !currentUser) return;
    const useBtn = document.getElementById('newContactSelfieUseBtn');
    if (useBtn) useBtn.disabled = true;

    if (cameraOverlayMode === 'chatPhoto' && cameraOverlayOnUse) {
        const onUse = cameraOverlayOnUse;
        closeSelfieOverlay();
        if (useBtn) useBtn.disabled = false;
        try {
            await onUse(canvas);
        } catch (e) {
            console.error('Chat photo error:', e);
            showToast('Could not send photo: ' + (e.message || 'error'), 'error');
        }
        return;
    }

    const cid = contactSelfieId || newContactSelfieId;
    if (!cid) {
        if (useBtn) useBtn.disabled = false;
        return;
    }

    closeSelfieOverlay();
    if (useBtn) useBtn.disabled = false;

    _uploadContactSelfieInBackground(cid, canvas).catch(e => {
        console.error('Capture selfie error:', e);
        showToast('Could not save selfie: ' + (e.message || 'error'), 'error');
    });
}

async function _uploadContactSelfieInBackground(cid, canvas) {
    // Run GPS + reverse geocode in parallel with the blob encode + upload so
    // neither serializes behind the other.
    const locationPromise = (async () => {
        try {
            const gps = await getGPSLocation();
            if (!gps) return { lat: null, lng: null, locationLabel: '' };
            const label = await reverseGeocode(gps.lat, gps.lng);
            return { lat: gps.lat, lng: gps.lng, locationLabel: label || '' };
        } catch (_) {
            return { lat: null, lng: null, locationLabel: '' };
        }
    })();

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob) throw new Error('Could not capture image from camera');
    const file = new File([blob], 'selfie.jpg', { type: 'image/jpeg' });
    const filePath = `${currentUser.id}/selfie_${cid}_${Date.now()}.jpg`;
    const { error: upErr } = await db.storage.from('avatars').upload(filePath, file, { upsert: false });
    if (upErr) throw upErr;
    const { data: urlData } = db.storage.from('avatars').getPublicUrl(filePath);
    const selfieUrl = urlData.publicUrl;

    const { lat, lng, locationLabel } = await locationPromise;
    const capturedAt = new Date().toISOString();
    const { error: rpcErr } = await db.rpc('add_contact_selfie', {
        p_contact_id: cid,
        p_selfie_url: selfieUrl,
        p_captured_at: capturedAt,
        p_lat: lat,
        p_lng: lng,
        p_location_label: locationLabel || null
    });
    if (rpcErr) throw rpcErr;

    recentSelfieUploads[cid] = Date.now();
    delete contactSelfiesCache[cid];
    showToast('Selfie saved!', 'success');
    reloadContactSelfiesStrip(cid);
    if (typeof cdRefreshSelfiesIfOpen === 'function') {
        cdRefreshSelfiesIfOpen(cid);
    }
}

// True when the page was opened directly off the filesystem (e.g. a developer
// double-clicking index.html for a quick UI test). Browsers do not persist
// geolocation permission for file: origins, so every call to
// navigator.geolocation.getCurrentPosition surfaces a fresh system prompt —
// once a minute when nearby tracking or location sharing is active. That makes
// local testing painful for no real benefit (the GPS data goes nowhere
// useful in that mode), so we suppress browser geolocation entirely here.
const BROWSER_GEOLOCATION_SUPPRESSED =
    typeof location !== 'undefined' && location.protocol === 'file:';

function _getGPSLocationBrowser() {
    return new Promise(resolve => {
        if (!('geolocation' in navigator)) { resolve(null); return; }
        if (BROWSER_GEOLOCATION_SUPPRESSED) { resolve(null); return; }
        navigator.geolocation.getCurrentPosition(
            pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
            () => resolve(null),
            {
                enableHighAccuracy: true,
                timeout: APP_TIMING.BROWSER_GPS_TIMEOUT_MS,
                maximumAge: APP_TIMING.BROWSER_GPS_MAX_AGE_MS
            }
        );
    });
}

// Max age of a cached native GPS fix before we force a refresh. Kept short so
// background pollers (location sharing, nearby) never upload stale coordinates,
// but long enough to deduplicate ad-hoc callers (e.g. rendering a contact card)
// firing within the same interaction.
const NATIVE_GPS_CACHE_MAX_AGE_MS = APP_TIMING.NATIVE_GPS_CACHE_MAX_AGE_MS;

// Pass `{ maxAgeMs }` to widen the cache acceptance window. Strict callers
// (foreground location uploader, selfie capture, anything that writes to the
// server) should leave it unset so we keep the default 30s freshness bar.
// Non-critical UX (e.g. distance display on the contact details Sharing
// Location card) can pass APP_TIMING.RELAXED_GPS_MAX_AGE_MS so we serve any
// reasonably recent cached fix instead of stalling for up to 12s on the
// native plugin's freshFixDeadline.
function getGPSLocation(options) {
    const maxAgeMs = (options && Number.isFinite(options.maxAgeMs))
        ? options.maxAgeMs
        : NATIVE_GPS_CACHE_MAX_AGE_MS;
    if (IS_NATIVE && NATIVE_PLATFORM !== 'android') {
        if (
            nativeLocationLastPosition &&
            (Date.now() - nativeLocationLastAt) < maxAgeMs
        ) {
            return Promise.resolve(nativeLocationLastPosition);
        }
        // Never fall back to navigator.geolocation in native builds: inside
        // the iOS WKWebView the page origin is capacitor://localhost, and
        // calling the web geolocation API there triggers the WebKit system
        // prompt ("Localhost would like to use your current location"),
        // which is jarring and unrelated to our native location flow.
        try {
            const plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BackgroundLocation;
            if (!plugin) return Promise.resolve(null);
            return plugin.getCurrentPosition()
                .then(pos => {
                    if (!pos || typeof pos.lat !== 'number' || typeof pos.lng !== 'number') {
                        return null;
                    }
                    nativeLocationLastPosition = { lat: pos.lat, lng: pos.lng };
                    nativeLocationLastAt = Date.now();
                    return nativeLocationLastPosition;
                })
                .catch(() => null);
        } catch (e) {
            return Promise.resolve(null);
        }
    }
    return _getGPSLocationBrowser();
}

async function reverseGeocode(lat, lng) {
    try {
        const resp = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
            { headers: { 'Accept-Language': 'en' } }
        );
        if (!resp.ok) return '';
        const data = await resp.json();
        const addr = data.address || {};
        const city = addr.city || addr.town || addr.village || addr.county || '';
        const state = addr.state || '';
        const parts = [city, state].filter(Boolean);
        return parts.join(', ');
    } catch {
        return '';
    }
}

async function openShareWithContact(contactId, contactName) {
    shareWithContactId = contactId;
    shareWithContactName = contactName || 'contact';

    // Seed checkbox state from the in-memory cache for an instant render.
    const row = (contactsLoadedRows || []).find(r => r.contact?.contact_id === contactId);
    shareWithInitialPhone = !!(row?.sharedByMe?.shared_phone);
    shareWithInitialEmail = !!(row?.sharedByMe?.shared_email);
    showModal('shareChoice');

    // Then refetch from the DB so the dialog always reflects what is actually
    // persisted (handles deep links, multi-device edits, stale cache).
    if (!currentUser) return;
    try {
        const { data, error } = await db
            .from('contact_shared')
            .select('shared_phone, shared_email')
            .eq('user_id', currentUser.id)
            .eq('contact_id', contactId)
            .maybeSingle();
        if (error) return;
        const dbPhone = !!data?.shared_phone;
        const dbEmail = !!data?.shared_email;

        // Bail if the user navigated away or opened a different contact.
        if (shareWithContactId !== contactId) return;

        if (row) {
            row.sharedByMe = row.sharedByMe || {};
            row.sharedByMe.shared_phone = data?.shared_phone || null;
            row.sharedByMe.shared_email = data?.shared_email || null;
        }
        shareWithInitialPhone = dbPhone;
        shareWithInitialEmail = dbEmail;

        if (typeof cdRefreshProfileShareTogglesIfOpen === 'function') cdRefreshProfileShareTogglesIfOpen(contactId);

        const phoneCheck = document.getElementById('shareCheckPhone');
        const emailCheck = document.getElementById('shareCheckEmail');
        if (phoneCheck && !phoneCheck.disabled) phoneCheck.checked = dbPhone;
        if (emailCheck && !emailCheck.disabled) emailCheck.checked = dbEmail;
    } catch (_) { /* non-fatal */ }
}

/**
 * Upsert outbound phone/email sharing for a contact (contact_shared + optional
 * contact_shares + push). Used by the shareChoice modal and contact-details toggles.
 * @param {string} contactId
 * @param {boolean} wantPhone
 * @param {boolean} wantEmail
 * @param {{ initialPhone?: boolean, initialEmail?: boolean, saveButtonEl?: HTMLElement }} [opts]
 * @returns {Promise<boolean>} true on success
 */
async function saveOutboundProfileShareForContact(contactId, wantPhone, wantEmail, opts) {
    opts = opts || {};
    if (!contactId || !currentUser) return false;

    const rowBefore = (contactsLoadedRows || []).find(r => r.contact?.contact_id === contactId);
    const prevSharedPhone = rowBefore?.sharedByMe?.shared_phone ?? null;
    const prevSharedEmail = rowBefore?.sharedByMe?.shared_email ?? null;

    let baseInitialPhone = !!(prevSharedPhone != null && String(prevSharedPhone).trim() !== '');
    let baseInitialEmail = !!(prevSharedEmail != null && String(prevSharedEmail).trim() !== '');
    if (typeof opts.initialPhone === 'boolean') baseInitialPhone = opts.initialPhone;
    if (typeof opts.initialEmail === 'boolean') baseInitialEmail = opts.initialEmail;

    const phone = wantPhone && currentProfile?.phone ? currentProfile.phone : null;
    const email = wantEmail && currentProfile?.email ? currentProfile.email : null;

    const newlyShared = [];
    if (wantPhone && currentProfile?.phone && !baseInitialPhone) newlyShared.push('phone');
    if (wantEmail && currentProfile?.email && !baseInitialEmail) newlyShared.push('email');

    const saveBtn = opts.saveButtonEl;
    if (saveBtn) saveBtn.disabled = true;

    try {
        await db.from('contact_shared').upsert({
            user_id: currentUser.id,
            contact_id: contactId,
            shared_phone: phone,
            shared_email: email
        }, { onConflict: 'user_id,contact_id' });

        for (const sharedType of newlyShared) {
            await db.from('contact_shares').insert({
                from_user_id: currentUser.id,
                to_user_id: contactId,
                shared_type: sharedType
            });
        }

        const phoneFirst = wantPhone && newlyShared.includes('phone');
        const emailFirst = wantEmail && newlyShared.includes('email');
        const phoneUpdate = wantPhone && !phoneFirst && String(phone || '') !== String(prevSharedPhone || '');
        const emailUpdate = wantEmail && !emailFirst && String(email || '') !== String(prevSharedEmail || '');
        const sharePushBody = buildInboundShareEmailPhonePushBody(
            currentProfile?.display_name || 'Someone',
            { phoneFirst, phoneUpdate, emailFirst, emailUpdate }
        );
        if (sharePushBody) sendInboundShareEmailPhonePush(contactId, sharePushBody);

        const row = (contactsLoadedRows || []).find(r => r.contact?.contact_id === contactId);
        if (row) {
            row.sharedByMe = row.sharedByMe || {};
            row.sharedByMe.shared_phone = phone;
            row.sharedByMe.shared_email = email;
        }

        if (typeof cdRefreshProfileShareTogglesIfOpen === 'function') {
            cdRefreshProfileShareTogglesIfOpen(contactId);
        }

        if (newlyShared.length > 0) {
            const labels = newlyShared.map(t => t === 'phone' ? 'phone number' : 'email');
            const joined = labels.length === 2 ? labels.join(' and ') : labels[0];
            showToast('Shared your ' + joined + '.', 'success');
        } else if (wantPhone || wantEmail) {
            showToast('Sharing preferences saved.', 'success');
        } else if (baseInitialPhone || baseInitialEmail) {
            showToast('Stopped sharing.', 'success');
        } else {
            showToast('No changes.', 'info');
        }

        return true;
    } catch (err) {
        console.error('saveOutboundProfileShareForContact error:', err);
        showToast('Could not save: ' + (err.message || 'error'), 'error');
        if (saveBtn) saveBtn.disabled = false;
        return false;
    }
}

async function saveShareWithContact() {
    if (!shareWithContactId || !currentUser) { closeModal(); return; }

    const phoneCheck = document.getElementById('shareCheckPhone');
    const emailCheck = document.getElementById('shareCheckEmail');
    const wantPhone = !!(phoneCheck?.checked && currentProfile?.phone);
    const wantEmail = !!(emailCheck?.checked && currentProfile?.email);
    const saveBtn = document.getElementById('shareSaveBtn');

    const ok = await saveOutboundProfileShareForContact(shareWithContactId, wantPhone, wantEmail, {
        initialPhone: shareWithInitialPhone,
        initialEmail: shareWithInitialEmail,
        saveButtonEl: saveBtn || undefined,
    });
    if (!ok) return;

    closeModal();
    shareWithContactId = null;
    shareWithContactName = '';
    shareWithInitialPhone = false;
    shareWithInitialEmail = false;
}

function openVouchWithContact(contactId, contactName) {
    vouchWithContactId = contactId;
    vouchWithContactName = contactName || 'contact';
    showModal('vouchChoice');
}

async function vouchWithContactChoice(attestationType) {
    if (!vouchWithContactId) { closeModal(); return; }
    await sendAttestation(vouchWithContactId, attestationType);
    closeModal();
    vouchWithContactId = null;
    vouchWithContactName = '';
}

async function toggleNotifyNearby(contactId, enabled) {
    if (!currentUser) return;
    try {
        const patch = { notify_nearby: enabled };
        if (enabled) patch.last_nearby_notified_at = null;
        const { error } = await db
            .from('contacts')
            .update(patch)
            .eq('user_id', currentUser.id)
            .eq('contact_id', contactId);
        if (error) throw error;
        const row = contactsLoadedRows.find(r => r.contact.contact_id === contactId);
        if (row) row.contact.notify_nearby = enabled;
        checkAndStartNearbyTracking();
    } catch (e) {
        console.error('toggleNotifyNearby error:', e);
        showToast('Could not update nearby preference.', 'error');
        const cb = document.querySelector(`.contact-nearby-checkbox[data-contact-id="${contactId}"]`);
        if (cb) cb.checked = !enabled;
    }
}
