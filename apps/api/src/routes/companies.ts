import { CreateCompanyBody, Ticker } from "@eia/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context";
import { AppError } from "../errors";
import { addCompany, findCompany, listCompanies, toCompanyResponse } from "../services/companies";
import { listEventsForTicker } from "../services/events";

const TickerParams = z.object({ ticker: Ticker });

export function companyRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/companies", async () => ({ companies: (await listCompanies(ctx)).map(toCompanyResponse) }));

  app.post("/companies", async (req, reply) => {
    const { ticker } = CreateCompanyBody.parse(req.body);
    const { company, created } = await addCompany(ctx, ticker);
    return reply.code(created ? 201 : 200).send(toCompanyResponse(company));
  });

  app.get("/companies/:ticker/events", async (req) => {
    const { ticker } = TickerParams.parse(req.params);
    if (!(await findCompany(ctx, ticker))) {
      throw new AppError("COMPANY_NOT_FOUND", `${ticker} is not on the watchlist`, 404);
    }
    return { events: await listEventsForTicker(ctx, ticker) };
  });
}
