// =============================================================================
// Contact Details (Variation A) — full-page screen
// -----------------------------------------------------------------------------
// Activated by navigateTo('contactDetails', contactId). Renders a hero card,
// gradient trust card with score ring, selfies strip, two preference toggles,
// and a unified history timeline. Reuses existing data sources and write paths
// from contacts.js / location-sharing.js / web-of-trust.js.
//
// Vanilla JS, no build step. Lives behind #contactDetailsScreen which is a
// sibling of the other screens inside .main-content.
// =============================================================================

let cdCurrentContactId = null;
let cdConfettiTimer = null;
// Cached lists from get_contact_trust_summary so the mutuals dialog can render
// without an extra round trip. Keyed by contact id.
const cdMutualsCache = {};
// Most recent trust summary payload, captured in cdRenderTrust so the
// "Trust Details" dialog can show live counts and durations for each
// component without an extra round trip.
let cdLastTrustSummary = null;

function openContactDetailsScreen(contactId) {
    cdCurrentContactId = contactId || null;
    const root = document.getElementById('contactDetailsScreen');
    if (!root) return;

    if (!contactId) {
        if (typeof clearContactDetailResumeState === 'function') clearContactDetailResumeState();
        root.innerHTML = '<div class="cd-empty">Contact not found.</div>';
        if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
        return;
    }

    const row = (contactsLoadedRows || []).find(r => r.contact?.contact_id === contactId);

    if (row) {
        renderContactDetailsScreen(root, row);
        hydrateContactDetailsScreen(contactId);
    } else {
        // Fallback: list not loaded yet (e.g. deep link, hot reload).
        // Show skeleton with what we know, then fetch + re-render.
        root.innerHTML = renderCdSkeleton({ name: 'Loading…', avatarUrl: null });
        if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
        loadAndRenderContactList()
            .then(() => {
                if (cdCurrentContactId !== contactId) return;
                const r2 = (contactsLoadedRows || []).find(x => x.contact?.contact_id === contactId);
                if (r2) {
                    renderContactDetailsScreen(root, r2);
                    hydrateContactDetailsScreen(contactId);
                } else {
                    if (typeof clearContactDetailResumeState === 'function') clearContactDetailResumeState();
                    root.innerHTML = '<div class="cd-empty">Contact not found.</div>';
                    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
                }
            })
            .catch(() => {
                if (typeof clearContactDetailResumeState === 'function') clearContactDetailResumeState();
                root.innerHTML = '<div class="cd-empty">Could not load contact.</div>';
                if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
            });
    }
}

// ----- Skeleton + main render ------------------------------------------------

function renderCdSkeleton(seed) {
    const initial = (seed?.name || '?').trim().charAt(0).toUpperCase();
    const avatarHtml = seed?.avatarUrl
        ? `<img class="cd-hero-avatar" src="${esc(seed.avatarUrl)}" alt="">`
        : `<div class="cd-hero-avatar cd-hero-avatar-fallback">${esc(initial)}</div>`;
    return `
        <div class="cd-back-row">
            <button class="cd-back-link" type="button" onclick="closeContactDetailsScreen()">
                <i data-lucide="chevron-left" aria-hidden="true"></i>
                Contacts
            </button>
            <span class="cd-last-seen">&nbsp;</span>
        </div>
        <div class="cd-card cd-hero-card">
            <div class="cd-hero-row">
                ${avatarHtml}
                <div class="cd-hero-meta">
                    <div class="cd-hero-name">${esc(seed?.name || 'Loading…')}</div>
                </div>
            </div>
        </div>
        <div class="cd-card cd-trust-card cd-skeleton">&nbsp;</div>
    `;
}

function cdRefreshProfileShareTogglesIfOpen(contactId) {
    if (!contactId || cdCurrentContactId !== contactId) return;
    const row = (contactsLoadedRows || []).find(r => r.contact?.contact_id === contactId);
    if (!row) return;
    const sbm = row.sharedByMe || {};
    const outPhoneOn = sbm.shared_phone != null && String(sbm.shared_phone).trim() !== '';
    const outEmailOn = sbm.shared_email != null && String(sbm.shared_email).trim() !== '';
    cdSetSwitch('cd-toggle-share-email', outEmailOn);
    cdSetSwitch('cd-toggle-share-phone', outPhoneOn);
}

