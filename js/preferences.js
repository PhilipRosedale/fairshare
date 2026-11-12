function openPreferences() {
    if (!currentUser) return;
    navigateTo('profile');
}

// Default weights match the original hard-coded values in
// get_contact_trust_summary; the SQL columns also default to these so a NULL
// profile value still produces the historical 2 / 1 / 3 behaviour.
const TRUST_WEIGHT_DEFAULTS = Object.freeze({
    direct:  2,
    mutuals: 1,
    trusted: 3,
});

// The dropdown only exposes integer multipliers 1..5. Legacy / out-of-range
// stored values (e.g. 0 or fractional weights from an older build) get snapped
// onto the nearest valid choice so a <select> always has a matching option.
const TRUST_WEIGHT_CHOICES = Object.freeze([1, 2, 3, 4, 5]);

function snapTrustWeight(val, fallback) {
    const n = Number(val);
    if (!Number.isFinite(n)) return fallback;
    const rounded = Math.round(n);
    return Math.min(5, Math.max(1, rounded));
}

function trustWeightOptionsHtml(selected) {
    return TRUST_WEIGHT_CHOICES.map(v =>
        `<option value="${v}"${v === selected ? ' selected' : ''}>${v}x</option>`
    ).join('');
}

function setTrustWeightInputs(direct, mutuals, trusted) {
    const d = document.getElementById('prefWeightDirect');
    const m = document.getElementById('prefWeightMutuals');
    const t = document.getElementById('prefWeightTrusted');
    if (d) d.value = String(snapTrustWeight(direct,  TRUST_WEIGHT_DEFAULTS.direct));
    if (m) m.value = String(snapTrustWeight(mutuals, TRUST_WEIGHT_DEFAULTS.mutuals));
    if (t) t.value = String(snapTrustWeight(trusted, TRUST_WEIGHT_DEFAULTS.trusted));
}

function resetTrustWeights() {
    setTrustWeightInputs(
        TRUST_WEIGHT_DEFAULTS.direct,
        TRUST_WEIGHT_DEFAULTS.mutuals,
        TRUST_WEIGHT_DEFAULTS.trusted
    );
    savePreferences();
}

