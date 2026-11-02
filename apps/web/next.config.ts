import type { NextConfig } from "next";

const config: NextConfig = {
  // The shared Zod contract is TypeScript source, compiled by Next like the app's own code.
  transpilePackages: ["@eia/shared"],
  // Don't write a generated AGENTS.md into the repo on `next dev`.
  agentRules: false,
};

export default config;