function renderContactDetailsScreen(root, row) {
    const c = row.contact || {};
    const p = row.profile || {};
    const id = c.contact_id;
    const name = p.display_name || 'Unknown';
    const avatarUrl = p.profile_image_url || null;
    const initial = name.trim().charAt(0).toUpperCase() || '?';

    const lastSeen = formatLastSeen(c.met_at);

    const phone = (row.shared?.shared_phone) || '';
    const email = (row.shared?.shared_email) || '';

    const notify = !!c.notify_nearby;
    const shareLoc = !!locationSharesOutbound[id];

    const avatarHtml = avatarUrl
        ? `<img class="cd-hero-avatar" src="${esc(avatarUrl)}" alt=""
                onclick="event.stopPropagation(); cdOpenAvatarLightbox('${esc(id)}', '${esc(avatarUrl)}', '${esc(name)}')">`
        : `<div class="cd-hero-avatar cd-hero-avatar-fallback"
                onclick="event.stopPropagation(); openSuggestPicture('${esc(id)}')"
                title="Suggest a profile picture">${esc(initial)}</div>`;

    const callDisabled = !phone ? 'disabled' : '';
    const callHref = phone ? `tel:${esc(phone)}` : '#';

    const hasContactLinePhone = !!(phone && String(phone).trim());
    const hasContactLineEmail = !!(email && String(email).trim());
    let contactLinesHtml = '';
    if (hasContactLinePhone || hasContactLineEmail) {
        const bits = [];
        if (hasContactLinePhone) bits.push(`<a class="cd-hero-phone" href="${callHref}">${esc(phone)}</a>`);
        if (hasContactLineEmail) {
            bits.push(`<button type="button" class="cd-hero-email" data-email="${encodeURIComponent(email)}" onclick="event.stopPropagation(); cdCopyContactEmailFromBtn(this)" title="Copy email">${esc(email)}</button>`);
        }
        contactLinesHtml = `<div class="cd-hero-contact-lines">${bits.join('<span class="cd-hero-contact-comma">, </span>')}</div>`;
    }

    const knownLineText = cdHeroKnownLineText(c.first_met_at || null, c.created_at || null);
    const sbm = row.sharedByMe || {};
    const outPhoneOn = sbm.shared_phone != null && String(sbm.shared_phone).trim() !== '';
    const outEmailOn = sbm.shared_email != null && String(sbm.shared_email).trim() !== '';
    const hasProfPhone = !!currentProfile?.phone;
    const hasProfEmail = !!currentProfile?.email;

    root.innerHTML = `
        <div class="cd-back-row">
            <button class="cd-back-link" type="button" onclick="closeContactDetailsScreen()">
                <i data-lucide="chevron-left" aria-hidden="true"></i>
                Contacts
            </button>
            <span class="cd-last-seen">${lastSeen ? 'Last met ' + esc(lastSeen) : ''}</span>
        </div>

        <div class="cd-card cd-hero-card">
            <div class="cd-hero-row">
                ${avatarHtml}
                <div class="cd-hero-meta">
                    <div class="cd-hero-name">${esc(name)}</div>
                    ${contactLinesHtml}
                    <div class="cd-hero-known-row">
                        <span class="cd-hero-known-main">
                            <span class="cd-sparkle" aria-hidden="true">\u2728</span>
                            <span id="cd-hero-known-display">${esc(knownLineText)}</span>
                        </span>
                        <span class="cd-met-edit-wrap">
                            <button type="button" class="cd-met-edit-btn" id="cd-met-edit-btn"
                                tabindex="-1" aria-hidden="true">${cdPencilIcon()}</button>
                            <input type="date" class="cd-met-input-overlay" id="cd-met-input"
                                value="${c.first_met_at ? new Date(c.first_met_at).toISOString().slice(0, 10) : ''}"
                                onclick="event.stopPropagation(); try { this.showPicker(); } catch(e) {}"
                                onchange="event.stopPropagation(); cdSaveMetOn('${esc(id)}', this.value)"
                                onblur="commitPendingFirstMetAt('${esc(id)}')"
                                aria-label="Edit when you first met"
                                title="Edit when you first met">
                        </span>
                    </div>
                </div>
            </div>
            <div class="cd-action-row">
                <button type="button" class="cd-action-btn cd-action-vouch" id="cd-vouch-btn"
                    onclick="cdOnVouchClick('${esc(id)}', '${esc(name)}')">
                    <span class="cd-action-icon">${cdShieldIcon()}</span>
                    <span class="cd-action-label">Vouch</span>
                </button>
                <button type="button" class="cd-action-btn" id="cd-intro-btn"
                    onclick="cdOpenIntroModal()">
                    <span class="cd-action-icon">${cdIntroIcon()}</span>
                    <span class="cd-action-label">Intro</span>
                </button>
                <a class="cd-action-btn cd-action-link ${callDisabled ? 'cd-action-disabled' : ''}" href="${callHref}" ${callDisabled} aria-disabled="${callDisabled ? 'true' : 'false'}">
                    <span class="cd-action-icon">${cdPhoneIcon()}</span>
                    <span class="cd-action-label">Call</span>
                </a>
                <button type="button" class="cd-action-btn cd-action-link" onclick="openDirectMessageScreen('${esc(id)}')">
                    <span class="cd-action-icon">${cdMessageIcon()}</span>
                    <span class="cd-action-label">Message</span>
                </button>
            </div>
        </div>

        <div id="cd-sharing-location-slot"></div>

        <div class="cd-card cd-trust-card" id="cd-trust">
            <div class="cd-trust-dots" aria-hidden="true"></div>
            <div class="cd-trust-row">
                <div class="cd-ring-col">
                    <div class="cd-ring" id="cd-ring"
                         role="button" tabindex="0"
                         aria-label="How is this score calculated?"
                         onclick="cdOpenTrustInfoDialog()"
                         onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();cdOpenTrustInfoDialog();}">
                        <svg viewBox="0 0 100 100" width="100" height="100" class="cd-ring-svg">
                            <circle cx="50" cy="50" r="42" stroke="rgba(255,255,255,0.15)" stroke-width="8" fill="none"/>
                            <circle id="cd-ring-fg" cx="50" cy="50" r="42"
                                stroke="var(--cd-gold)" stroke-width="8" fill="none"
                                stroke-linecap="round"
                                stroke-dasharray="${(2 * Math.PI * 42).toFixed(2)}"
                                stroke-dashoffset="${(2 * Math.PI * 42).toFixed(2)}"/>
                        </svg>
                        <div class="cd-ring-text">
                            <div class="cd-ring-score" id="cd-ring-score">--</div>
                            <div class="cd-ring-label">Trust</div>
                        </div>
                    </div>
                    <button type="button" class="cd-trust-info-btn"
                            aria-label="How is this score calculated?"
                            onclick="cdOpenTrustInfoDialog()">${cdInfoIcon()}</button>
                </div>
                <div class="cd-trust-meta">
                    <div class="cd-trust-stats">
                        <div class="cd-trust-stat"><div class="cd-trust-stat-n" id="cd-stat-shared-contacts">\u2014</div><div class="cd-trust-stat-l">Mutual contacts</div></div>
                        <div class="cd-trust-stat"><div class="cd-trust-stat-n" id="cd-stat-shared-groups">\u2014</div><div class="cd-trust-stat-l">Shared groups</div></div>
                        <div class="cd-trust-stat"><div class="cd-trust-stat-n" id="cd-stat-mutual-vouches">\u2014</div><div class="cd-trust-stat-l">Mutual Vouches</div></div>
                        <div class="cd-trust-stat"><div class="cd-trust-stat-n" id="cd-stat-trusted-vouches">\u2014</div><div class="cd-trust-stat-l">Trusted Vouches</div></div>
                    </div>
                </div>
            </div>
            <button type="button" class="cd-mutuals-row" id="cd-mutuals-row" hidden
                    onclick="cdOpenMutualsDialog('${esc(id)}', '${esc(name)}')">
                <div class="cd-mutuals-text" id="cd-mutuals-text"></div>
                <span class="cd-mutuals-chevron" aria-hidden="true">
                    <i data-lucide="chevron-right" aria-hidden="true"></i>
                </span>
            </button>
        </div>

        <div class="cd-section">
            <div class="cd-section-head">
                <div class="cd-overline" id="cd-selfies-head">Selfies together</div>
            </div>
            <div class="cd-selfies-strip" id="cd-selfies">
                <button type="button" class="cd-selfie-add" onclick="openContactSelfie('${esc(id)}')">
                    ${cdCameraIcon()}
                    <span>Take selfie</span>
                </button>
            </div>
        </div>

        <div class="cd-card cd-toggles-card">
            <button type="button" class="cd-toggle-row" id="cd-toggle-notify" onclick="cdOnToggleNotify('${esc(id)}')">
                <div class="cd-toggle-icon ${notify ? 'cd-toggle-icon-on' : ''}">${cdNearIcon()}</div>
                <div class="cd-toggle-text">
                    <div class="cd-toggle-label">Notify if nearby</div>
                    <div class="cd-toggle-sub">Get a ping when ${esc(firstName(name))} is within 1 mile</div>
                </div>
                <div class="cd-switch ${notify ? 'cd-switch-on' : ''}"><div class="cd-switch-knob"></div></div>
            </button>
            <div class="cd-toggle-divider"></div>
            <button type="button" class="cd-toggle-row" id="cd-toggle-share" onclick="cdOnToggleShareLoc('${esc(id)}')">
                <div class="cd-toggle-icon ${shareLoc ? 'cd-toggle-icon-on' : ''}">${cdLocationIcon()}</div>
                <div class="cd-toggle-text">
                    <div class="cd-toggle-label">Share My Location</div>
                    <div class="cd-toggle-sub">${esc(firstName(name))} can see you on the map</div>
                </div>
                <div class="cd-switch ${shareLoc ? 'cd-switch-on' : ''}"><div class="cd-switch-knob"></div></div>
            </button>
            <div class="cd-toggle-divider"></div>
            <button type="button" class="cd-toggle-row" id="cd-toggle-share-email"
                onclick="cdOnToggleShareEmail('${esc(id)}')"
                ${hasProfEmail ? '' : 'disabled'}>
                <div class="cd-toggle-icon ${outEmailOn ? 'cd-toggle-icon-on' : ''}">${cdLucideIcon('mail')}</div>
                <div class="cd-toggle-text">
                    <div class="cd-toggle-label">Share my email</div>
                    <div class="cd-toggle-sub">${hasProfEmail ? 'They can see the email on your profile' : 'Add an email in your profile first'}</div>
                </div>
                <div class="cd-switch ${outEmailOn ? 'cd-switch-on' : ''}"><div class="cd-switch-knob"></div></div>
            </button>
            <div class="cd-toggle-divider"></div>
            <button type="button" class="cd-toggle-row" id="cd-toggle-share-phone"
                onclick="cdOnToggleSharePhone('${esc(id)}')"
                ${hasProfPhone ? '' : 'disabled'}>
                <div class="cd-toggle-icon ${outPhoneOn ? 'cd-toggle-icon-on' : ''}">${cdPhoneIcon()}</div>
                <div class="cd-toggle-text">
                    <div class="cd-toggle-label">Share my phone</div>
                    <div class="cd-toggle-sub">${hasProfPhone ? 'They can see the phone on your profile' : 'Add a phone in your profile first'}</div>
                </div>
                <div class="cd-switch ${outPhoneOn ? 'cd-switch-on' : ''}"><div class="cd-switch-knob"></div></div>
            </button>
        </div>

        <div class="cd-card cd-history-card" id="cd-history-card">
            <div class="cd-overline">History together</div>
            <div class="cd-history-list" id="cd-history-list">
                <div class="cd-history-loading">Loading\u2026</div>
            </div>
        </div>

        <div class="cd-card cd-safety-card">
            <div class="cd-overline">Safety</div>
            <div class="cd-safety-row">
                <button type="button" class="btn btn-outline cd-safety-btn"
                        onclick="cdOnReportContact('${esc(id)}', '${esc(name)}')">
                    Report ${esc(firstName(name))}
                </button>
                <button type="button" class="btn btn-danger cd-safety-btn"
                        onclick="cdOnBlockContact('${esc(id)}', '${esc(name)}')">
                    Block ${esc(firstName(name))}
                </button>
            </div>
            <p class="cd-safety-hint">
                Reports are reviewed within 24 hours. Blocking removes them from
                your contacts, chat, nearby alerts, and the map.
            </p>
        </div>
    `;
    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
}

