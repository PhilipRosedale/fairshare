// Feed: the same things as the Map, newest first. People sharing their
// location get a strip at the top (their positions change every minute, so
// they don't get feed posts); offerings follow as cards. The kind chips at the
// top are the same filter the Map uses.
//
// Shares its data helpers with js/map-home.js and js/offerings.js.

function openFeed() {
    if (typeof initOfferingFilter === 'function') initOfferingFilter();
    renderFeed();
    ensureMapHomeProfiles().then(renderFeed);
    if (currentUser && typeof loadContactLocations === 'function') {
        loadContactLocations().catch(() => {});
    }
    if (typeof loadOfferings === 'function') loadOfferings();
    if (!mapHomeMyPos) locateMapHomeSilently();
}

function renderFeed() {
    const el = document.getElementById('feedContent');
    if (!el) return;
    const kindFilter = typeof offeringKindFilter !== 'undefined' ? offeringKindFilter : [];
    const sharers = kindFilter.length ? [] : getMapHomeSharers();
    const offerings = typeof getShownOfferings === 'function' ? getShownOfferings() : [];
    let html = '';
    if (sharers.length) {
        html += `
            <section class="feed-near" aria-label="Sharing location with you">
                <div class="feed-near-label">Sharing location with you</div>
                <div class="feed-near-row">
                    ${sharers.map(renderFeedSharer).join('')}
                </div>
            </section>`;
    }
    if (offerings.length) {
        html += `<div class="feed-list">${offerings.map(renderFeedOffering).join('')}</div>`;
    } else {
        const kindLabel = kindFilter.length === 1 ? OFFERING_KINDS[kindFilter[0]].label.toLowerCase() : '';
        html += `
            <section class="feed-empty">
                <span class="feed-empty-icon"><i data-lucide="newspaper" aria-hidden="true"></i></span>
                <h3>${kindLabel ? `Nothing to ${esc(kindLabel)} yet` : 'Nothing here yet'}</h3>
                <p>When your contacts and groups lend, sell, do something for someone or gather, it will show up here, newest first.</p>
                <button type="button" class="btn btn-primary feed-empty-offer" onclick="openOfferFlow()">Make an offering</button>
            </section>`;
    }
    el.innerHTML = html;
    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
}

function renderFeedSharer(s) {
    let sub;
    if (s.live && s.miles != null && typeof formatDistance === 'function') {
        sub = formatDistance(s.miles, { compact: true }).replace(/ away$/, '');
    } else if (s.live) {
        sub = 'Live';
    } else {
        sub = typeof formatLastSeen === 'function' ? formatLastSeen(s.loc.updated_at) : '';
    }
    const name = getMapHomeName(s.uid);
    return `
        <button type="button" class="feed-person ${s.live ? 'live' : 'stale'}" onclick="navigateTo('contactDetails', '${esc(s.uid)}')" aria-label="${esc(name)}, ${esc(sub)}">
            <span class="feed-person-ring">${getMapHomeAvatarHtml(s.uid, 'feed-person-avatar')}</span>
            <span class="feed-person-name">${esc(name.split(' ')[0])}</span>
            <span class="feed-person-sub">${esc(sub)}</span>
        </button>`;
}

function renderFeedOffering(o) {
    const id = escOfferAttr(o.id);
    const { title, rest } = splitOfferingDescription(o);
    const dist = getOfferingDistanceText(o);
    const who = o.is_mine ? 'You' : (o.poster_name || 'Someone');
    const sub = [o.is_mine ? 'Your offering' : o.known_as, getOfferingAge(o)].filter(Boolean).join(' · ');
    const primary = o.is_mine
        ? `<button type="button" class="feed-offer-btn primary" onclick="offeringEdit('${id}')"><i data-lucide="pencil" aria-hidden="true"></i>Edit</button>`
        : `<button type="button" class="feed-offer-btn primary" onclick="offeringMessage('${id}')"><i data-lucide="message-circle" aria-hidden="true"></i>Message</button>`;
    return `
        <article class="feed-offer">
            <header class="feed-offer-head">
                ${offeringPosterAvatarHtml(o, 'feed-offer-avatar')}
                <div class="feed-offer-who"><b>${esc(who)}</b><span>${esc(sub)}</span></div>
                ${dist ? `<span class="feed-offer-dist">${esc(dist)}</span>` : ''}
                <button type="button" class="feed-offer-more" onclick="openOfferingMenu('${id}')" aria-label="More"><i data-lucide="ellipsis" aria-hidden="true"></i></button>
            </header>
            ${offeringPhotosHtml(o, 'feed-offer-photo')}
            <div class="feed-offer-body">
                <div class="feed-offer-meta">${offeringKindPillHtml(o)}<span>${esc(getOfferingPriceLine(o))}</span></div>
                <h3 class="feed-offer-title">${esc(title || getOfferingTitle(o))}</h3>
                ${rest ? `<p class="feed-offer-text">${esc(rest)}</p>` : ''}
                ${title && o.place_label ? `<div class="feed-offer-place">${offeringIconSvg('map-pin')}${esc(o.place_label)}</div>` : ''}
                <div class="feed-offer-actions">
                    ${primary}
                    <button type="button" class="feed-offer-btn" onclick="mapHomeShowOffering('${id}')"><i data-lucide="map" aria-hidden="true"></i>Map</button>
                </div>
            </div>
        </article>`;
}

window.addEventListener('union:offeringsLoaded', () => { if (activeMainView === 'feed') renderFeed(); });
window.addEventListener('union:offeringFilterChanged', () => { if (activeMainView === 'feed') renderFeed(); });
