import { Data } from 'lua-cli';

/**
 * Thin helpers over the platform Data API.
 *
 * Worth knowing: `Data.get()` takes a *filter*, not an id — `Data.getEntry()`
 * is the by-id call. And `Data.update()` wants the platform-generated entry id,
 * not your own business key. These helpers keep that distinction in one place
 * so the tools can work in terms of SKUs and order numbers.
 */

export interface Entry<T = Record<string, any>> {
  id: string;
  data: T;
}

/** First entry matching a filter, or null. */
export async function findOne<T = Record<string, any>>(
  collection: string,
  filter: Record<string, any>
): Promise<Entry<T> | null> {
  const res = await Data.get(collection, filter, 1, 1);
  const row = res?.data?.[0];
  if (!row) return null;
  return { id: row.id, data: row.data as T };
}

export interface ProductRecord {
  sku: string;
  name: string;
  priceKes: number;
  stock: number;
  reserved: number;
}

export const findProductBySku = (sku: string) =>
  findOne<ProductRecord>('products', { sku });

/**
 * Vector search indexes `searchText`, not the stored fields — so anything that
 * should be findable by `check_stock` has to supply it at creation time.
 */
export const productSearchText = (p: Pick<ProductRecord, 'sku' | 'name'>) =>
  `${p.name} ${p.sku}`;

export interface OrderLine {
  sku: string;
  name: string;
  quantity: number;
  lineTotal: number;
}

/**
 * Release the stock held by an order and mark why.
 *
 * Called from three places — the payment tool when the STK push throws, the
 * Daraja callback when payment fails, and the reaper job when a customer walks
 * away mid-checkout. All three are the same operation, and getting it wrong in
 * any one of them leaks inventory: stock stays reserved forever and the shop
 * looks sold out while the goods sit on the floor.
 *
 * Idempotent by design. Only orders still `awaiting_payment` are released, so
 * a double call cannot double-refund the reservation.
 */
export async function releaseOrderReservations(
  orderId: string,
  newState: 'payment_failed' | 'expired' | 'cancelled'
): Promise<{ released: boolean; lines: number }> {
  const order = await findOne<{ lines: OrderLine[]; state: string }>('orders', { orderId });
  if (!order) return { released: false, lines: 0 };

  if (order.data.state !== 'awaiting_payment') {
    return { released: false, lines: 0 };
  }

  const lines = order.data.lines ?? [];

  for (const line of lines) {
    const product = await findProductBySku(line.sku);
    if (!product) continue;

    await Data.update('products', product.id, {
      reserved: Math.max(0, (product.data.reserved ?? 0) - line.quantity),
    });
  }

  await Data.update('orders', order.id, {
    state: newState,
    releasedAt: new Date().toISOString(),
  });

  return { released: true, lines: lines.length };
}