function cdOnReportContact(contactId, name) {
    if (typeof openReportDialog !== 'function') return;
    openReportDialog({
        userId: contactId,
        contentType: 'profile',
        contentId: contactId,
        contextLabel: name || 'this user'
    });
}

function cdOnBlockContact(contactId, name) {
    if (typeof openBlockUserConfirm !== 'function') return;
    openBlockUserConfirm(contactId, name);
}

// ----- Hydration -------------------------------------------------------------

async function hydrateContactDetailsScreen(contactId) {
    if (!contactId) return;

    // Sharing-location pane (only rendered if they share with us).
    cdRenderSharingLocationPane(contactId);

    // Selfies — reuse the existing loader/cache.
    loadContactSelfies(contactId).then((selfies) => {
        if (cdCurrentContactId !== contactId) return;
        cdRenderSelfies(contactId, selfies || []);
    }).catch(() => {});

    // Trust summary.
    db.rpc('get_contact_trust_summary', { p_contact_id: contactId })
        .then(({ data, error }) => {
            if (cdCurrentContactId !== contactId) return;
            if (error) { console.error('get_contact_trust_summary error:', error); return; }
            cdRenderTrust(data || {});
        });

    // History.
    db.rpc('get_contact_history', { p_contact_id: contactId, p_limit: 6 })
        .then(({ data, error }) => {
            if (cdCurrentContactId !== contactId) return;
            if (error) { console.error('get_contact_history error:', error); cdRenderHistory([]); return; }
            cdRenderHistory(Array.isArray(data) ? data : []);
        });

    if (typeof maybeOfferSponsorShareInfo === 'function') {
        maybeOfferSponsorShareInfo(contactId);
    }
}

// Refresh the selfies strip (and history timeline) on the Contact Details
// screen if it's currently open for this contact. Safe no-op otherwise.
// Called from the contacts.selfie_url realtime UPDATE handler (recipient side)
// and from captureContactSelfie() right after a successful upload (uploader
// side) so the carousel doesn't go stale until the user re-enters the screen.
function cdRefreshHistoryIfOpen(contactId) {
    if (!contactId || cdCurrentContactId !== contactId) return;
    if (typeof db === 'undefined' || !db || typeof db.rpc !== 'function') return;
    db.rpc('get_contact_history', { p_contact_id: contactId, p_limit: 6 })
        .then(({ data, error }) => {
            if (error || cdCurrentContactId !== contactId) return;
            cdRenderHistory(Array.isArray(data) ? data : []);
        });
}

function cdRefreshSelfiesIfOpen(contactId) {
    if (!contactId || cdCurrentContactId !== contactId) return;
    if (typeof loadContactSelfies === 'function') {
        loadContactSelfies(contactId)
            .then((selfies) => {
                if (cdCurrentContactId !== contactId) return;
                cdRenderSelfies(contactId, selfies || []);
            })
            .catch(() => {});
    }
    // Also refresh the history timeline so the new selfie event shows up.
    if (typeof db !== 'undefined' && db && typeof db.rpc === 'function') {
        db.rpc('get_contact_history', { p_contact_id: contactId, p_limit: 6 })
            .then(({ data, error }) => {
                if (error || cdCurrentContactId !== contactId) return;
                cdRenderHistory(Array.isArray(data) ? data : []);
            });
    }
}

function cdRenderSelfies(contactId, selfies) {
    const strip = document.getElementById('cd-selfies');
    const head = document.getElementById('cd-selfies-head');
    if (!strip) return;
    if (head) head.textContent = selfies.length
        ? `Selfies together \u00B7 ${selfies.length}`
        : 'Selfies together';

    const tilesHtml = selfies.map(s => {
        const dateStr = formatSelfieDate(s.captured_at);
        const locStr = s.location_label || '';
        return `
            <div class="cd-selfie-tile"
                 data-lightbox-url="${esc(s.selfie_url)}"
                 ${dateStr ? `data-lightbox-date="${esc(dateStr)}"` : ''}
                 ${locStr ? `data-lightbox-location="${esc(locStr)}"` : ''}
                 onclick="openLightbox('${esc(s.selfie_url)}', '${esc(dateStr)}', '${esc(locStr)}')">
                <img src="${esc(s.selfie_url)}" alt="Selfie" loading="lazy">
                <div class="cd-selfie-meta">
                    ${dateStr ? `<div class="cd-selfie-date">${esc(dateStr)}</div>` : ''}
                    ${locStr ? `<div class="cd-selfie-loc">${esc(locStr)}</div>` : ''}
                </div>
            </div>`;
    }).join('');
    const addHtml = `
        <button type="button" class="cd-selfie-add" onclick="openContactSelfie('${esc(contactId)}')">
            ${cdCameraIcon()}
            <span>Take selfie</span>
        </button>`;
    strip.innerHTML = tilesHtml + addHtml;
    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
}

