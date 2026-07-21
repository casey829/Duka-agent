# Duka Agent

A WhatsApp-first ordering assistant for Kenyan retail, built on [Lua](https://heylua.ai).

It takes a customer from *"una cement ngapi?"* to a paid order without leaving the chat: stock lookup, order creation with reserved stock, M-Pesa STK Push, and settlement driven by Safaricom's callback.

Tested end to end against the live Daraja sandbox — real STK prompt on a real handset, real PIN entry, real callback settling the order.

## Why this exists

Most agent demos stop at "it answered a question." The interesting part of retail is what happens when money and inventory move at the same time: two customers reaching for the last bag of cement, a customer who closes WhatsApp before entering their PIN, a prompt that lapses after sixty seconds.

This agent is built around those cases rather than the happy path.

## What it does

```
Customer: Niaje ukona cement
Agent:    Niaje! Ndio, niko na simiti.
          Nina Bamburi Cement 50kg, na niko na mifuko 38. Inauzwa KES 850 kwa mfuko.

Customer: nataka bags 30
Agent:    Sawa! Mfuko thelathini za Bamburi Cement 50kg zitakuwa KES 25,500.
          Naweza kukuundia order. Nipe jina na namba yako ya simu tafadhali.
```

It matches the customer's language, quotes stock it has actually looked up, and reads the total back before it charges anyone.

## Architecture

```
src/
├── index.ts                        Agent: persona, skills, webhook, job
├── governance.ts                   Injection scan, approval gate, token budget
├── skills/tools/
│   ├── OrderTools.ts               check_stock, create_order
│   └── MpesaTools.ts               request_mpesa_payment, check_payment_status
├── services/
│   ├── DarajaService.ts            Daraja auth, STK push, status query
│   └── Repo.ts                     Data-API helpers + shared release path
├── webhooks/
│   └── MpesaCallbackWebhook.ts     Settlement — the source of truth
└── jobs/
    └── ReleaseStaleHoldsJob.ts     Reclaims stock from abandoned checkouts
```

## Design decisions

### Stock is reserved at order creation, not at payment

If two customers ask for the last unit within the same few seconds, only one gets a payment prompt. `create_order` holds the stock immediately; the hold only becomes a real decrement when money arrives.

Partial orders roll back — if a three-line order fails on line three, the reservations taken for lines one and two are released rather than silently held.

### Three ways a checkout dies, one release path

This is the part that took a real bug to get right. During testing, a payment failed and the agent correctly reported it — but the 30 bags stayed reserved. Stock looked sold out with 40 bags on the floor.

The webhook released reservations on failure, but the webhook only fires if Daraja was actually reached. It never covered a push that threw before reaching Safaricom, and it never covered the commonest case of all: the customer who simply stops replying.

| How the checkout dies | What reclaims the stock |
|---|---|
| STK push throws (bad credentials, network) | rollback inside `request_mpesa_payment` |
| Safaricom reports cancelled / timed out | `MpesaCallbackWebhook` |
| Customer reads the total and vanishes | `ReleaseStaleHoldsJob`, every 5 min |

All three call `releaseOrderReservations()`. It only acts on orders still `awaiting_payment`, so it is idempotent — if the webhook and the job both fire on the same order, the stock comes back once, not twice.

The hold expires after 15 minutes, deliberately past Daraja's own STK timeout, so a slow customer still entering their PIN is never cut off.

### Pending is not failure

Daraja returns error code `500.001.1001` while the customer still has the PIN prompt open. Treating that as a failure — and re-sending the prompt — is the classic STK Push bug, and it can double-charge a customer. The status query maps it to `pending`, and the skill context explicitly instructs the agent not to resend.

Unmapped Daraja responses surface the raw `ResultCode` rather than flattening to "unknown", because an opaque failure in a payment path is worse than a verbose one.

### The webhook is the source of truth, not the polling tool

A customer can close WhatsApp before confirming and the money still lands. `check_payment_status` serves the conversation ("I've paid"); the callback is what actually moves the order to `paid` and decrements stock.

Payments that arrive with no matching order are written to `payment-orphans` rather than dropped. An unmatched payment is worse than a noisy log.

### Guardrails sit at the layer that can enforce them

| Guard | Where | Why there |
|---|---|---|
| Approval before charging | governance | `requireApproval` gates the irreversible action |
| Prompt-injection scan | governance | untrusted WhatsApp text that can move money |
| Token budget | governance | runaway loops are a cost bug |
| KES 150,000 ceiling | Zod schema | policy gates *whether* a tool runs, not its arguments |
| No double-sell | `create_order` | stateful invariant, needs code |

Phone numbers are normalised before they reach Daraja — customers type `0712345678`, `+254712…`, `712345678`, and Daraja accepts exactly one of those.

## Running it

```bash
npm install -g lua-cli
lua auth configure

lua env sandbox --key MPESA_CONSUMER_KEY    --value <key>
lua env sandbox --key MPESA_CONSUMER_SECRET --value <secret>
lua env sandbox --key MPESA_ENV             --value sandbox
lua env sandbox --key MPESA_SHORTCODE       --value 174379
lua env sandbox --key MPESA_PASSKEY         --value <sandbox passkey>
lua env sandbox --key MPESA_CALLBACK_URL    --value https://webhook.heylua.ai/<agentId>/mpesa-callback

lua test        # exercise tools and the job individually
lua chat        # talk to the agent
lua push && lua deploy
```

Secrets live server-side and encrypted via `lua env` — not in a local `.env`.

Seed the `products` collection before first run: `sku`, `name`, `priceKes`, `stock`, `reserved`, and a `searchText` value. Search is vector-based, so a product with no `searchText` is invisible to `check_stock` no matter what is stored.

## Data collections

| Collection | Purpose |
|---|---|
| `products` | `sku`, `name`, `priceKes`, `stock`, `reserved` |
| `orders` | Lines, total, state: `awaiting_payment` → `paid` / `payment_failed` / `expired` |
| `payments` | Keyed by `checkoutRequestId`, links a payment to its order |
| `payment-orphans` | Payments that arrived with no matching order |

## Status

Sandbox-tested end to end. The production path is the same code with `MPESA_ENV=production` and a real paybill.

Not yet built: multi-branch stock, delivery scheduling, refunds. Reservations assume a single agent instance — a multi-instance deployment would want the decrement pushed into a transactional store rather than read-modify-write.

---

Built by Casey Kimamo · Minika Tech Solutions