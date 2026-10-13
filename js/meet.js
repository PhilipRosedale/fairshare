let currentMeetUrl = null;
let currentMeetToken = null;
let currentMeetRequestId = null;
let pendingMeetUsedById = null;
let meetScanTimer = null;
let meetStream = null;
let meetChannel = null;
let meetHandled = false; // prevent duplicate scans
let currentMeetGroup = null; // { groupId, groupName, message } when sponsoring

async function openMeetScreen(options) {
    if (!currentUser) return;

    meetHandled = false;
    currentMeetGroup = options?.groupId
        ? { groupId: options.groupId, groupName: options.groupName, message: options.message }
        : null;

    // 1. Request camera FIRST — iOS Safari requires getUserMedia to be called
    //    in the direct user-gesture call stack (before any await to network).
    //    Use ideal facingMode so it falls back gracefully on all devices.
    let cameraOk = false;
    try {
        meetStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'user' }, width: { ideal: 640 }, height: { ideal: 480 } }
        });
        cameraOk = true;
    } catch (camErr) {
        console.warn('[meet] Camera access denied or unavailable:', camErr);
    }

    // 2. Show the overlay immediately (camera preview + loading QR)
    document.getElementById('meetOverlay').classList.remove('hidden');
    // document.getElementById('meetScanHint').textContent = cameraOk
    //     ? '(Show your phones to each other)'
    //     : 'Camera unavailable — ask the other person to scan your code';
    document.getElementById('meetScanHint').textContent = cameraOk
        ? 'Point your selfie camera at a friend\u2019s screen to scan QR code'
        : 'Camera unavailable — ask the other person to scan your code';
    document.getElementById('meetQrBox').innerHTML =
        '<div style="color:var(--dark-gray);font-size:0.85rem;padding:1rem;">Loading…</div>';

    // Show group context badge when sponsoring
    const groupBadge = document.getElementById('meetGroupBadge');
    if (groupBadge) {
        if (currentMeetGroup) {
            groupBadge.textContent = 'Sponsoring to ' + currentMeetGroup.groupName;
            groupBadge.style.display = '';
        } else {
            groupBadge.textContent = '';
            groupBadge.style.display = 'none';
        }
    }

    // Populate profile info below QR
    const profilePhoto = document.getElementById('meetProfilePhoto');
    if (currentProfile?.profile_image_url) {
        profilePhoto.src = currentProfile.profile_image_url;
        profilePhoto.style.display = '';
    } else {
        profilePhoto.src = '';
        profilePhoto.style.display = 'none';
    }
    document.getElementById('meetProfileName').textContent = currentProfile?.display_name || '';

    // Set up share icon availability — default to sharing both when available,
    // so the connection includes contact info unless the user opts out.
    const phoneBtn = document.getElementById('meetSharePhone');
    const emailBtn = document.getElementById('meetShareEmail');
    const hasPhone = !!currentProfile?.phone;
    const hasEmail = !!currentProfile?.email;
    phoneBtn.classList.toggle('active', hasPhone);
    emailBtn.classList.toggle('active', hasEmail);
    phoneBtn.classList.toggle('disabled', !hasPhone);
    emailBtn.classList.toggle('disabled', !hasEmail);

    const sharedInfoDiv = document.getElementById('meetSharedInfo');
    let sharedInfoHtml = '';
    if (hasPhone) sharedInfoHtml += `<div>\u260E\uFE0F ${esc(currentProfile.phone)}</div>`;
    if (hasEmail) sharedInfoHtml += `<div>\u2709\uFE0F ${esc(currentProfile.email)}</div>`;
    if (sharedInfoHtml) {
        sharedInfoDiv.innerHTML = sharedInfoHtml;
        sharedInfoDiv.style.display = '';
    } else {
        sharedInfoDiv.innerHTML = '';
        sharedInfoDiv.style.display = 'none';
    }

    // 3. Attach camera to video element if available
    if (cameraOk) {
        const video = document.getElementById('meetVideo');
        video.srcObject = meetStream;
        try { await video.play(); } catch (_) { /* iOS sometimes ignores this */ }
    }

    // 4. Create a meet request in the database (network call after camera).
    //    Pre-set share_phone / share_email to match the current (default-on)
    //    button state so a scan that completes before any toggle still shares
    //    contact info.
    const initialSharePhone = phoneBtn.classList.contains('active');
    const initialShareEmail = emailBtn.classList.contains('active');
    const insertPayload = {
        user_id: currentUser.id,
        share_phone: initialSharePhone,
        share_email: initialShareEmail
    };
    if (currentMeetGroup) {
        insertPayload.group_id = currentMeetGroup.groupId;
        insertPayload.message = currentMeetGroup.message || null;
    }
    const { data, error } = await db
        .from('meet_requests')
        .insert(insertPayload)
        .select('token, id')
        .single();

    if (error) {
        showToast('Could not start meet: ' + error.message, 'error');
        closeMeetScreen();
        return;
    }

    const token = data.token;
    currentMeetToken = token;
    currentMeetRequestId = data.id;
    const meetContactsSnapshot = new Set(
        (contactsLoadedRows || []).map((r) => r.contact?.contact_id).filter(Boolean)
    );

    // If the user toggled a share button while the insert was in flight (when
    // currentMeetToken was still null and toggleMeetShare couldn't write), sync
    // the row now so the DB matches the visible UI state.
    const currentSharePhone = phoneBtn.classList.contains('active');
    const currentShareEmail = emailBtn.classList.contains('active');
    if (currentSharePhone !== initialSharePhone || currentShareEmail !== initialShareEmail) {
        db.from('meet_requests')
            .update({ share_phone: currentSharePhone, share_email: currentShareEmail })
            .eq('token', token)
            .then(({ error: syncErr }) => {
                if (syncErr) console.warn('[meet] Failed to sync share prefs after insert:', syncErr.message);
            });
    }

    // 5. Generate QR code encoding a navigable URL so non-members
    //    scanning with their phone camera land on the signup page.
    const qr = qrcode(0, 'M');
    const meetUrl = publicAppUrl(`?meet=${encodeURIComponent(token)}`);
    currentMeetUrl = meetUrl;
    qr.addData(meetUrl);
    qr.make();
    const qrBox = document.getElementById('meetQrBox');
    if (qrBox) qrBox.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 4 });
    const copyBtn = document.getElementById('meetCopyBtn');
    if (copyBtn) copyBtn.style.display = '';
    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();

    // 6. Subscribe to Realtime on this meet_requests row and to new contact
    // INSERTs for this user. used_by may be set at signup (token reservation)
    // before complete_meet creates the contact row on first login.
    async function handleMeetRequestConsumed(usedById) {
        if (meetHandled || !usedById) return;
        const alreadyContact = meetContactsSnapshot.has(usedById);
        const { data: row } = await db.from('contacts')
            .select('contact_id')
            .eq('user_id', currentUser.id)
            .eq('contact_id', usedById)
            .maybeSingle();
        if (!row && !alreadyContact) {
            pendingMeetUsedById = usedById;
            return;
        }
        meetHandled = true;
        pendingMeetUsedById = null;
        const { data: profile } = await db.from('profiles')
            .select('display_name')
            .eq('id', usedById)
            .single();
        const name = profile?.display_name || 'someone';
        meetSuccess(name, usedById, alreadyContact || !!row);
    }

    meetChannel = db.channel('meet-request-' + currentMeetRequestId)
        .on('postgres_changes', {
            event: 'UPDATE',
            schema: 'public',
            table: 'meet_requests',
            filter: 'id=eq.' + currentMeetRequestId
        }, (payload) => {
            const usedById = payload.new?.used_by;
            if (usedById) void handleMeetRequestConsumed(usedById);
        })
        .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'contacts',
            filter: 'user_id=eq.' + currentUser.id
        }, (payload) => {
            const contactId = payload.new?.contact_id;
            if (contactId && contactId === pendingMeetUsedById) {
                void handleMeetRequestConsumed(contactId);
            }
        })
        .subscribe();

    // 7. Begin scanning loop if camera is active
    if (cameraOk) {
        meetScanLoop();
    }
}