function cdRenderTrust(t) {
    cdLastTrustSummary = t || null;
    const score = Math.max(0, Math.min(100, Number(t.score) || 0));

    // Capture the previous on-screen score so we can count-animate to the new
    // value. "--" placeholder parses to NaN -> treat as 0 so first paint
    // animates from empty to score.
    const scoreEl = document.getElementById('cd-ring-score');
    const prevScore = (() => {
        if (!scoreEl) return 0;
        const n = parseInt(scoreEl.textContent, 10);
        return Number.isFinite(n) ? n : 0;
    })();

    cdAnimateScore(scoreEl, prevScore, score, 900);
    setText('cd-stat-shared-contacts', String(Number(t.shared_contacts)  || 0));
    setText('cd-stat-shared-groups',   String(Number(t.shared_groups)    || 0));
    setText('cd-stat-mutual-vouches',  String(Number(t.mutual_vouches)   || 0));
    setText('cd-stat-trusted-vouches', String(Number(t.trusted_vouches)  || 0));

    const ringFg = document.getElementById('cd-ring-fg');
    if (ringFg) {
        const circumference = 2 * Math.PI * 42;
        const offset = circumference - (score / 100) * circumference;
        // Defer one frame so the CSS transition runs (initial is full circumference).
        requestAnimationFrame(() => {
            ringFg.style.transition = 'stroke-dashoffset 1.2s ease';
            ringFg.style.strokeDashoffset = offset.toFixed(2);
        });
        // One-shot glow pulse so re-opening a contact is fun and you can
        // see at a glance whether the score moved.
        ringFg.classList.remove('cd-ring-fg-pulse');
        // Force reflow so the animation restarts when the class is re-added.
        // eslint-disable-next-line no-unused-expressions
        void ringFg.getBoundingClientRect().width;
        ringFg.classList.add('cd-ring-fg-pulse');
        setTimeout(() => { ringFg.classList.remove('cd-ring-fg-pulse'); }, 800);
    }

    // Vouch button: filled style if the caller has any prior attestation.
    if (t.have_i_vouched) cdSetVouchedState(true);

    cdRenderMutualsRow(t);
}

// Count-animate the integer trust score from `from` to `to` over `duration` ms
// using easeOutCubic. Tabular numerals on .cd-ring-score keep the width steady
// so the digit transitions don't jitter.
function cdAnimateScore(el, from, to, duration) {
    if (!el) return;
    if (from === to) {
        el.textContent = String(to);
        return;
    }
    const start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const ease = (x) => 1 - Math.pow(1 - x, 3);
    function frame(now) {
        const t = Math.min(1, (now - start) / duration);
        const v = Math.round(from + (to - from) * ease(t));
        el.textContent = String(v);
        if (t < 1) requestAnimationFrame(frame);
        else el.textContent = String(to);
    }
    requestAnimationFrame(frame);
}

// ----- Mutuals (shared contacts + shared groups) -----------------------------

// Render the small two-line summary that lives at the bottom of the trust
// card, beneath the vouchers underline. Tapping it opens the full dialog.
function cdRenderMutualsRow(t) {
    const row = document.getElementById('cd-mutuals-row');
    const txt = document.getElementById('cd-mutuals-text');
    if (!row || !txt) return;

    const contacts = Array.isArray(t.shared_contacts_list) ? t.shared_contacts_list : [];
    const groups   = Array.isArray(t.shared_groups_list)   ? t.shared_groups_list   : [];
    const contactsTotal = Number(t.shared_contacts) || contacts.length;
    const groupsTotal   = Number(t.shared_groups)   || groups.length;

    // Cache for the dialog (keyed by current contact id).
    if (cdCurrentContactId) {
        cdMutualsCache[cdCurrentContactId] = {
            contacts,
            groups,
            contactsTotal,
            groupsTotal,
        };
    }

    if (contactsTotal === 0 && groupsTotal === 0) {
        row.hidden = true;
        return;
    }

    const lines = [];
    if (contactsTotal > 0) {
        lines.push(cdNamesLine('Both know', contacts.map(c => c.display_name), contactsTotal));
    }
    if (groupsTotal > 0) {
        lines.push(cdNamesLine('Both in',   groups.map(g => g.name),           groupsTotal));
    }
    txt.innerHTML = lines.join('<br>');
    row.hidden = false;
}

// Build a single line like: "Both know <b>Alice</b>, <b>Bob</b> and 3 others"
// Falls back to a count-only label if the names list is empty (e.g. the
// caller hit the 50-row cap and the first batch happens to be missing).
function cdNamesLine(prefix, names, total) {
    const cleaned = (names || []).map(n => (n || '').trim()).filter(Boolean);
    if (cleaned.length === 0) {
        return `${esc(prefix)} ${total} ${total === 1 ? 'other' : 'others'}`;
    }
    if (total === 1)         return `${esc(prefix)} <b>${esc(cleaned[0])}</b>`;
    if (total === 2 && cleaned.length >= 2) {
        return `${esc(prefix)} <b>${esc(cleaned[0])}</b> and <b>${esc(cleaned[1])}</b>`;
    }
    const showInline = Math.min(2, cleaned.length);
    const head = cleaned.slice(0, showInline).map(n => `<b>${esc(n)}</b>`).join(', ');
    const remaining = total - showInline;
    if (remaining <= 0) return `${esc(prefix)} ${head}`;
    return `${esc(prefix)} ${head} and ${remaining} ${remaining === 1 ? 'other' : 'others'}`;
}

function cdRenderHistory(events) {
    const list = document.getElementById('cd-history-list');
    if (!list) return;
    if (!events.length) {
        list.innerHTML = '<div class="cd-history-empty">No shared events yet.</div>';
        return;
    }
    const kindLabel = { nearby: 'Nearby', selfie: 'Selfie', vouch: 'Vouch', group: 'Group', intro: 'Intro' };
    list.innerHTML = events.map((h, i) => {
        const dotClass = `cd-history-dot cd-history-dot-${esc(h.kind)}`;
        const isLast = i === events.length - 1;
        return `
            <div class="cd-history-item">
                <div class="cd-history-stem">
                    <div class="${dotClass}"></div>
                    ${isLast ? '' : '<div class="cd-history-line"></div>'}
                </div>
                <div class="cd-history-content">
                    <div class="cd-history-text">${esc(h.text)}</div>
                    <div class="cd-history-when">${esc(kindLabel[h.kind] || 'Event')} \u00B7 ${esc(formatLastSeen(h.occurred_at))}</div>
                </div>
            </div>`;
    }).join('');
}

