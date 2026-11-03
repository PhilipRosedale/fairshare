// Payment codes: the client half of sql/payment-codes-schema.sql.
// See docs/payment-codes.md. These are plain globals like every other module.
//
// Flow, in one breath: whoever knows the amount calls createPaymentCode() and shows
// the returned URL as a QR. The other phone scans it, calls getPaymentCode() to show
// a confirm screen (for a 'request' code) and then redeemPaymentCode() to move the
// money. The first phone finds out through watchPaymentCode(), not by being told.

function paymentCodeUrl(token) {
    return publicAppUrl(`?pay=${encodeURIComponent(token)}`);
}

// Returns a token if the scanned text is a Union payment code, otherwise null.
// Lives alongside the meet-code parser so one scanner loop can tell them apart.
function parsePaymentCodeFromScan(text) {
    if (!text) return null;
    try {
        const url = new URL(text);
        const t = url.searchParams.get('pay');
        if (t) return t;
    } catch {}
    if (text.startsWith('fairshare-pay:')) return text.slice('fairshare-pay:'.length);
    return null;
}

async function createPaymentCode(groupId, direction, amount, memo) {
    const { data, error } = await db.rpc('create_payment_code', {
        p_group_id: groupId,
        p_direction: direction,     // 'pay' | 'request'
        p_amount: amount,
        p_memo: memo || null
    });
    if (error) throw error;
    return data;
}

async function getPaymentCode(token) {
    const { data, error } = await db.rpc('get_payment_code', { p_token: token });
    if (error) throw error;
    return data;
}

async function redeemPaymentCode(token) {
    const { data, error } = await db.rpc('redeem_payment_code', { p_token: token });
    if (error) throw error;
    return data;
}

async function cancelPaymentCode(token) {
    const { data, error } = await db.rpc('cancel_payment_code', { p_token: token });
    if (error) throw error;
    return data;
}

// Subscribe to one code you created. onChange gets the new row whenever its status
// moves (settled, cancelled, expired). Returns a function that stops watching.
function watchPaymentCode(codeId, onChange) {
    const channel = db.channel(`pay-${codeId}`)
        .on('postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'payment_requests', filter: `id=eq.${codeId}` },
            (payload) => { if (payload?.new) onChange(payload.new); })
        .subscribe();
    return () => { try { db.removeChannel(channel); } catch {} };
}