// function meetScanLoop() {
//     if (meetHandled) return;

//     const video = document.getElementById('meetVideo');
//     const canvas = document.getElementById('meetCanvas');

//     if (video.readyState < video.HAVE_ENOUGH_DATA) {
//         meetScanTimer = requestAnimationFrame(meetScanLoop);
//         return;
//     }

//     canvas.width = video.videoWidth;
//     canvas.height = video.videoHeight;
//     const ctx = canvas.getContext('2d', { willReadFrequently: true });
//     ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

//     const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
//     const code = jsQR(imageData.data, imageData.width, imageData.height, {
//         inversionAttempts: 'dontInvert'
//     });

//     if (code && code.data) {
function meetScanLoop() {
    if (meetHandled) return;

    const video = document.getElementById('meetVideo');
    const canvas = document.getElementById('meetCanvas');
    const pip = document.getElementById('meetCameraPip');

    if (video.readyState < video.HAVE_ENOUGH_DATA) {
        meetScanTimer = requestAnimationFrame(meetScanLoop);
        return;
    }

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: 'dontInvert'
    });

    // Give immediate visual feedback the moment any QR pattern is seen in
    // frame, even before we know if it decodes to a valid/fresh token —
    // otherwise there's no indication the camera is doing anything at all.
    if (pip) pip.classList.toggle('meet-qr-detected', !!code);

    if (code && code.data) {
        let scannedToken = null;
        // New format: full URL with ?meet= parameter
        try {
            const scannedUrl = new URL(code.data);
            scannedToken = scannedUrl.searchParams.get('meet');
        } catch {}
        // Legacy format: fairshare-meet:TOKEN
        if (!scannedToken && code.data.startsWith('fairshare-meet:')) {
            scannedToken = code.data.replace('fairshare-meet:', '');
        }
        if (scannedToken && !meetHandled) {
            meetHandled = true;
            handleMeetScan(scannedToken);
            return;
        }
    }

    // Continue scanning
    meetScanTimer = requestAnimationFrame(meetScanLoop);
}