// Open the modal listing every mutual contact and shared group. Tapping a
// row navigates straight into that contact's details or that group's screen.
function cdOpenMutualsDialog(contactId, name) {
    const data = cdMutualsCache[contactId];
    const overlay = document.getElementById('modalOverlay');
    const body    = document.getElementById('modalBody');
    if (!data || !overlay || !body) return;

    const { contacts, groups, contactsTotal, groupsTotal } = data;

    const contactsHtml = (contacts || []).map(c => {
        const init = (c.display_name || '?').trim().charAt(0).toUpperCase();
        const avatar = c.profile_image_url
            ? `<img class="cd-mutuals-item-avatar" src="${esc(c.profile_image_url)}" alt="">`
            : `<div class="cd-mutuals-item-avatar cd-mutuals-item-avatar-fallback">${esc(init)}</div>`;
        return `
            <button type="button" class="cd-mutuals-item"
                    onclick="cdJumpToContact('${esc(c.id)}')">
                ${avatar}
                <span class="cd-mutuals-item-name">${esc(c.display_name || 'Unknown')}</span>
                <span class="cd-mutuals-item-chevron" aria-hidden="true">
                    <i data-lucide="chevron-right" aria-hidden="true"></i>
                </span>
            </button>`;
    }).join('');

    const groupsHtml = (groups || []).map(g => {
        const init = (g.name || '?').trim().charAt(0).toUpperCase();
        const tile = g.logo_url
            ? `<img class="cd-mutuals-item-avatar cd-mutuals-item-avatar-square" src="${esc(g.logo_url)}" alt="">`
            : `<div class="cd-mutuals-item-avatar cd-mutuals-item-avatar-square cd-mutuals-item-avatar-fallback">${esc(init)}</div>`;
        return `
            <button type="button" class="cd-mutuals-item"
                    onclick="cdJumpToGroup('${esc(g.id)}')">
                ${tile}
                <span class="cd-mutuals-item-name">${esc(g.name || 'Group')}</span>
                <span class="cd-mutuals-item-chevron" aria-hidden="true">
                    <i data-lucide="chevron-right" aria-hidden="true"></i>
                </span>
            </button>`;
    }).join('');

    const sections = [];
    if (contactsTotal > 0) {
        const cap = (contacts || []).length;
        const heading = (cap < contactsTotal)
            ? `Mutual contacts (${cap} of ${contactsTotal})`
            : `Mutual contacts (${contactsTotal})`;
        sections.push(`
            <div class="cd-mutuals-section">
                <div class="cd-mutuals-section-head">${esc(heading)}</div>
                <div class="cd-mutuals-list">${contactsHtml || '<div class="cd-mutuals-empty">None to show.</div>'}</div>
            </div>`);
    }
    if (groupsTotal > 0) {
        const cap = (groups || []).length;
        const heading = (cap < groupsTotal)
            ? `Shared groups (${cap} of ${groupsTotal})`
            : `Shared groups (${groupsTotal})`;
        sections.push(`
            <div class="cd-mutuals-section">
                <div class="cd-mutuals-section-head">${esc(heading)}</div>
                <div class="cd-mutuals-list">${groupsHtml || '<div class="cd-mutuals-empty">None to show.</div>'}</div>
            </div>`);
    }

    body.innerHTML = `
        <h3>You and ${esc(name || 'this contact')}</h3>
        <div class="cd-mutuals-dialog">
            ${sections.join('') || '<div class="cd-mutuals-empty">No mutuals yet.</div>'}
        </div>
        <div class="form-actions">
            <button type="button" class="btn btn-secondary" onclick="closeModal()">Close</button>
        </div>
    `;
    overlay.classList.remove('hidden');
    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
}

// Explain how the three components of the trust score are computed and
// surface live per-component data ("X vouches over Y time"). Pulls from the
// last cached trust summary captured in cdRenderTrust.
function cdOpenTrustInfoDialog() {
    const overlay = document.getElementById('modalOverlay');
    const body    = document.getElementById('modalBody');
    if (!overlay || !body) return;

    const t = cdLastTrustSummary || {};
    const directLine  = cdComponentLine(Number(t.direct_count)   || 0, t.direct_oldest_at);
    const mutualsLine = cdComponentLine(Number(t.mutual_vouches) || 0, t.mutuals_oldest_at);
    const trustedLine = cdComponentLine(Number(t.trusted_vouches)|| 0, t.trusted_oldest_at);

    // Weight badges reflect the caller's current preferences, falling back to
    // historical defaults when the RPC payload predates the weight feature.
    const wDirect  = cdWeightBadge(t.w_direct,  2);
    const wMutuals = cdWeightBadge(t.w_mutuals, 1);
    const wTrusted = cdWeightBadge(t.w_trusted, 3);

    body.innerHTML = `
        <h3>Trust Details</h3>
        <div class="cd-trust-info">
            <div class="cd-trust-info-item">
                <div class="cd-trust-info-data">${directLine}</div>
                <div class="cd-trust-info-body">
                    <div class="cd-trust-info-name">Direct ${wDirect}</div>
                    <div class="cd-trust-info-desc">
                        Time-decayed sum of vouches <em>you</em> have made
                        for this contact.
                    </div>
                </div>
            </div>

            <div class="cd-trust-info-item">
                <div class="cd-trust-info-data">${mutualsLine}</div>
                <div class="cd-trust-info-body">
                    <div class="cd-trust-info-name">Mutuals ${wMutuals}</div>
                    <div class="cd-trust-info-desc">
                        Time-decayed sum of vouches your mutual contacts
                        (people in both your circles) have made to either
                        of you.
                    </div>
                </div>
            </div>

            <div class="cd-trust-info-item">
                <div class="cd-trust-info-data">${trustedLine}</div>
                <div class="cd-trust-info-body">
                    <div class="cd-trust-info-name">Trusted ${wTrusted}</div>
                    <div class="cd-trust-info-desc">
                        Time-decayed sum of vouches sent to this person by
                        mutual contacts whom <em>you</em> have personally
                        given an &ldquo;I trust you&rdquo; vouch.
                    </div>
                </div>
            </div>

            <p class="cd-trust-info-lead">
                The Trust score is a weighted, time-decayed combination of
                three vouch-based signals. Every vouch counts, but vouches
                fade with age &mdash; a vouch from <strong>two years ago is
                worth half</strong> of one made today (a half-life of two
                years). The combined total maps onto a fixed 0&ndash;100
                scale where each extra helping of vouch weight closes
                <strong>half the remaining distance</strong> to 100 &mdash;
                so this score only moves when vouches involving this
                contact change.
            </p>

            <p class="cd-trust-info-foot">
                You can tune the &times; weights for each component in your
                preferences. Most vouches you receive stay private; shared
                vouch types notify you directly, and other types appear only
                as aggregate counts.
            </p>
        </div>
        <div class="form-actions">
            <button type="button" class="btn btn-secondary" onclick="closeModal()">Close</button>
        </div>
    `;
    overlay.classList.remove('hidden');
    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
}

// "× 2" badge next to a component name in the trust-info dialog. Hidden
// entirely when the weight is zero so users can clearly see when they have
// dialed a component out of their score.
function cdWeightBadge(weight, fallback) {
    const n = Number.isFinite(Number(weight)) ? Number(weight) : fallback;
    if (n <= 0) return '<span class="cd-trust-info-weight cd-trust-info-weight-off" title="Disabled in preferences">&times;0</span>';
    const label = Number.isInteger(n) ? String(n) : n.toFixed(1);
    return `<span class="cd-trust-info-weight">&times;${label}</span>`;
}

// "N vouches over Y time" / "1 vouch, just now" / "no vouches yet"
// for a single trust-score component. `oldestIso` is the timestamp of the
// oldest contributing vouch; we render the elapsed time since then. The
// numeric count is wrapped in <strong> so the data band in the trust-info
// dialog can visually emphasize the per-contact figure.
function cdComponentLine(count, oldestIso) {
    if (!count || count <= 0) return 'no vouches yet';
    const noun = count === 1 ? 'vouch' : 'vouches';
    const span = cdFormatDurationFrom(oldestIso);
    if (!span) return `<strong>${count}</strong> ${noun}`;
    if (count === 1) return `<strong>1</strong> vouch, ${span} ago`;
    return `<strong>${count}</strong> ${noun} over ${span}`;
}

