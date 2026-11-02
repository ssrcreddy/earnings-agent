import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const config: NextConfig = {
  // The shared Zod contract is TypeScript source, compiled by Next like the app's own code.
  transpilePackages: ["@eia/shared"],
  // Don't write a generated AGENTS.md into the repo on `next dev`.
  agentRules: false,
  // Self-contained server for the Docker image; traced from the repo root so workspace packages are included.
  output: "standalone",
  outputFileTracingRoot: repoRoot,
};

export default config;
