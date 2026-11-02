import { Ticker } from "@eia/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { costs, listAlerts, tickerView, weekView } from "../services/dashboard";

const WeekQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
const AlertsQuery = z.object({ cursor: z.string().optional() });
const TickerParams = z.object({ ticker: Ticker });

export function dashboardRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** ?from=&to= - the week view: prints grouped by day (§21). Defaults to this week, New York time. */
  app.get("/events/week", async (req) => {
    const { from, to } = WeekQuery.parse(req.query);
    return weekView(ctx, from, to);
  });

  /** Brief-ready and guidance-change alerts, newest first, cursor-paged (§21). */
  app.get("/alerts", async (req) => listAlerts(ctx, AlertsQuery.parse(req.query).cursor));

  /** LLM spend grouped by print and purpose (§21). */
  app.get("/admin/costs", async () => costs(ctx));

  /** Ticker page: events and the guidance table across quarters (§22, UC-5). */
  app.get("/companies/:ticker", async (req) => tickerView(ctx, TickerParams.parse(req.params).ticker));
}
