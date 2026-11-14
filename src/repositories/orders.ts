import type { Db } from "../db.js";

export type OrderApplyResult = "created" | "updated" | "stale";

export interface Order {
  id: string;
  customerId: string;
  amountKop: number;
  amountPaidKop: number;
  discountPercent: string;
  status: "pending" | "paid" | "refunded";
  createdAt: Date;
  updatedAt: Date;
}

interface Row {
  id: string;
  customer_id: string;
  amount_kop: string;
  amount_paid_kop: string;
  discount_percent: string;
  status: Order["status"];
  created_at: Date;
  updated_at: Date;
}

const fromRow = (r: Row): Order => ({
  id: r.id,
  customerId: r.customer_id,
  amountKop: Number(r.amount_kop),
  amountPaidKop: Number(r.amount_paid_kop),
  discountPercent: r.discount_percent,
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class OrdersRepository {
  constructor(private readonly db: Db) {}

  async applyVersion(o: Order): Promise<OrderApplyResult> {
    const client = await this.db.connect();
    let transactionStarted = false;
    let releaseError: Error | undefined;

    try {
      await client.query("BEGIN");
      transactionStarted = true;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [o.id]);

      const { rows } = await client.query<{ updated_at: Date }>(
        `SELECT updated_at FROM orders WHERE id = $1 FOR UPDATE`,
        [o.id],
      );
      const current = rows[0];
      if (current && current.updated_at.getTime() >= o.updatedAt.getTime()) {
        await client.query("COMMIT");
        transactionStarted = false;
        return "stale";
      }

      const values = [
        o.id,
        o.customerId,
        o.amountKop,
        o.amountPaidKop,
        o.discountPercent,
        o.status,
        o.createdAt,
        o.updatedAt,
      ];
      if (current) {
        await client.query(
          `UPDATE orders SET
             customer_id = $2,
             amount_kop = $3,
             amount_paid_kop = $4,
             discount_percent = $5,
             status = $6,
             created_at = $7,
             updated_at = $8
           WHERE id = $1`,
          values,
        );
        await client.query("COMMIT");
        transactionStarted = false;
        return "updated";
      }

      await client.query(
        `INSERT INTO orders (id, customer_id, amount_kop, amount_paid_kop, discount_percent, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        values,
      );
      await client.query("COMMIT");
      transactionStarted = false;
      return "created";
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
          transactionStarted = false;
        } catch (rollbackError) {
          releaseError = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
          throw new AggregateError([error, rollbackError], "Order transaction failed and rollback failed");
        }
      }
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  /** Оплаченные заказы клиента, созданные в [from, to). */
  async paidCreatedBetween(customerId: string, from: Date, to: Date): Promise<Order[]> {
    const { rows } = await this.db.query<Row>(
      `SELECT * FROM orders
        WHERE customer_id = $1 AND status = 'paid' AND created_at >= $2 AND created_at < $3`,
      [customerId, from, to],
    );
    return rows.map(fromRow);
  }
}
