// In-person Pay and Request: the Union button fan, the compose screen (camera + keypad),
// the code screen, and the two endings. Backend in sql/payment-codes-schema.sql, client
// calls in js/pay-api.js, design in docs/payment-codes.md.
//
// Shape of the flow:
//   Union button -> fan (Pay / Request / Connect)
//   Pay or Request -> compose: live camera on top, OR, amount + keypad, group chip
//     - type an amount and press the button -> your code, held up -> ends when it settles
//     - or the camera sees someone else's code -> confirm (for a bill) -> ends
//   Connect -> the existing Meet screen.

let payState = {
    view: null,          // 'compose' | 'code' | 'confirm' | 'done'
    direction: 'pay',    // 'pay' | 'request'
    amountStr: '',
    groupId: null,
    stream: null,
    scanTimer: null,
    scanHandled: false,
    lastSeen: 0,
    code: null,          // result of createPaymentCode while a code is held up
    unwatch: null,
    pending: null,       // a scanned 'request' code awaiting the payer's confirm
    pendingToken: null,
};

const PAY_REDUCE_MOTION = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function payFmt(n) {
    n = Math.round(Number(n) * 100) / 100;
    return (n % 1 === 0) ? String(n) : n.toFixed(2);
}
function payMoneyHtml(n, sym) {
    return `<span class="pay-sym">${esc(sym || '')}</span>${payFmt(n)}`;
}
// Groups you can pay or request in: currency on, and you hold some of it. People in
// many groups only have currency in a few, so the chooser stays short. If you hold
// nothing anywhere, fall back to every currency group so a Request is still possible.
// Codes from any group still scan fine; the code decides the group, not this list.
function payGroups() {
    const all = (myGroups || [])
        .filter(m => m.status === 'active' && m.groups && groupCurrencyEnabled(m.groups))
        .map(m => ({ id: m.group_id, name: m.groups.name, sym: m.groups.currency_symbol,
                     cur: m.groups.currency_name, bal: Number(m.balance || 0) }));
    const funded = all.filter(g => g.bal > 0);
    return (funded.length ? funded : all).sort((a, b) => b.bal - a.bal || a.name.localeCompare(b.name));
}
function payActiveGroup() {
    const gs = payGroups();
    return gs.find(g => g.id === payState.groupId) || gs[0] || null;
}
// One meaning per haptic, nothing on close, nothing per key. Real haptics in the native
// build via Capacitor; web gets the vibration API where it exists (Android only).
function payHaptic(kind) {
    try {
        const H = window.Capacitor?.Plugins?.Haptics;
        if (H) {
            if (kind === 'open' || kind === 'pick') H.impact({ style: kind === 'open' ? 'LIGHT' : 'MEDIUM' });
            else H.notification({ type: 'SUCCESS' });
            return;
        }
        if (!navigator.vibrate) return;
        if (kind === 'open') navigator.vibrate(8);
        else if (kind === 'pick') navigator.vibrate(5);
        else if (kind === 'paid') navigator.vibrate(18);
        else if (kind === 'got') navigator.vibrate([18, 50, 28]);
    } catch (_) {}
}
function payStamp(d) {
    const dd = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'], mm = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    let h = d.getHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
    const m = String(d.getMinutes()).padStart(2, '0');
    return `${dd[d.getDay()]}, ${mm[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}  ·  ${h}:${m} ${ap}`;
}
function payReceiptHtml(o) {
    // o: { who, group:{name,sym,cur}, memo, amount, fee, paid, when }
    const feeLine = o.fee > 0 ? `<div class="pay-r-li pay-r-fee"><span>Group fee</span><b>${payMoneyHtml(o.fee, o.group.sym)}</b></div>` : '';
    return `<div class="pay-receipt">
        <div class="pay-r-h">${esc((o.group.name || '').toUpperCase())}</div>
        <div class="pay-r-when">${esc(payStamp(o.when || new Date()))}</div>
        <div class="pay-r-name">${esc(o.who)}</div>
        <div class="pay-r-rule"></div>
        <div class="pay-r-li"><span>${esc(o.memo || 'No description')}</span><b>${payMoneyHtml(o.amount, o.group.sym)}</b></div>
        ${feeLine}
        <div class="pay-r-rule"></div>
        <div class="pay-r-tot"><span class="l">TOTAL</span><span class="r">${payMoneyHtml(o.amount, o.group.sym)}</span></div>
        <div class="pay-r-cur">${esc(o.group.cur || '')}</div>
        ${o.paid ? '<div class="pay-r-dash"></div><div class="pay-r-paid">PAID</div>' : ''}
    </div>`;
}

