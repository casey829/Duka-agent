import { LuaJob, Data } from 'lua-cli';
import { releaseOrderReservations } from '../services/Repo';

/**
 * Releases stock held by checkouts nobody finished.
 *
 * The tool rollback covers a payment that fails loudly, and the Daraja callback
 * covers a payment that fails at Safaricom. Neither covers the commonest case in
 * practice: the customer reads the total, doesn't reply, and closes WhatsApp.
 * That order sits in `awaiting_payment` forever holding real inventory.
 *
 * Fifteen minutes is chosen to sit just past Daraja's own STK timeout — long
 * enough that a slow customer still entering their PIN is never cut off, short
 * enough that abandoned baskets don't hold stock through a trading day.
 */
const HOLD_MINUTES = 15;

const releaseStaleHoldsJob = new LuaJob({
  name: 'release-stale-holds',
  description:
    'Releases reserved stock from orders left unpaid for more than 15 minutes, so abandoned checkouts do not make the shop look sold out.',

  schedule: {
    type: 'interval',
    seconds: 300,
  },

  timeout: 120,

  execute: async () => {
    const cutoff = Date.now() - HOLD_MINUTES * 60 * 1000;

    // Only orders still awaiting payment can be holding stock.
    const res = await Data.get('orders', { state: 'awaiting_payment' }, 1, 100);
    const candidates = res?.data ?? [];

    const expired: string[] = [];

    for (const row of candidates) {
      const createdAt = Date.parse(row.data?.createdAt ?? '');
      if (!Number.isFinite(createdAt) || createdAt > cutoff) continue;

      const { released } = await releaseOrderReservations(row.data.orderId, 'expired');
      if (released) expired.push(row.data.orderId);
    }

    if (expired.length) {
      console.log(`Released stock for ${expired.length} abandoned order(s): ${expired.join(', ')}`);
    }

    return {
      scanned: candidates.length,
      expired: expired.length,
      orderIds: expired,
    };
  },
});

export default releaseStaleHoldsJob;