// Calendar-aware "2 years, 4 months" / "5 days" / "3 hours" / "just now"
// elapsed-time formatter. Mirrors formatKnownDuration's year+month style for
// long spans but also handles sub-month durations needed by the trust info
// dialog.
function cdFormatDurationFrom(isoDate) {
    if (!isoDate) return '';
    const start = new Date(isoDate);
    if (isNaN(start.getTime())) return '';
    const now = new Date();
    const ms = now.getTime() - start.getTime();
    if (ms < 60 * 1000) return 'just now';
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) return minutes === 1 ? '1 minute' : `${minutes} minutes`;
    const hours = Math.floor(ms / 3600000);
    if (hours < 24) return hours === 1 ? '1 hour' : `${hours} hours`;
    const days = Math.floor(ms / 86400000);
    if (days < 30) return days === 1 ? '1 day' : `${days} days`;
    let years = now.getFullYear() - start.getFullYear();
    let months = now.getMonth() - start.getMonth();
    if (now.getDate() < start.getDate()) months--;
    if (months < 0) { years--; months += 12; }
    if (years === 0 && months === 0) {
        return days === 1 ? '1 day' : `${days} days`;
    }
    const parts = [];
    if (years  > 0) parts.push(years  === 1 ? '1 year'  : `${years} years`);
    if (months > 0) parts.push(months === 1 ? '1 month' : `${months} months`);
    return parts.join(', ');
}

function cdJumpToContact(contactId) {
    if (!contactId) return;
    closeModal({ refreshContactList: false });
    navigateTo('contactDetails', contactId);
}

function cdJumpToGroup(groupId) {
    if (!groupId) return;
    closeModal({ refreshContactList: false });
    navigateTo('groups');
    if (typeof selectGroupById === 'function') selectGroupById(groupId);
}

// ----- Vouch (delegates to existing 5-choice modal) --------------------------

function cdOnVouchClick(contactId, name) {
    openVouchWithContact(contactId, name);
}

function cdSetVouchedState(vouched) {
    const btn = document.getElementById('cd-vouch-btn');
    if (!btn) return;
    btn.classList.toggle('cd-action-filled', !!vouched);
    const label = btn.querySelector('.cd-action-label');
    if (label) label.textContent = 'Vouch';
}

function cdOnAttested(contactId) {
    if (cdCurrentContactId !== contactId) return;
    cdSetVouchedState(true);
    cdFireConfetti();
    cdHaptic();
    // Bump stats: refetch trust summary in the background.
    db.rpc('get_contact_trust_summary', { p_contact_id: contactId })
        .then(({ data }) => {
            if (cdCurrentContactId !== contactId || !data) return;
            cdRenderTrust(data);
        }).catch(() => {});
}

window.addEventListener('union:attested', (e) => {
    if (e?.detail?.contactId) cdOnAttested(e.detail.contactId);
});

// ----- Toggles ---------------------------------------------------------------

async function cdOnToggleNotify(contactId) {
    const row = (contactsLoadedRows || []).find(r => r.contact?.contact_id === contactId);
    const next = !(row?.contact?.notify_nearby);
    cdSetSwitch('cd-toggle-notify', next);
    if (row?.contact) row.contact.notify_nearby = next;
    try {
        await toggleNotifyNearby(contactId, next);
    } catch (e) {
        cdSetSwitch('cd-toggle-notify', !next);
        if (row?.contact) row.contact.notify_nearby = !next;
    }
}

function cdIntroIcon() {
    return cdLucideIcon('users');
}

function cdOpenIntroModal() {
    if (!cdCurrentContactId) return;
    const row = (contactsLoadedRows || []).find(r => r.contact?.contact_id === cdCurrentContactId);
    introSubjectContactId = cdCurrentContactId;
    introSubjectContactName = (row?.profile?.display_name) || 'contact';
    showModal('introContact');
}

function cdOutboundPhoneOn(row) {
    const sbm = row?.sharedByMe || {};
    return sbm.shared_phone != null && String(sbm.shared_phone).trim() !== '';
}

function cdOutboundEmailOn(row) {
    const sbm = row?.sharedByMe || {};
    return sbm.shared_email != null && String(sbm.shared_email).trim() !== '';
}

async function cdOnToggleShareEmail(contactId) {
    if (!contactId || !currentUser || !currentProfile?.email) return;
    const row = (contactsLoadedRows || []).find(r => r.contact?.contact_id === contactId);
    if (!row) return;
    const wantEmail = !cdOutboundEmailOn(row);
    const wantPhone = cdOutboundPhoneOn(row);
    await saveOutboundProfileShareForContact(contactId, wantPhone, wantEmail);
    const row2 = (contactsLoadedRows || []).find(r => r.contact?.contact_id === contactId);
    cdSetSwitch('cd-toggle-share-email', cdOutboundEmailOn(row2));
    cdSetSwitch('cd-toggle-share-phone', cdOutboundPhoneOn(row2));
}

async function cdOnToggleSharePhone(contactId) {
    if (!contactId || !currentUser || !currentProfile?.phone) return;
    const row = (contactsLoadedRows || []).find(r => r.contact?.contact_id === contactId);
    if (!row) return;
    const wantPhone = !cdOutboundPhoneOn(row);
    const wantEmail = cdOutboundEmailOn(row);
    await saveOutboundProfileShareForContact(contactId, wantPhone, wantEmail);
    const row2 = (contactsLoadedRows || []).find(r => r.contact?.contact_id === contactId);
    cdSetSwitch('cd-toggle-share-email', cdOutboundEmailOn(row2));
    cdSetSwitch('cd-toggle-share-phone', cdOutboundPhoneOn(row2));
}

function cdOnToggleShareLoc(contactId) {
    const isOn = !!locationSharesOutbound[contactId];
    cdSetSwitch('cd-toggle-share', !isOn);
    // Defer to existing handler — it pops the duration modal when turning ON
    // (and silently stops when turning OFF). On modal cancel we'll reset.
    toggleShareLocation(contactId, !isOn);
}

function cdSetSwitch(rowId, on) {
    const rowEl = document.getElementById(rowId);
    if (!rowEl) return;
    const sw = rowEl.querySelector('.cd-switch');
    const ic = rowEl.querySelector('.cd-toggle-icon');
    if (sw) sw.classList.toggle('cd-switch-on', !!on);
    if (ic) ic.classList.toggle('cd-toggle-icon-on', !!on);
}

// Re-sync our location toggle when share state changes elsewhere
// (duration-modal confirm, expiration timer, realtime push, etc.).
window.addEventListener('union:locationShareChanged', () => {
    if (!cdCurrentContactId) return;
    cdSetSwitch('cd-toggle-share', !!locationSharesOutbound[cdCurrentContactId]);
    // Inbound shares may also have changed → refresh the sharing-location pane.
    cdRenderSharingLocationPane(cdCurrentContactId);
});

// The contact-locations cache refreshed (positions arrived from the server).
window.addEventListener('union:contactLocationsLoaded', () => {
    if (!cdCurrentContactId) return;
    cdRenderSharingLocationPane(cdCurrentContactId);
});

// ----- Sharing-location pane (only when they share with us) ------------------