function sponsoredAgoLabel(createdAt) {
    if (!createdAt) return 'Sponsor';
    const now = new Date();
    const created = new Date(createdAt);
    const diffMs = now - created;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays < 1) return 'Sponsored today';
    if (diffDays < 30) return `Sponsored ${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
    let years = now.getFullYear() - created.getFullYear();
    let months = now.getMonth() - created.getMonth();
    if (now.getDate() < created.getDate()) months--;
    if (months < 0) { years--; months += 12; }
    if (years > 0 && months > 0) return `Sponsored ${years} year${years === 1 ? '' : 's'}, ${months} month${months === 1 ? '' : 's'} ago`;
    if (years > 0) return `Sponsored ${years} year${years === 1 ? '' : 's'} ago`;
    return `Sponsored ${months} month${months === 1 ? '' : 's'} ago`;
}

function renderProfileScreen() {
    const container = document.getElementById('profileScreenContent');
    if (!container || !currentUser) return;

    container.innerHTML = `
        <div class="card">
            <div class="profile-screen-header">
                <h2>Public Profile</h2>
            </div>
            <form id="preferencesForm">
                <div class="pref-profile-row">
                    <div id="prefPhotoPreview" class="contact-selfie-wrap pref-photo-preview" onclick="document.getElementById('prefPhotoInput').click()"><i data-lucide="camera" aria-hidden="true"></i></div>
                    <input type="file" id="prefPhotoInput" accept="image/*" style="display:none;">
                    <div class="form-group pref-display-name-group">
                        <label for="prefDisplayName">Display Name</label>
                        <input type="text" id="prefDisplayName" placeholder="Your public name" maxlength="80">
                        <p class="pref-help-text">Shared with contacts, who will vouch for its accuracy.</p>
                    </div>
                </div>
                <div class="form-group pref-contact-field">
                    <label for="prefEmail">Email</label>
                    <input type="email" id="prefEmail" placeholder="you@example.com">
                </div>
                <div class="form-group pref-contact-field">
                    <label for="prefPhone">Phone</label>
                    <input type="tel" id="prefPhone" placeholder="+1 234 567 8900">
                </div>
                <p class="pref-help-text pref-contact-hint">(You choose when to share these)</p>
                <div class="pref-sponsor-card">
                    <div id="prefSponsorAvatar" class="pref-sponsor-avatar"><i data-lucide="user-round" aria-hidden="true"></i></div>
                    <div>
                        <div class="pref-sponsor-label">${sponsoredAgoLabel(currentProfile?.created_at)}</div>
                        <div id="prefSponsorName" class="pref-sponsor-name">Loading sponsor...</div>
                    </div>
                </div>
                <hr class="pref-divider">
                <h4 class="pref-section-title">Preferences</h4>
                ${canUsePush() ? `
                <div class="form-group pref-checkbox-row">
                    <input type="checkbox" id="prefPushNotifications" style="flex-shrink:0;">
                    <label for="prefPushNotifications" style="margin:0;">Push Notifications</label>
                </div>
                <p id="prefPushHint" class="pref-help-text pref-push-hint"></p>
                ` : ''}
                <div class="pref-trust-weights">
                    <div class="pref-trust-weights-head">
                        <label class="pref-trust-weights-label">Trust Score Weights</label>
                        <a href="#" class="pref-trust-weights-reset" onclick="resetTrustWeights(); return false;">Reset</a>
                    </div>
                    <p class="pref-help-text pref-trust-weights-hint">
                        How much each component contributes to a contact's trust score.
                    </p>
                    <div class="pref-trust-weights-row">
                        <div class="pref-trust-weight">
                            <label for="prefWeightDirect">Direct</label>
                            <select id="prefWeightDirect">${trustWeightOptionsHtml(snapTrustWeight(currentProfile?.trust_weight_direct, TRUST_WEIGHT_DEFAULTS.direct))}</select>
                        </div>
                        <div class="pref-trust-weight">
                            <label for="prefWeightMutuals">Mutuals</label>
                            <select id="prefWeightMutuals">${trustWeightOptionsHtml(snapTrustWeight(currentProfile?.trust_weight_mutuals, TRUST_WEIGHT_DEFAULTS.mutuals))}</select>
                        </div>
                        <div class="pref-trust-weight">
                            <label for="prefWeightTrusted">Trusted</label>
                            <select id="prefWeightTrusted">${trustWeightOptionsHtml(snapTrustWeight(currentProfile?.trust_weight_trusted, TRUST_WEIGHT_DEFAULTS.trusted))}</select>
                        </div>
                    </div>
                </div>
            </form>
            <hr class="pref-divider">
            <h4 class="pref-section-title">Safety</h4>
            <div class="pref-link-row">
                <a href="#" class="pref-link" onclick="openBlockedUsersModal(); return false;">Manage blocked users</a>
            </div>
            <hr class="pref-divider">
            <h4 class="pref-section-title">Legal & Account</h4>
            <div class="pref-link-row">
                <a href="#" class="pref-link" onclick="openPrivacyPolicy(); return false;">Privacy Policy</a>
                <a href="#" class="pref-link" onclick="openTermsOfUse(); return false;">Terms of Use</a>
            </div>
            <div class="pref-danger-row">
                <button type="button" class="btn btn-danger pref-delete-btn" onclick="openDeleteAccountModal()">Delete Account</button>
                <p class="pref-help-text">Permanently removes your account and all your data. This cannot be undone.</p>
            </div>
            <div class="screen-version" aria-hidden="true">${esc(window.BUILD_VERSION || '')}</div>
        </div>
    `;

    document.getElementById('prefDisplayName').value = currentProfile?.display_name || '';
    document.getElementById('prefEmail').value = currentProfile?.email || '';
    document.getElementById('prefPhone').value = currentProfile?.phone || '';
    setTrustWeightInputs(
        currentProfile?.trust_weight_direct,
        currentProfile?.trust_weight_mutuals,
        currentProfile?.trust_weight_trusted
    );

    const prefPreview = document.getElementById('prefPhotoPreview');
    if (currentProfile?.profile_image_url) {
        const img = document.createElement('img');
        img.src = currentProfile.profile_image_url;
        img.style.width = img.style.height = '100%';
        img.style.objectFit = 'cover';
        prefPreview.innerHTML = '';
        prefPreview.appendChild(img);
    }

    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();

    document.getElementById('prefPhotoInput').addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const url = URL.createObjectURL(file);
        prefPreview.innerHTML = '';
        const img = document.createElement('img');
        img.src = url;
        img.style.width = img.style.height = '100%';
        img.style.objectFit = 'cover';
        prefPreview.appendChild(img);
        prefPreview._pendingFile = file;
        savePreferences();
    });

    document.getElementById('preferencesForm').addEventListener('submit', (e) => savePreferences(e));

    document.getElementById('prefDisplayName').addEventListener('change', () => savePreferences());
    document.getElementById('prefEmail').addEventListener('change', () => savePreferences());
    document.getElementById('prefPhone').addEventListener('change', () => savePreferences());

    const pushCheck = document.getElementById('prefPushNotifications');
    if (pushCheck) pushCheck.addEventListener('change', () => savePreferences());

    ['prefWeightDirect', 'prefWeightMutuals', 'prefWeightTrusted'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', () => savePreferences());
    });

    (async () => {
        const sponsorNameEl = document.getElementById('prefSponsorName');
        const sponsorAvatarEl = document.getElementById('prefSponsorAvatar');
        if (!sponsorNameEl || !sponsorAvatarEl) return;
        try {
            if (currentProfile?.sponsor_id) {
                const { data: sp } = await db.from('profiles').select('display_name, profile_image_url').eq('id', currentProfile.sponsor_id).single();
                const sponsorName = sp?.display_name || 'Unknown';
                sponsorNameEl.textContent = sponsorName;
                if (sp?.profile_image_url) {
                    sponsorAvatarEl.innerHTML = `<img src="${esc(sp.profile_image_url)}" alt="${esc(sponsorName)}">`;
                } else {
                    sponsorAvatarEl.textContent = sponsorName.charAt(0).toUpperCase() || '';
                }
            } else {
                sponsorNameEl.textContent = 'Root user (no sponsor)';
                sponsorAvatarEl.textContent = '★';
            }
        } catch (_) {
            sponsorNameEl.textContent = '';
            sponsorAvatarEl.innerHTML = '<i data-lucide="user-round" aria-hidden="true"></i>';
        }
        if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
    })();

    if (canUsePush()) {
        const pushCheck = document.getElementById('prefPushNotifications');
        const pushHint = document.getElementById('prefPushHint');
        isPushSubscribed().then(subscribed => {
            const prefEnabled = currentProfile?.push_notifications !== false;
            pushCheck.checked = prefEnabled && subscribed;
            if (!IS_NATIVE && Notification.permission === 'denied') {
                pushCheck.disabled = true;
                pushHint.textContent = 'Notifications are blocked by your browser. Enable them in your browser settings.';
            } else if (!subscribed && prefEnabled) {
                pushHint.textContent = 'Enable to receive notifications when the app is closed.';
            }
        });
    }
}

// ---- Privacy / Terms links --------------------------------------------------

function openPrivacyPolicy() {
    openExternalUrl(PUBLIC_APP_ORIGIN + '/privacy.html');
}

function openTermsOfUse() {
    openExternalUrl(PUBLIC_APP_ORIGIN + '/terms.html');
}

// Open an external URL in the system browser. On the Capacitor iOS shell
// `window.location` would replace the WebView; using App.openUrl (when
// available) or window.open with _system / _blank pops Safari instead.
function openExternalUrl(url) {
    if (!url) return;
    try {
        const App = IS_NATIVE ? window.Capacitor?.Plugins?.App : null;
        if (App && typeof App.openUrl === 'function') {
            App.openUrl({ url }).catch(() => window.open(url, '_blank'));
            return;
        }
    } catch (_) { /* fall through to window.open */ }
    window.open(url, '_blank', 'noopener');
}

// ---- Delete Account ---------------------------------------------------------

function openDeleteAccountModal() {
    const overlay = document.getElementById('modalOverlay');
    const body = document.getElementById('modalBody');
    if (!overlay || !body) return;
    const confirmWord = 'DELETE';
    body.innerHTML = `
        <h3>Delete your account?</h3>
        <p style="font-size:0.92rem;color:var(--dark-gray);margin-bottom:0.75rem;">
            This permanently removes your profile, contacts, group memberships, messages, photos, and location data.
            <strong>It cannot be undone.</strong>
        </p>
        <p style="font-size:0.92rem;color:var(--dark-gray);margin-bottom:0.75rem;">
            Type <strong>${confirmWord}</strong> below to confirm.
        </p>
        <div class="form-group">
            <input type="text" id="deleteAccountConfirmInput" autocomplete="off" autocapitalize="characters"
                   placeholder="Type ${confirmWord} to confirm"
                   oninput="onDeleteAccountConfirmChange(this.value)">
        </div>
        <div class="form-actions">
            <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
            <button type="button" class="btn btn-danger" id="deleteAccountConfirmBtn" disabled
                    onclick="confirmDeleteAccount()">Delete my account</button>
        </div>
    `;
    overlay.classList.remove('hidden');
    setTimeout(() => {
        const input = document.getElementById('deleteAccountConfirmInput');
        if (input) input.focus();
    }, 0);
}

function onDeleteAccountConfirmChange(value) {
    const btn = document.getElementById('deleteAccountConfirmBtn');
    if (!btn) return;
    btn.disabled = (value || '').trim().toUpperCase() !== 'DELETE';
}

async function confirmDeleteAccount() {
    const btn = document.getElementById('deleteAccountConfirmBtn');
    if (!btn || btn.disabled) return;
    if (!currentUser) return;

    btn.disabled = true;
    btn.textContent = 'Deleting…';

    try {
        const { data, error } = await db.rpc('delete_my_account');
        if (error) throw error;
        if (data?.error) throw new Error(data.error);

        showToast('Your account has been deleted.', 'success');
        closeModal();

        // Tear down realtime / location pipelines and return to the
        // auth screen exactly the way logout() does. The auth user is
        // already gone server-side, so signOut won't actually reach
        // the network — that's fine, we just want to clear local state.
        await logout();
    } catch (e) {
        console.error('Delete account failed:', e);
        showToast('Could not delete account: ' + (e.message || 'unknown error'), 'error');
        btn.disabled = false;
        btn.textContent = 'Delete my account';
    }
}
