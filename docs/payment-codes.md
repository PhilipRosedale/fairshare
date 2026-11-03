# Payment codes

In-person Pay and Request by holding up a QR code. Backend in `sql/payment-codes-schema.sql`, client wrapper in `js/pay-api.js`. The screens are not in this change; they follow once the backend is applied and tested. The working prototype they will be ported from is at https://bxbyjr.github.io/fairshare/ and the design is on the "One screen, both ways" page of the Union Design System Figma file.

## The model

Whoever knows the amount types it and makes a code. The other person scans it. Nobody picks a direction while scanning; the code carries it.

| Code       | Made by                              | Scanned by              | Money moves          |
|------------|--------------------------------------|-------------------------|----------------------|
| `request`  | The person owed (bartender)          | The person paying       | scanner to creator   |
| `pay`      | The person paying (customer)         | The person owed         | creator to scanner   |

Only the payer confirms. For a `request` code that is the scanner, who sees the bill before redeeming. For a `pay` code the creator confirmed when they made it, so the scanner just collects. The phone holding the code up does nothing; it learns the outcome through realtime.

## Lifecycle

```
create_payment_code  ->  open  ->  redeem_payment_code  ->  settled
                            \->  cancel_payment_code   ->  cancelled
                            \->  15 minutes pass       ->  expired (marked lazily on next read)
```

Making a new code cancels any other open code by the same person, so a forgotten screen or an old screenshot cannot be scanned later.

## Server functions

All `SECURITY DEFINER`, all require a signed-in user. Clients never write to `payment_requests` directly.

- `create_payment_code(group_id, direction, amount, memo)` returns the token, amount, group currency and creator name. Refuses if the group has currency off, the caller is not an active member, or (for `pay`) the caller cannot cover the amount right now.
- `get_payment_code(token)` is the scanner's preview: status, direction, amount, memo, group, creator, and whether the caller is a member and what their balance is. Use it to build the confirm screen before anything moves.
- `redeem_payment_code(token)` moves the money. Locks the row, checks it is still open and unexpired, checks the scanner is a member of that group, works out payer and payee from the direction, and calls the internal transfer. Returns a receipt including `you_paid`, `amount`, `fee`, `net` and `your_balance`. Also pushes a notification to the creator.
- `cancel_payment_code(token)` for the creator's Cancel button.

`_transfer_currency` is the internal mover. It is the same logic as `send_currency` with the payer passed in rather than taken from `auth.uid()`, because a `pay` code is redeemed by the receiver. It is not callable by clients. `send_currency` itself is untouched.

## Fee

Same as today: the payer loses `amount`, the receiver gets `amount - fee`, the fee leaves circulation. The receipt returns all three. Whether a bill of 20 should mean "receiver gets 20" instead is a product decision; if so, change the two balance updates in `_transfer_currency` and nothing else.

## Realtime

`payment_requests` is in the realtime publication with `replica identity full`. The RLS select policy lets the creator (and later the settler) read the row, so `watchPaymentCode(id, fn)` on the creator's phone receives the UPDATE when it settles. That replaces the prototype's "mark as scanned" button.

## QR contents

The QR encodes `publicAppUrl('?pay=TOKEN')`, matching how the handshake uses `?meet=TOKEN`, so a plain phone camera lands on the app rather than a string. `parsePaymentCodeFromScan(text)` extracts the token; the compose screen's scanner should try it alongside the meet parser so one camera reads both kinds of code.

## What the screens need from this

1. Compose (camera + keypad): on scan, `getPaymentCode(token)`. If `you_are_member` is false, say so and keep scanning. If `direction` is `request`, show the confirm screen with the receipt and a Pay button that calls `redeemPaymentCode`. If `direction` is `pay`, call `redeemPaymentCode` straight away and show the blue "paid you" screen.
2. Code screen: `createPaymentCode`, render `paymentCodeUrl(token)` as the QR, then `watchPaymentCode(id, ...)` and move to the receipt when `status` becomes `settled`. Cancel calls `cancelPaymentCode`.
3. Receipts: the payer gets the printed receipt with the PAID line; the receiver gets the confirmation screen. `you_paid` in the redeem result tells you which.

## Applying

```
supabase db query --linked -f sql/payment-codes-schema.sql
```

Then add `<script src="js/pay-api.js"></script>` after `js/db.js` in `index.html` (it only needs `db` and `publicAppUrl`). Nothing is wired to the UI yet, so applying this changes no visible behaviour.
