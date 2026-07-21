import { LuaTool, Data } from 'lua-cli';
import { z } from 'zod';
import { stkPush, queryStkStatus, normalizeMsisdn } from '../../services/DarajaService';
import { releaseOrderReservations } from '../../services/Repo';

/**
 * Sends the M-Pesa PIN prompt to the customer's phone.
 *
 * The agent calls this once an order has been created and confirmed, so the
 * customer never leaves the chat to pay.
 */
export class RequestMpesaPaymentTool implements LuaTool {
  name = 'request_mpesa_payment';
  description =
    'Send an M-Pesa STK Push prompt to a customer so they can pay for an order by entering their PIN on their phone. Use only after the order has been created and the customer has confirmed the total.';

  inputSchema = z.object({
    orderId: z.string().describe('The order this payment is for'),
    phone: z.string().describe('Customer phone number, e.g. 0712345678'),
   
    amount: z
      .number()
      .int()
      .positive()
      .max(150_000)
      .describe('Amount in Kenyan shillings'),
  });

  outputSchema = z.object({
    checkoutRequestId: z.string(),
    message: z.string(),
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    let result;
    try {
      result = await stkPush({
        phone: input.phone,
        amount: input.amount,
        accountReference: input.orderId,
        description: 'Order payment',
      });
    } catch (error) {
      // The push never reached Safaricom, so no callback is ever coming and
      // nothing else will free this order's stock. Release it here or the
      // reservation leaks and the shop looks sold out while goods sit unsold.
      await releaseOrderReservations(input.orderId, 'payment_failed');
      throw error;
    }

    await Data.create(
      'payments',
      {
        orderId: input.orderId,
        checkoutRequestId: result.checkoutRequestId,
        merchantRequestId: result.merchantRequestId,
        phone: normalizeMsisdn(input.phone),
        amount: input.amount,
        state: 'pending',
        requestedAt: new Date().toISOString(),
      },
      result.checkoutRequestId
    );

    return {
      checkoutRequestId: result.checkoutRequestId,
      message: `Prompt sent to ${input.phone}. Ask the customer to enter their M-Pesa PIN, then check the status.`,
    };
  }
}

/**
 * Polls a payment. Paired with the callback webhook: the webhook is the source
 * of truth, this is what the agent uses when the customer says "I've paid".
 */
export class CheckPaymentStatusTool implements LuaTool {
  name = 'check_payment_status';
  description =
    'Check whether an M-Pesa payment has gone through. Use when the customer says they have paid, or to confirm before releasing an order.';

  inputSchema = z.object({
    checkoutRequestId: z.string().describe('Returned by request_mpesa_payment'),
  });

  outputSchema = z.object({
    state: z.enum(['paid', 'pending', 'cancelled', 'failed', 'unknown']),
    detail: z.string(),
    nextStep: z.string(),
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    const { state, detail } = await queryStkStatus(input.checkoutRequestId);

    const nextStep = {
      paid: 'Confirm the order to the customer and hand off for fulfilment.',
      pending: 'Wait a few seconds and check again. Do not resend the prompt yet.',
      cancelled: 'Ask the customer if they would like the prompt sent again.',
      failed: 'Explain the problem and offer to retry or use another number.',
      unknown:
        'Do NOT tell the customer the payment failed. Wait about a minute and check again. Do not resend the prompt.',
    }[state];

    return { state, detail, nextStep };
  }
}