// ---------------------------------------------------------------------------
// The fan
// ---------------------------------------------------------------------------
function openUnionFan() {
    if (!currentUser) return;
    const fan = document.getElementById('unionFan');
    fan.classList.remove('hidden', 'closing');
    fan.setAttribute('aria-hidden', 'false');
    document.body.classList.add('union-fan-open');
    payHaptic('open');
    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
}
function closeUnionFan(instant) {
    const fan = document.getElementById('unionFan');
    if (fan.classList.contains('hidden')) return;
    fan.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('union-fan-open');
    if (instant || PAY_REDUCE_MOTION) { fan.classList.add('hidden'); return; }
    fan.classList.add('closing');
    setTimeout(() => fan.classList.add('hidden'), 170);
}
function unionFanPick(what) {
    payHaptic('pick');
    if (what === 'connect') { closeUnionFan(true); openMeetScreen(); return; }
    openPayCompose(what);
}

// ---------------------------------------------------------------------------
// Compose: camera + keypad
// ---------------------------------------------------------------------------
async function openPayCompose(direction) {
    const groups = payGroups();
    if (!groups.length) {
        closeUnionFan(true);
        showToast('You are not in a group that uses currency yet', 'error');
        return;
    }
    payState.direction = direction;
    payState.amountStr = '';
    payState.scanHandled = false;
    payState.pending = null;
    payState.pendingToken = null;
    if (!payState.groupId || !groups.some(g => g.id === payState.groupId)) {
        payState.groupId = (selectedGroup && groups.some(g => g.id === selectedGroup.id)) ? selectedGroup.id : groups[0].id;
    }

    // Camera first, inside the tap, which iOS requires. Rear camera: you point your phone
    // at their screen while watching your own.
    let cameraOk = false;
    try {
        payState.stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 } }
        });
        cameraOk = true;
    } catch (err) {
        console.warn('[pay] camera unavailable:', err);
    }

    closeUnionFan(true);
    document.getElementById('payMemo').value = '';
    payShowView('compose');
    payRenderMode();
    payRenderGroup();
    payRenderAmount();

    const video = document.getElementById('payVideo');
    const hint = document.getElementById('payCamHint');
    const wrap = document.getElementById('payCamWrap');
    if (cameraOk) {
        wrap.classList.remove('dead');
        video.srcObject = payState.stream;
        try { await video.play(); } catch (_) {}
        hint.textContent = 'Scan their code';
        payScanLoop();
    } else {
        wrap.classList.add('dead');
        hint.textContent = 'Camera unavailable';
    }
}
function payStopCamera() {
    if (payState.scanTimer) { cancelAnimationFrame(payState.scanTimer); payState.scanTimer = null; }
    if (payState.stream) { payState.stream.getTracks().forEach(t => t.stop()); payState.stream = null; }
}
function payRenderMode() {
    const pill = document.getElementById('payModePill');
    const isPay = payState.direction === 'pay';
    pill.className = 'pay-modepill ' + (isPay ? 'pay' : 'req');
    pill.innerHTML = (isPay ? PAY_ICON_UP : PAY_ICON_DOWN) + `<span>${isPay ? 'Paying' : 'Requesting'}</span>`;
}
function payRenderGroup() {
    const g = payActiveGroup(); if (!g) return;
    const many = payGroups().length > 1;
    const chip = document.getElementById('payGroupChip');
    chip.disabled = !many;
    chip.classList.toggle('many', many);
    chip.innerHTML = `<span>${esc(g.name)}</span>` + (many ? PAY_ICON_CHEV : '');
    document.getElementById('payCurName').textContent = g.cur || '';
}
function payRenderAmount() {
    const g = payActiveGroup(); const s = payState.amountStr; const n = payNum();
    const el = document.getElementById('payAmount');
    const sym = `<span class="pay-sym">${esc(g?.sym || '')}</span>`;
    if (!s) el.innerHTML = sym + '0';
    else { const i = s.indexOf('.'); el.innerHTML = i < 0 ? sym + esc(s) : sym + esc(s.slice(0, i)) + `<span class="dec">${esc(s.slice(i))}</span>`; }
    el.classList.toggle('zero', n === 0);
    const btn = document.getElementById('payGo');
    btn.disabled = !(n > 0);
    const verb = payState.direction === 'pay' ? 'Pay' : 'Request';
    btn.textContent = n > 0 ? `${verb} ${g?.sym || ''}${payFmt(n)}` : verb;
}
function payNum() { const n = parseFloat(payState.amountStr); return isNaN(n) ? 0 : Math.round(n * 100) / 100; }
function payKey(k) {
    let s = payState.amountStr;
    if (k === 'x') s = s.slice(0, -1);
    else if (k === '.') { if (s.indexOf('.') < 0) s = (s || '0') + '.'; }
    else {
        const dot = s.indexOf('.');
        if (dot >= 0 && s.length - dot > 2) return;   // two decimals max
        if (dot < 0 && s.length >= 6) return;
        s = (s === '0') ? k : s + k;
    }
    payState.amountStr = s;
    payRenderAmount();
}

