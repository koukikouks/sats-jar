// The backend as one long-running Node process, with the keeper's schedule (`schedule.ts`).
//   node --env-file=<path to .env> backend/src/server.ts
import { createServer } from "node:http";
import { esplora } from "./bitcoin.ts";
import { nearChain, nearKeeperChain } from "./chain.ts";
import { loadConfig } from "./config.ts";
import { fileStore } from "./file-store.ts";
import { createBackend } from "./http.ts";
import { createKeeper } from "./keeper.ts";
import { startKeeper } from "./schedule.ts";

const config = loadConfig(process.env);
const keeper = createKeeper({
  chain: nearKeeperChain(config),
  bitcoin: esplora(),
  now: () => Math.floor(Date.now() / 1000),
});
const handle = createBackend({
  chain: nearChain(config),
  store: fileStore(config.draftsFile),
  appAccount: config.sponsorAccountId,
  keeper,
});

startKeeper(keeper, { log: console.log, error: console.error });

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const response = await handle(
    new Request(new URL(req.url ?? "/", "http://backend"), {
      method: req.method,
      headers: { "content-type": req.headers["content-type"] ?? "application/json" },
      body: hasBody ? Buffer.concat(chunks) : undefined,
    }),
  );
  res.writeHead(response.status, { "content-type": "application/json" });
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(config.port, () => console.log(`backend listening on port ${config.port}`));