async function handleMeetScan(token) {
    document.getElementById('meetScanHint').textContent = 'Connecting...';

    try {
        const { data, error } = await db.rpc('complete_meet', {
            p_token: token,
            p_meet_source: 'F2F',
        });

        if (error) {
            showToast('Meet failed: ' + error.message, 'error');
            meetHandled = false; // allow retry
            meetScanLoop();
            return;
        }

        const contactName = data?.contact_name || 'New contact';
        const contactId = data?.contact_id || null;
        const serverAlready = Boolean(data?.already_contact);
        const clientAlready = Boolean(
            contactId
            && typeof contactsLoadedRows !== 'undefined'
            && contactsLoadedRows.some((r) => r.contact?.contact_id === contactId)
        );
        meetSuccess(contactName, contactId, serverAlready || clientAlready);
    } catch (e) {
        showToast('Meet error: ' + e.message, 'error');
        meetHandled = false;
        meetScanLoop();
    }
}

function meetSuccess(contactName, contactId = null, alreadyContact = false) {
    // Vibrate the phone
    if (navigator.vibrate) {
        navigator.vibrate([200, 100, 200]);
    }

    // Flash the whole screen blue/grey to make the connection unmistakable
    const flash = document.getElementById('handshakeFlash');
    flash.classList.remove('active');
    // Force reflow so re-adding the class restarts the animation
    void flash.offsetWidth;
    flash.classList.add('active');
    flash.addEventListener('animationend', () => flash.classList.remove('active'), { once: true });

    document.getElementById('meetScanHint').textContent = '';
    if (!alreadyContact) {
        const qrBox = document.getElementById('meetQrBox');
        if (qrBox) {
            qrBox.outerHTML = `<div class="meet-success">✓ Connected with ${esc(contactName)}!</div>`;
        }
        showToast('Contact added: ' + contactName, 'success');
    }

    const delayMs = alreadyContact ? 0 : 2500;
    setTimeout(() => {
        closeMeetScreen();
        openNewContactSelfieOverlay(contactId, contactName);
    }, delayMs);
}