function cdRenderSharingLocationPane(contactId) {
    const slot = document.getElementById('cd-sharing-location-slot');
    if (!slot) return;
    const isInbound = !!locationSharesInbound[contactId];
    if (!isInbound) { slot.innerHTML = ''; return; }

    const row  = (contactsLoadedRows || []).find(r => r.contact?.contact_id === contactId);
    const name = row?.profile?.display_name || 'Contact';
    const loc  = contactLocationsCache[contactId];

    const locKey = loc ? cdLocationKey(loc) : '';
    const updatedText = loc?.updated_at ? 'Updated ' + formatLastSeen(loc.updated_at) : 'Waiting for location\u2026';

    // The 60s inbound location poll re-fires `union:contactLocationsLoaded`
    // even when nothing about this contact's position has changed. Without
    // this short-circuit we'd blow away the headline text on every tick and
    // re-run the GPS + reverse-geocode round trip, which presents to the
    // user as a "Locating…" flash every minute.
    const existingHeadline = document.getElementById('cd-sharing-loc-headline');
    if (locKey && existingHeadline && existingHeadline.dataset.locKey === locKey) {
        const updatedEl = document.getElementById('cd-sharing-loc-updated');
        if (updatedEl) updatedEl.textContent = updatedText;
        return;
    }

    // We already have the contact's coordinates by the time we render this
    // card (otherwise we'd take the "No location yet" branch). The placeholder
    // covers the brief moment while we reverse-geocode their position into a
    // city label and compute "X miles away" from our own GPS fix.
    const headlinePlaceholder = loc ? 'Calculating distance\u2026' : 'No location yet';

    slot.innerHTML = `
        <button type="button" class="cd-card cd-sharing-loc-card"
                onclick="cdOpenSharingLocation('${esc(contactId)}', '${esc(name)}')"
                ${loc ? '' : 'disabled aria-disabled="true"'}>
            <div class="cd-sharing-loc-tile" aria-hidden="true">${cdMapTileSvg()}</div>
            <div class="cd-sharing-loc-body">
                <div class="cd-sharing-loc-overline">
                    <span class="cd-sharing-loc-dot"></span>
                    Sharing location
                </div>
                <div class="cd-sharing-loc-headline" id="cd-sharing-loc-headline" data-loc-key="${esc(locKey)}">${esc(headlinePlaceholder)}</div>
                <div class="cd-sharing-loc-updated" id="cd-sharing-loc-updated">${esc(updatedText)}</div>
            </div>
            ${loc ? `<span class="cd-sharing-loc-view">
                View
                <i data-lucide="chevron-right" aria-hidden="true"></i>
            </span>` : ''}
        </button>
    `;

    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();

    if (loc) cdHydrateSharingLocationPane(contactId, loc);
}

async function cdHydrateSharingLocationPane(contactId, loc) {
    const locKey = cdLocationKey(loc);

    let miles = null;
    let label = '';

    // Write whatever parts we already have. Called twice — once when the
    // (typically fast) reverse-geocode resolves, once when the GPS fix lands.
    // This way the user sees "Denver, CO" within a beat instead of a 10s
    // "Locating…" while we wait for a fresh fix to compute the distance.
    const writeHeadline = () => {
        if (cdCurrentContactId !== contactId) return;
        const headlineEl = document.getElementById('cd-sharing-loc-headline');
        if (!headlineEl) return;
        if (headlineEl.dataset.locKey !== locKey) return;
        const distanceText = miles != null ? formatDistance(miles, { compact: true }) : '';
        const parts = [distanceText, label].filter(Boolean);
        if (!parts.length) return;
        headlineEl.textContent = parts.join(' \u00B7 ');
    };

    // Reverse-geocode the contact's location into a place label. Their lat/lng
    // is already known from the cache, so this can render without waiting on
    // our own GPS fix.
    const labelPromise = reverseGeocode(loc.lat, loc.lng)
        .then(result => {
            label = result || '';
            writeHeadline();
        })
        .catch(() => { /* non-critical */ });

    // Distance from me — best effort, with a relaxed cache window so we don't
    // block the UI for up to 12s on the native freshFixDeadline. A fix that's
    // a few minutes old is fine for "X miles away".
    const milesPromise = getGPSLocation({ maxAgeMs: APP_TIMING.RELAXED_GPS_MAX_AGE_MS })
        .then(myPos => {
            if (!myPos || cdCurrentContactId !== contactId) return;
            miles = haversineDistance(myPos.lat, myPos.lng, loc.lat, loc.lng);
            writeHeadline();
        })
        .catch(() => { /* non-critical */ });

    await Promise.allSettled([labelPromise, milesPromise]);

    // Final fallback: if neither side produced anything (no network for
    // Nominatim and no cached GPS fix), surface a generic but non-misleading
    // string so the headline doesn't get stuck on the placeholder.
    if (cdCurrentContactId !== contactId) return;
    const headlineEl = document.getElementById('cd-sharing-loc-headline');
    if (!headlineEl) return;
    if (headlineEl.dataset.locKey !== locKey) return;
    if (miles == null && !label) {
        headlineEl.textContent = 'Location available';
    }
}

function cdLocationKey(loc) {
    if (!loc) return '';
    return [loc.lat, loc.lng, loc.updated_at || ''].join('|');
}

function cdOpenSharingLocation(contactId, name) {
    if (!contactLocationsCache[contactId]) return;
    openContactLocationFullscreen(contactId, name);
}

function cdMapTileSvg() {
    // Stylised square map illustration with a pin — matches the design tile.
    return '<svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">'
        + '<rect width="64" height="64" rx="12" fill="#DCE6ED"/>'
        + '<g stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" opacity="0.9">'
        +   '<path d="M0 22 H64"/>'
        +   '<path d="M0 42 H64"/>'
        +   '<path d="M22 0 V64"/>'
        +   '<path d="M44 0 V64"/>'
        + '</g>'
        + '<circle cx="32" cy="32" r="8" fill="#3B7CA0"/>'
        + '<circle cx="32" cy="32" r="3" fill="#DCE6ED"/>'
        + '</svg>';
}

// ----- Met-on date save ------------------------------------------------------

function cdHeroKnownLineText(firstMetIso, createdAtIso) {
    const since = firstMetIso || createdAtIso || null;
    const dur = formatKnownDuration(since);
    if (dur) return `Known ${dur}`;
    // Sub-month spans: formatKnownDuration returns '' once we're under a
    // month, so fall back to a day count for brand-new / recent contacts.
    if (since) {
        const start = new Date(since);
        if (!isNaN(start.getTime())) {
            const days = Math.max(0, Math.floor((Date.now() - start.getTime()) / 86400000));
            if (days === 0) return 'Known since today';
            return days === 1 ? 'Known 1 day' : `Known ${days} days`;
        }
    }
    return 'Known';
}

function cdSaveMetOn(contactId, value) {
    saveFirstMetAt(contactId, value);
    const display = document.getElementById('cd-hero-known-display');
    if (!display) return;
    const row = (contactsLoadedRows || []).find(r => r.contact?.contact_id === contactId);
    const iso = value ? new Date(value + 'T12:00:00').toISOString() : null;
    const created = row?.contact?.created_at || null;
    display.textContent = cdHeroKnownLineText(iso || null, created);
}

