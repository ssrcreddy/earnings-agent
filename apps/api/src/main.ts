import { loadConfig } from "./config";
import { closeContext, createContext } from "./context";
import { buildServer } from "./server";
import { startWorker } from "./worker";

// One image, two modes (§11): MODE env var, or the first CLI argument in dev.
const mode = (process.argv[2] ?? process.env.MODE ?? "http").toLowerCase();

async function main(): Promise<void> {
  const config = loadConfig();
  const ctx = createContext(config);
  await ctx.boss.start();

  let shutdown: () => Promise<void>;
  if (mode === "worker") {
    await startWorker(ctx);
    shutdown = () => closeContext(ctx);
  } else if (mode === "http") {
    const app = buildServer(ctx);
    await app.listen({ host: "0.0.0.0", port: config.PORT });
    shutdown = async () => {
      await app.close();
      await closeContext(ctx);
    };
  } else {
    throw new Error(`Unknown MODE "${mode}" (expected http or worker)`);
  }

  // Workers drain before exit (§8): pg-boss stop is graceful.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      ctx.log.info({ signal }, "shutting down");
      shutdown()
        .then(() => process.exit(0))
        .catch((err) => {
          ctx.log.error({ err }, "shutdown failed");
          process.exit(1);
        });
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