function copyMeetLink() {
    if (!currentMeetUrl) return;
    navigator.clipboard.writeText(currentMeetUrl).then(() => {
        showToast('Invite link copied', 'success');
        closeMeetScreen();
    }).catch(() => {
        showToast('Could not copy link', 'error');
    });
}

function closeMeetScreen() {
    currentMeetUrl = null;
    currentMeetToken = null;
    currentMeetRequestId = null;
    pendingMeetUsedById = null;
    currentMeetGroup = null;
    const copyBtn = document.getElementById('meetCopyBtn');
    if (copyBtn) copyBtn.style.display = 'none';

    // Stop camera
    if (meetStream) {
        meetStream.getTracks().forEach(t => t.stop());
        meetStream = null;
    }
    const video = document.getElementById('meetVideo');
    if (video) video.srcObject = null;

    // Stop scanning
    if (meetScanTimer) {
        cancelAnimationFrame(meetScanTimer);
        meetScanTimer = null;
    }

    // Unsubscribe from Realtime
    if (meetChannel) {
        db.removeChannel(meetChannel);
        meetChannel = null;
    }

    meetHandled = false;

    // Reset QR area (in case meetSuccess replaced it)
    const overlay = document.getElementById('meetOverlay');
    const qrSection = overlay.querySelector('.meet-qr-section');
    if (qrSection && !document.getElementById('meetQrBox')) {
        const successEl = qrSection.querySelector('.meet-success');
        if (successEl) {
            successEl.outerHTML = '<div class="meet-qr-box" id="meetQrBox"></div>';
        }
    }

    // Reset group badge
    const groupBadge = document.getElementById('meetGroupBadge');
    if (groupBadge) { groupBadge.textContent = ''; groupBadge.style.display = 'none'; }

    // Reset profile / share UI
    const profilePhoto = document.getElementById('meetProfilePhoto');
    if (profilePhoto) { profilePhoto.src = ''; profilePhoto.style.display = 'none'; }
    const profileName = document.getElementById('meetProfileName');
    if (profileName) profileName.textContent = '';
    const sharedInfo = document.getElementById('meetSharedInfo');
    if (sharedInfo) { sharedInfo.textContent = ''; sharedInfo.style.display = 'none'; }
    document.getElementById('meetSharePhone')?.classList.remove('active');
    document.getElementById('meetShareEmail')?.classList.remove('active');

    // Hide overlay
    overlay.classList.add('hidden');
}

async function toggleMeetShare(type) {
    const phoneBtn = document.getElementById('meetSharePhone');
    const emailBtn = document.getElementById('meetShareEmail');
    const infoDiv = document.getElementById('meetSharedInfo');

    if (type === 'phone') phoneBtn.classList.toggle('active');
    else emailBtn.classList.toggle('active');

    const sharePhone = phoneBtn.classList.contains('active');
    const shareEmail = emailBtn.classList.contains('active');

    let html = '';
    if (sharePhone && currentProfile?.phone) html += `<div>\u260E\uFE0F ${esc(currentProfile.phone)}</div>`;
    if (shareEmail && currentProfile?.email) html += `<div>\u2709\uFE0F ${esc(currentProfile.email)}</div>`;

    if (html) {
        infoDiv.innerHTML = html;
        infoDiv.style.display = '';
    } else {
        infoDiv.innerHTML = '';
        infoDiv.style.display = 'none';
    }

    if (currentMeetToken) {
        db.from('meet_requests')
            .update({ share_phone: sharePhone, share_email: shareEmail })
            .eq('token', currentMeetToken)
            .then(({ error }) => {
                if (error) console.warn('[meet] Failed to update share prefs:', error.message);
            });
    }
}
