import type { OrdersRepository } from "../repositories/orders.js";
import { fromKop } from "../utils/money.js";
import { datesBetween } from "../utils/time.js";
import type { CustomersService } from "./customers.js";

export interface DailyTotal {
  date: string;
  total: number;
  gross: number;
  discount: number;
  net: number;
}

const DAY = 86_400_000;

export class TotalsService {
  constructor(
    private readonly orders: OrdersRepository,
    private readonly customers: CustomersService,
  ) {}

  /**
   * Сумма оплаченных заказов клиента по дням в его таймзоне, from..to включительно.
   * Дни без оплат — с нулём.
   */
  async daily(customerId: string, from: string, to: string): Promise<DailyTotal[]> {
    const timezone = await this.customers.timezone(customerId);
    const dateFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });

    // Смещения таймзон в пределах ±14 ч: берём с запасом в сутки с каждой стороны
    const rows = await this.orders.paidCreatedBetween(
      customerId,
      new Date(Date.parse(`${from}T00:00:00Z`) - DAY),
      new Date(Date.parse(`${to}T00:00:00Z`) + 2 * DAY),
    );

    const sums = new Map(datesBetween(from, to).map((d) => [d, { grossKop: 0, netKop: 0 }]));
    for (const o of rows) {
      const parts = dateFormatter.formatToParts(o.createdAt);
      const year = parts.find((part) => part.type === "year")?.value;
      const month = parts.find((part) => part.type === "month")?.value;
      const day = parts.find((part) => part.type === "day")?.value;
      if (year === undefined || month === undefined || day === undefined) {
        throw new Error("Unable to determine local calendar date");
      }
      const date = `${year.padStart(4, "0")}-${month}-${day}`;
      const cur = sums.get(date);
      if (cur !== undefined) {
        cur.grossKop += o.amountKop;
        cur.netKop += o.amountPaidKop;
      }
    }
    return [...sums].map(([date, { grossKop, netKop }]) => ({
      date,
      total: fromKop(grossKop),
      gross: fromKop(grossKop),
      discount: fromKop(grossKop - netKop),
      net: fromKop(netKop),
    }));
  }
}
