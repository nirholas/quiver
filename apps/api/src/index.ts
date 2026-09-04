import "dotenv/config";
import { serve } from "@hono/node-server";
import { createPublicClient, http, type PublicClient } from "viem";
import { loadApiConfig } from "./config.js";
import { ApiDb } from "./db.js";
import { Bus } from "./bus.js";
import { createApi, VERSION } from "./server.js";
import { Watcher } from "./watcher.js";

const cfg = loadApiConfig();
const db = new ApiDb(cfg.dbPath);
const bus = new Bus();
const client = createPublicClient({ transport: http(cfg.rpcUrl, { batch: true, retryCount: 3 }) }) as PublicClient;
const app = createApi({ cfg, db, bus, client });
const watcher = new Watcher(cfg, db, bus, client);

serve({ fetch: app.fetch, port: cfg.port }, (info) => {
  console.log(`Quiver API v${VERSION} on http://localhost:${info.port} settlement ${cfg.settlement} rpc ${cfg.rpcUrl}`);
});
void watcher.run();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    watcher.stop();
    db.close();
    process.exit(0);
  });
}
