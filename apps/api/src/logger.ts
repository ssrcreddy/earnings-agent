import pino from "pino";

export type Logger = pino.Logger;

export function createLogger(level: string): Logger {
  const pretty = process.stdout.isTTY && process.env.NODE_ENV !== "production";
  return pino({
    level,
    base: { service: "earnings-agent" },
    ...(pretty ? { transport: { target: "pino-pretty", options: { colorize: true } } } : {}),
  });
}