// Group picker (bottom sheet)
function openPayGroups() {
    const gs = payGroups(); if (gs.length < 2) return;
    document.getElementById('payGroupList').innerHTML = gs.map(g => `
        <button type="button" class="pay-grow${g.id === payState.groupId ? ' on' : ''}" onclick="pickPayGroup('${g.id}')">
            <span class="gs">${esc(g.sym || '')}</span>
            <span class="gm"><b>${esc(g.name)}</b><span>${esc(g.cur || '')}</span></span>
            <span class="gb">${payMoneyHtml(g.bal, g.sym)}<small>${esc(g.cur || '')}</small></span>
        </button>`).join('');
    const sh = document.getElementById('payGroupSheet');
    sh.classList.remove('hidden'); sh.setAttribute('aria-hidden', 'false');
}
function closePayGroups() {
    const sh = document.getElementById('payGroupSheet');
    sh.classList.add('hidden'); sh.setAttribute('aria-hidden', 'true');
}
function pickPayGroup(id) {
    payState.groupId = id; payHaptic('pick'); closePayGroups(); payRenderGroup(); payRenderAmount();
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------
function payScanLoop() {
    if (payState.scanHandled || payState.view !== 'compose') return;
    const video = document.getElementById('payVideo');
    const canvas = document.getElementById('payCanvas');
    if (video.readyState < video.HAVE_ENOUGH_DATA || typeof jsQR !== 'function') {
        payState.scanTimer = requestAnimationFrame(payScanLoop); return;
    }
    const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    if (code && code.data && Date.now() - payState.lastSeen > 1200) {
        payState.lastSeen = Date.now();
        const token = parsePaymentCodeFromScan(code.data.trim());
        if (token) { payState.scanHandled = true; handleScannedPayCode(token); return; }
        // A connect code pointed at the pay camera: say so rather than silently ignoring it.
        let isMeet = false;
        try { isMeet = !!new URL(code.data).searchParams.get('meet'); } catch (_) {}
        if (isMeet || code.data.startsWith('fairshare-meet:')) showToast('That is a Connect code. Use Connect to add them.', 'info');
    }
    payState.scanTimer = requestAnimationFrame(payScanLoop);
}
async function handleScannedPayCode(token) {
    document.getElementById('payCamHint').textContent = 'Reading…';
    let info;
    try { info = await getPaymentCode(token); }
    catch (err) { showToast(err.message || 'That code did not read', 'error'); payResumeScan(); return; }

    if (info.is_yours) { showToast('That is your own code', 'error'); payResumeScan(); return; }
    if (info.status !== 'open') { showToast(info.status === 'expired' ? 'That code has expired' : 'That code has already been used', 'error'); payResumeScan(); return; }
    if (!info.you_are_member) { showToast(`That is a ${info.group.name} code and you are not in that group`, 'error'); payResumeScan(); return; }

    // The code decides the group. Switch to it so the receipt and balance are the right ones.
    payState.groupId = info.group.id;

    if (info.direction === 'request') {
        // Someone is billing me: show the bill, I confirm.
        payState.pending = info; payState.pendingToken = token;
        payStopCamera();
        const g = { name: info.group.name, sym: info.group.currency_symbol, cur: info.group.currency_name };
        document.getElementById('payConfirmReceipt').innerHTML = payReceiptHtml({
            who: info.creator.display_name || 'Someone', group: g, memo: info.memo, amount: info.amount, fee: 0, paid: false
        });
        document.getElementById('payConfirmBal').innerHTML = payMoneyHtml(info.your_balance || 0, g.sym) + ` <span class="pay-muted">${esc(g.cur || '')}</span>`;
        document.getElementById('payConfirmGroup').textContent = g.name;
        const btn = document.getElementById('payConfirmGo');
        btn.textContent = `Pay ${g.sym}${payFmt(info.amount)}`;
        btn.disabled = Number(info.your_balance || 0) < Number(info.amount);
        if (btn.disabled) showToast(`Not enough ${g.cur || 'balance'} for that`, 'error');
        payHaptic('pick');
        payShowView('confirm');
    } else {
        // They are paying me: nothing to approve, collect it.
        payStopCamera();
        try {
            const r = await redeemPaymentCode(token);
            await payAfterSettle(r);
        } catch (err) {
            showToast(err.message || 'Could not collect that', 'error');
            payResumeScan();
        }
    }
}
function payResumeScan() {
    payState.scanHandled = false;
    document.getElementById('payCamHint').textContent = 'Scan their code';
    if (payState.view === 'compose' && payState.stream) payScanLoop();
}
async function payConfirmPay() {
    const token = payState.pendingToken; if (!token) return;
    const btn = document.getElementById('payConfirmGo'); btn.disabled = true;
    try {
        const r = await redeemPaymentCode(token);
        payState.pending = null; payState.pendingToken = null;
        await payAfterSettle(r);
    } catch (err) {
        showToast(err.message || 'Payment failed', 'error');
        btn.disabled = false;
    }
}
function payDecline() {
    payState.pending = null; payState.pendingToken = null;
    closePayFlow();
}
// Desktop / no-camera fallback: paste the code's URL.
function payPasteCode() {
    const v = prompt('Paste the code from their phone');
    if (!v) return;
    const token = parsePaymentCodeFromScan(v.trim());
    if (!token) { showToast('That is not a Union payment code', 'error'); return; }
    payState.scanHandled = true;
    handleScannedPayCode(token);
}

// ---------------------------------------------------------------------------
// Making a code and holding it up
// ---------------------------------------------------------------------------
async function payMakeCode() {
    const g = payActiveGroup(); const n = payNum();
    if (!g || !(n > 0)) return;
    const memo = document.getElementById('payMemo').value.trim();
    const btn = document.getElementById('payGo'); btn.disabled = true;
    let code;
    try { code = await createPaymentCode(g.id, payState.direction, n, memo); }
    catch (err) { showToast(err.message || 'Could not make a code', 'error'); btn.disabled = false; return; }

    payStopCamera();
    payState.code = code;
    payHaptic('pick');

    // QR with the group's symbol in the middle. Error correction H pays for the badge.
    const url = paymentCodeUrl(code.token);
    const qr = qrcode(0, 'H'); qr.addData(url); qr.make();
    const box = document.getElementById('payQrBox');
    box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2 }) + `<div class="pay-qrbadge">${esc(g.sym || '')}</div>`;

    document.getElementById('payCodeDir').textContent = payState.direction === 'pay' ? 'PAYING' : 'REQUESTING';
    document.getElementById('payCodeAmt').innerHTML = payMoneyHtml(code.amount, g.sym);
    document.getElementById('payCodeCur').textContent = g.cur || '';
    document.getElementById('payCodeMemo').textContent = code.memo || '';
    document.getElementById('payCodeName').textContent = currentProfile?.display_name || '';
    document.getElementById('payCodeGroup').textContent = g.name;
    payShowView('code');

    // This is what replaces "mark as scanned": the row changes, we react.
    if (payState.unwatch) payState.unwatch();
    payState.unwatch = watchPaymentCode(code.id, async (row) => {
        if (row.status === 'settled') {
            if (payState.unwatch) { payState.unwatch(); payState.unwatch = null; }
            await payCreatorSettled(row, g);
        } else if (row.status === 'expired') {
            showToast('That code expired. Make a new one.', 'info');
            closePayFlow();
        }
    });
}
async function payCancelCode() {
    const c = payState.code;
    if (payState.unwatch) { payState.unwatch(); payState.unwatch = null; }
    if (c?.token) { try { await cancelPaymentCode(c.token); } catch (_) {} }
    payState.code = null;
    closePayFlow();
}
// The phone that held the code up finds out it settled.
async function payCreatorSettled(row, g) {
    let other = 'Someone';
    try {
        const { data } = await db.from('profiles').select('display_name').eq('id', row.settled_by).maybeSingle();
        if (data?.display_name) other = data.display_name;
    } catch (_) {}
    const iPaid = payState.direction === 'pay';
    const amount = Number(row.amount);
    await payRefreshBalances();
    const bal = payActiveGroup()?.bal ?? 0;
    payShowEnding({ iPaid, other, amount, fee: 0, memo: row.memo, group: g, bal });
    payState.code = null;
}
// The scanner finishes (either direction).
async function payAfterSettle(r) {
    const g = { name: r.group.name, sym: r.group.currency_symbol, cur: r.group.currency_name };
    await payRefreshBalances();
    payShowEnding({ iPaid: !!r.you_paid, other: r.other?.display_name || 'Someone', amount: Number(r.amount),
                    fee: Number(r.fee || 0), memo: r.memo, group: g, bal: Number(r.your_balance ?? 0) });
}
async function payRefreshBalances() {
    try {
        if (typeof loadMyGroups === 'function') await loadMyGroups();
        if (selectedGroup && activeTab === 'money' && typeof renderMoneyTab === 'function') await renderMoneyTab();
    } catch (_) {}
}
// Payer keeps the receipt; receiver just gets told. (docs/payment-codes.md)
function payShowEnding(o) {
    const done = document.getElementById('payDone');
    done.classList.toggle('recv', !o.iPaid);
    document.getElementById('payDoneTitle').textContent = o.iPaid ? 'You paid' : '';
    document.getElementById('payDoneBody').innerHTML = o.iPaid
        ? payReceiptHtml({ who: o.other, group: o.group, memo: o.memo, amount: o.amount, fee: o.fee, paid: true })
        : `<div class="pay-conf">
             <div class="tick">${PAY_ICON_CHECK}</div>
             <div class="t1">${esc(o.other)} paid you</div>
             <div class="t2">${payMoneyHtml(o.amount, o.group.sym)}</div>
             <div class="pay-curname light">${esc(o.group.cur || '')}</div>
             <div class="t3">${esc(o.memo || '')}</div>
           </div>`;
    document.getElementById('payDoneGroup').textContent = o.group.name;
    document.getElementById('payDoneBal').innerHTML = payMoneyHtml(o.bal, o.group.sym) + ` <span class="pay-muted">${esc(o.group.cur || '')}</span>`;
    payHaptic(o.iPaid ? 'paid' : 'got');
    payShowView('done');
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
function payShowView(view) {
    payState.view = view;
    const ov = document.getElementById('payOverlay');
    ov.classList.remove('hidden');
    ov.querySelectorAll('.pay-view').forEach(v => v.classList.toggle('hidden', v.dataset.view !== view));
    if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
}
function closePayFlow() {
    payStopCamera();
    if (payState.unwatch) { payState.unwatch(); payState.unwatch = null; }
    payState.view = null; payState.scanHandled = false; payState.pending = null; payState.pendingToken = null;
    closePayGroups();
    document.getElementById('payOverlay').classList.add('hidden');
}

// A ?pay=TOKEN link opened from a phone camera: once signed in, treat it as a scan.
function payConsumeDeepLink() {
    let token = null;
    try { token = new URL(window.location.href).searchParams.get('pay'); } catch (_) {}
    if (!token) return;
    const tries = { n: 0 };
    const tick = setInterval(() => {
        tries.n++;
        if (currentUser && Array.isArray(myGroups) && myGroups.length) {
            clearInterval(tick);
            try { const u = new URL(window.location.href); u.searchParams.delete('pay'); history.replaceState({}, '', u.toString()); } catch (_) {}
            payState.direction = 'pay';
            payShowView('compose'); payRenderMode(); payRenderGroup(); payRenderAmount();
            document.getElementById('payCamWrap').classList.add('dead');
            payState.scanHandled = true;
            handleScannedPayCode(token);
        } else if (tries.n > 60) clearInterval(tick);
    }, 500);
}
document.addEventListener('DOMContentLoaded', payConsumeDeepLink);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeUnionFan(); closePayGroups(); } });
document.addEventListener('visibilitychange', () => {
    if (document.hidden) payStopCamera();
    else if (payState.view === 'compose' && !payState.scanHandled) openPayComposeCameraOnly();
});
async function openPayComposeCameraOnly() {
    try {
        payState.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
        const video = document.getElementById('payVideo'); video.srcObject = payState.stream;
        try { await video.play(); } catch (_) {}
        payScanLoop();
    } catch (_) {}
}

// Inline icons so the fan does not depend on which Lucide glyphs are bundled.
const PAY_ICON_UP    = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
const PAY_ICON_DOWN  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12l7 7 7-7"/></svg>';
const PAY_ICON_CHEV  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
const PAY_ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
