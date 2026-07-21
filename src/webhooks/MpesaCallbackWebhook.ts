import { LuaWebhook, Data } from 'lua-cli';
import { z } from 'zod';
import { findOne, findProductBySku, releaseOrderReservations } from '../services/Repo';

/**
 * Safaricom calls this when the customer finishes (or abandons) the prompt.
 *
 * This is the source of truth for payment, not the polling tool — the customer
 * may close the chat before confirming, and the money still needs to land
 * against the right order.
 *
 * Webhook URL: https://webhook.heylua.ai/{agentId}/mpesa-callback
 * That URL goes in MPESA_CALLBACK_URL.
 */
const mpesaCallbackWebhook = new LuaWebhook({
  name: 'mpesa-callback',
  description: 'Receives M-Pesa STK Push results from Safaricom Daraja',

  bodySchema: z.object({
    Body: z.object({
      stkCallback: z.object({
        MerchantRequestID: z.string(),
        CheckoutRequestID: z.string(),
        ResultCode: z.number(),
        ResultDesc: z.string(),
        CallbackMetadata: z
          .object({
            Item: z.array(
              z.object({
                Name: z.string(),
                Value: z.union([z.string(), z.number()]).optional(),
              })
            ),
          })
          .optional(),
      }),
    }),
  }),

  execute: async (event: any) => {
    const callback = event?.body?.Body?.stkCallback;
    if (!callback) return { success: false, message: 'Unrecognised callback shape.' };

    const { CheckoutRequestID, ResultCode, ResultDesc } = callback;

    // Daraja sends metadata as a name/value array rather than an object.
    const meta: Record<string, string | number> = {};
    for (const item of callback.CallbackMetadata?.Item ?? []) {
      if (item.Value !== undefined) meta[item.Name] = item.Value;
    }

    const paid = ResultCode === 0;

    const payment = await findOne('payments', { checkoutRequestId: CheckoutRequestID });

    if (!payment) {
      // Log it anyway — an unmatched payment is worse than a noisy log.
      await Data.create('payment-orphans', {
        checkoutRequestId: CheckoutRequestID,
        receipt: meta.MpesaReceiptNumber ?? null,
        amount: meta.Amount ?? null,
        resultDesc: ResultDesc,
        receivedAt: new Date().toISOString(),
      });
      return { success: true, message: 'Payment received but no matching order found.' };
    }

    await Data.update('payments', payment.id, {
      state: paid ? 'paid' : 'failed',
      receipt: meta.MpesaReceiptNumber ?? null,
      resultDesc: ResultDesc,
      settledAt: new Date().toISOString(),
    });

    const orderId = payment.data.orderId;
    const order = await findOne('orders', { orderId });

    if (order) {
      if (paid) {
        // Turn the reservation into a real stock decrement.
        const lines: Array<{ sku: string; quantity: number }> = order.data.lines ?? [];

        for (const line of lines) {
          const product = await findProductBySku(line.sku);
          if (!product) continue;

          await Data.update('products', product.id, {
            stock: Math.max(0, (product.data.stock ?? 0) - line.quantity),
            reserved: Math.max(0, (product.data.reserved ?? 0) - line.quantity),
          });
        }

        await Data.update('orders', order.id, { state: 'paid' });
      } else {
        // Same release path the tool rollback and the reaper job use.
        await releaseOrderReservations(orderId, 'payment_failed');
      }
    }

    return {
      success: true,
      orderId,
      state: paid ? 'paid' : 'failed',
      receipt: meta.MpesaReceiptNumber ?? null,
    };
  },
});

export default mpesaCallbackWebhook;