// ----- Confetti + haptics ----------------------------------------------------

function cdFireConfetti() {
    const root = document.getElementById('contactDetailsScreen');
    if (!root) return;
    const layer = document.createElement('div');
    layer.className = 'cd-confetti-layer';
    const colors = ['#E3AD4F', '#3B7CA0', '#5CA68A', '#E38B7E'];
    let html = '';
    for (let i = 0; i < 30; i++) {
        const left = Math.random() * 100;
        const delay = Math.random() * 0.3;
        const rot = Math.random() * 360;
        const color = colors[i % colors.length];
        html += `<div class="cd-confetti-piece" style="left:${left}%;background:${color};transform:rotate(${rot}deg);animation-delay:${delay.toFixed(2)}s;"></div>`;
    }
    layer.innerHTML = html;
    root.appendChild(layer);
    if (cdConfettiTimer) clearTimeout(cdConfettiTimer);
    cdConfettiTimer = setTimeout(() => {
        try { layer.remove(); } catch (_) {}
        cdConfettiTimer = null;
    }, APP_TIMING.CONFETTI_CLEANUP_MS);
}

function cdHaptic() {
    if (!IS_NATIVE) return;
    try {
        const Haptics = window.Capacitor?.Plugins?.Haptics;
        if (!Haptics) return;
        // ImpactStyle.Medium — accept either string or object form.
        if (typeof Haptics.impact === 'function') {
            Haptics.impact({ style: 'MEDIUM' }).catch(() => {});
        }
    } catch (_) { /* haptics are best-effort */ }
}

// ----- Close / back ----------------------------------------------------------

function closeContactDetailsScreen() {
    cdCurrentContactId = null;
    if (cdConfettiTimer) { clearTimeout(cdConfettiTimer); cdConfettiTimer = null; }
    navigateTo('contacts');
}

function cdCopyContactEmailFromBtn(btn) {
    const encoded = btn?.getAttribute('data-email');
    if (!encoded) return;
    let addr = encoded;
    try {
        addr = decodeURIComponent(encoded);
    } catch (_) { /* keep encoded */ }
    if (!addr) return;
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(addr).then(() => {
            if (typeof showToast === 'function') showToast('Email copied', 'success');
        }).catch(() => {
            if (typeof showToast === 'function') showToast('Could not copy email', 'error');
        });
    } else if (typeof showToast === 'function') {
        showToast('Could not copy email', 'error');
    }
}

// ----- Helpers ---------------------------------------------------------------

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function firstName(s) {
    if (!s) return 'them';
    return String(s).trim().split(/\s+/)[0];
}

// Patch the hero avatar on the Contact Details screen when the contact's
// profile picture changes. No-ops unless the details screen is currently
// showing this contact. Uses cacheBust (e.g. notification timestamp) to defeat
// HTTP caching when the storage URL stays the same across replacements.
function cdUpdateHeroAvatar(contactId, avatarUrl, cacheBust) {
    if (!contactId) return;
    if (typeof cdCurrentContactId === 'undefined' || cdCurrentContactId !== contactId) return;
    const heroEl = document.querySelector('#contactDetailsScreen .cd-hero-avatar');
    if (!heroEl) return;

    const row = (typeof contactsLoadedRows !== 'undefined' ? contactsLoadedRows : [])
        .find(r => r.contact?.contact_id === contactId);
    const name = row?.profile?.display_name || 'Unknown';
    const displayUrl = avatarUrl ? withImageCacheBust(avatarUrl, cacheBust) : null;

    if (displayUrl) {
        const onclickAttr = `event.stopPropagation(); cdOpenAvatarLightbox('${esc(contactId)}', '${esc(displayUrl)}', '${esc(name)}')`;
        if (heroEl.tagName === 'IMG') {
            heroEl.src = displayUrl;
            heroEl.setAttribute('onclick', onclickAttr);
        } else {
            const img = document.createElement('img');
            img.className = 'cd-hero-avatar';
            img.src = displayUrl;
            img.alt = '';
            img.setAttribute('onclick', onclickAttr);
            heroEl.replaceWith(img);
        }
    } else {
        const initial = (name || '?').trim().charAt(0).toUpperCase() || '?';
        const placeholder = document.createElement('div');
        placeholder.className = 'cd-hero-avatar cd-hero-avatar-fallback';
        placeholder.textContent = initial;
        placeholder.title = 'Suggest a profile picture';
        placeholder.setAttribute('onclick', `event.stopPropagation(); openSuggestPicture('${esc(contactId)}')`);
        heroEl.replaceWith(placeholder);
    }
}

// Patch hero name (and placeholder initial) on Contact Details when their display name changes.
function cdUpdateHeroDisplayName(contactId, displayName) {
    if (!contactId) return;
    if (typeof cdCurrentContactId === 'undefined' || cdCurrentContactId !== contactId) return;
    const safeName = displayName || 'Unknown';
    const row = (typeof contactsLoadedRows !== 'undefined' ? contactsLoadedRows : [])
        .find(r => r.contact?.contact_id === contactId);
    if (row) {
        if (!row.profile) row.profile = {};
        row.profile.display_name = safeName;
    }
    const nameEl = document.querySelector('#contactDetailsScreen .cd-hero-name');
    if (nameEl) nameEl.textContent = safeName;
    const heroPh = document.querySelector('#contactDetailsScreen .cd-hero-avatar-fallback');
    if (heroPh) {
        const initial = (safeName || '?').trim().charAt(0).toUpperCase() || '?';
        heroPh.textContent = initial;
    }
    const heroImg = document.querySelector('#contactDetailsScreen img.cd-hero-avatar');
    if (heroImg) {
        const url = heroImg.getAttribute('src') || '';
        const onclickAttr = `event.stopPropagation(); cdOpenAvatarLightbox('${esc(contactId)}', '${esc(url)}', '${esc(safeName)}')`;
        heroImg.setAttribute('onclick', onclickAttr);
    }
}

// Open the lightbox on a contact's avatar with a "Suggest a new picture"
// action button, restoring the feature that lived on the old inline-expanded
// contact card.
function cdOpenAvatarLightbox(contactId, avatarUrl, _name) {
    openLightbox(avatarUrl, '', '', [
        {
            label: 'Suggest a new picture',
            variant: 'primary',
            onClick: () => {
                closeLightbox();
                openSuggestPicture(contactId);
            }
        }
    ]);
}

// Lucide placeholders — hydrated by refreshLucideIcons() after DOM updates.
function cdLucideIcon(name, extraClass) {
    const cls = extraClass ? ` class="${extraClass}"` : '';
    return `<i data-lucide="${name}"${cls} aria-hidden="true"></i>`;
}
function cdPencilIcon() {
    return cdLucideIcon('pencil');
}
function cdShieldIcon() {
    return cdLucideIcon('shield-check');
}
function cdShareIcon() {
    return cdLucideIcon('share');
}
function cdPhoneIcon() {
    return cdLucideIcon('phone');
}
function cdMessageIcon() {
    return cdLucideIcon('message-circle');
}
function cdCameraIcon() {
    return cdLucideIcon('camera');
}
function cdNearIcon() {
    return cdLucideIcon('radar');
}
function cdInfoIcon() {
    return cdLucideIcon('info');
}
function cdLocationIcon() {
    return cdLucideIcon('map-pin');
}
