// The backend as one long-running Node process, with the keeper's hourly schedule.
//   node --env-file=<path to .env> backend/src/server.ts
import { createServer } from "node:http";
import { esplora } from "./bitcoin.ts";
import { nearChain, nearKeeperChain } from "./chain.ts";
import { loadConfig } from "./config.ts";
import { fileStore } from "./file-store.ts";
import { createBackend } from "./http.ts";
import { createKeeper } from "./keeper.ts";

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

// Hourly, so top-ups and payments are proven well inside the light client's window of a few
// days of testnet3 blocks (findings T06). A host without a long-running process points a cron
// at POST /keeper/run instead.
const HOUR = 3_600_000;
setInterval(() => {
  keeper.run().then(
    (report) => console.log(JSON.stringify(report)),
    (error: unknown) => console.error("keeper run failed", error),
  );
}, HOUR);

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
