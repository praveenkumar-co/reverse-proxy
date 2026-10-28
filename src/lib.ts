// Library entry point — `import { createServer } from "ninja-reverse-proxy"` resolves here
// (see package.json's "exports" field), not to the CLI (src/index.ts, which starts a process
// and exports nothing importable). Keep this file import-light: it re-exports the public
// barrels rather than pulling in CLI-only concerns like commander or process-level signal
// handlers.
export { createServer, reloadServerConfig } from "./core/cluster/master.js";
export type { RootConfigType } from "./config/schemas/server.schema.js";

export * from "./balancer/index.js";
export * from "./cache/index.js";
export * from "./discovery/index.js";
export * from "./observability/index.js";
export * from "./resilience/index.js";
export * from "./ratelimit/index.js";
export * from "./config/index.js";
