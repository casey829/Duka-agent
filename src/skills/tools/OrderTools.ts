import { LuaTool, Data } from 'lua-cli';
import { z } from 'zod';
import { findProductBySku, ProductRecord } from '../../services/Repo';

/**
 * Stock and orders.
 *
 * The important detail here is that stock is decremented when the order is
 * created, not when payment lands. Two customers asking the agent for the last
 * item at the same time must not both get a payment prompt.
 */

export class CheckStockTool implements LuaTool {
  name = 'check_stock';
  description =
    'Look up a product and how many units are available. Use before quoting a price or creating an order.';

  inputSchema = z.object({
    query: z.string().describe('Product name or partial name the customer mentioned'),
  });

  outputSchema = z.object({
    matches: z.array(
      z.object({
        sku: z.string(),
        name: z.string(),
        priceKes: z.number(),
        available: z.number(),
      })
    ),
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    // Vector search over the indexed searchText, not a field scan.
    const results = await Data.search('products', input.query, 5);

    const matches = (results ?? []).map((entry: any) => {
      const p: ProductRecord = entry.data ?? entry;
      return {
        sku: p.sku,
        name: p.name,
        priceKes: p.priceKes,
        available: Math.max(0, (p.stock ?? 0) - (p.reserved ?? 0)),
      };
    });

    return { matches };
  }
}

export class CreateOrderTool implements LuaTool {
  name = 'create_order';
  description =
    'Create an order and reserve the stock for it. Call this before requesting payment. Always read the total back to the customer before charging them.';

  inputSchema = z.object({
    customerName: z.string(),
    phone: z.string(),
    items: z
      .array(
        z.object({
          sku: z.string(),
          quantity: z.number().int().positive(),
        })
      )
      .min(1),
    deliveryNote: z.string().optional().describe('Pickup branch or delivery address'),
  });

  outputSchema = z.object({
    orderId: z.string(),
    totalKes: z.number(),
    lines: z.array(
      z.object({ sku: z.string(), name: z.string(), quantity: z.number(), lineTotal: z.number() })
    ),
  });

  async execute(input: z.infer<typeof this.inputSchema>) {
    const lines: Array<{ sku: string; name: string; quantity: number; lineTotal: number }> = [];
    let totalKes = 0;

    // Reserve first, then price. If any line fails, roll back what we took so a
    // half-finished order doesn't quietly hold stock hostage.
    const reserved: Array<{ entryId: string; sku: string; quantity: number }> = [];

    try {
      for (const item of input.items) {
        const entry = await findProductBySku(item.sku);
        if (!entry) throw new Error(`We don't stock "${item.sku}".`);

        const product = entry.data;
        const available = (product.stock ?? 0) - (product.reserved ?? 0);
        if (available < item.quantity) {
          throw new Error(
            `Only ${available} of ${product.name} left — not enough for ${item.quantity}.`
          );
        }

        // Partial update: only the field that changed.
        await Data.update('products', entry.id, {
          reserved: (product.reserved ?? 0) + item.quantity,
        });
        reserved.push({ entryId: entry.id, sku: item.sku, quantity: item.quantity });

        const lineTotal = product.priceKes * item.quantity;
        totalKes += lineTotal;
        lines.push({
          sku: item.sku,
          name: product.name,
          quantity: item.quantity,
          lineTotal,
        });
      }
    } catch (error) {
      for (const r of reserved) {
        const current = await findProductBySku(r.sku);
        if (current) {
          await Data.update('products', current.id, {
            reserved: Math.max(0, (current.data.reserved ?? 0) - r.quantity),
          });
        }
      }
      throw error;
    }

    const orderId = `ORD-${Date.now().toString(36).toUpperCase()}`;

    await Data.create(
      'orders',
      {
        orderId,
        customerName: input.customerName,
        phone: input.phone,
        lines,
        totalKes,
        deliveryNote: input.deliveryNote ?? '',
        state: 'awaiting_payment',
        createdAt: new Date().toISOString(),
      },
      orderId
    );

    return { orderId, totalKes, lines };
  }
}