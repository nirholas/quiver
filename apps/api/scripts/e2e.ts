/**
 * Whole-system e2e on an anvil fork of Robinhood Chain:
 *   deploy QuiverSettlement to the fork -> boot the API against the fork -> boot the reference solver ->
 *   a fresh seller wraps ETH into WETH, approves Permit2 once, runs an RFQ, signs the order with the winner's
 *   exclusivity, submits -> the solver fills through real Uniswap pools -> the seller holds USDG.
 *
 *   pnpm --filter @quiverdex/api e2e
 */
import { accessSync, constants } from "node:fs";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createWalletClient, http, publicActions, parseEther, toHex, maxUint256, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { serve } from "@hono/node-server";
import { CHAIN_ID, PERMIT2, PUBLIC_RPC_URLS, USDG, WETH, erc20Abi } from "@quiverdex/router";
import { QuiverApi, signOrder, ZERO_ADDRESS, ZERO_BYTES32 } from "@quiverdex/sdk";
import { ApiDb } from "../src/db.js";
import { Bus } from "../src/bus.js";
import { createApi } from "../src/server.js";
import { Watcher } from "../src/watcher.js";
import type { ApiConfig } from "../src/config.js";
import { createPublicClient, type PublicClient } from "viem";

/** Foundry is not always on PATH in this environment; resolve the binary explicitly. */
function foundryBin(name: string): string {
  const candidates = [
    ...(process.env.PATH ?? "").split(":").filter(Boolean).map((d) => `${d}/${name}`),
    `${process.env.HOME ?? "/home/codespace"}/.foundry/bin/${name}`,
  ];
  for (const c of candidates) {
    try { accessSync(c, constants.X_OK); return c; } catch { /* next */ }
  }
  throw new Error(`${name} not found on PATH or in ~/.foundry/bin`);
}



/**
 * fetch() refuses the WHATWG "bad port" list (5060/5061 among them), so a randomly chosen harness port
 * can make every request fail with `bad port`. Pick a port outside that list.
 */
const BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110,
  111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4102, 4137, 4190,
  4444, 4445, 4786, 5060, 5061, 5104, 5106, 5107, 5111, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);
function pickPort(base: number, span: number): number {
  for (;;) {
    const port = base + Math.floor(Math.random() * span);
    if (!BLOCKED_PORTS.has(port)) return port;
  }
}

/**
 * Every public Robinhood Chain RPC rate limits, and anvil's fork backend fails the whole run on a 429.
 * Probe the candidates in random order and fork from the first one that answers.
 */
async function pickUpstream(): Promise<string> {
  const explicit = process.env.RHC_MAINNET_RPC_URL;
  const candidates = explicit ? [explicit] : [...PUBLIC_RPC_URLS].sort(() => Math.random() - 0.5);
  for (const url of candidates) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }), signal: AbortSignal.timeout(8000) });
      const j = (await r.json()) as { result?: string };
      if (j.result) return url;
    } catch { /* try the next one */ }
  }
  throw new Error("no Robinhood Chain RPC answered");
}
const ANVIL_PORT = pickPort(8600, 300);
const ANVIL = `http://127.0.0.1:${ANVIL_PORT}`;
const API_PORT = pickPort(4800, 300);
const children: ChildProcess[] = [];
const kill = () => children.forEach((c) => c.kill("SIGKILL"));
process.on("exit", kill);

process.env.PATH = `${process.env.PATH ?? ""}:${process.env.HOME ?? "/home/codespace"}/.foundry/bin`;

const rpc = async (m: string, p: unknown[]) => {
  const r = await fetch(ANVIL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) });
  const j = (await r.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(`${m}: ${j.error.message}`);
  return j.result;
};
const step = (m: string) => console.log(`\n▸ ${m}`);

async function main() {
  const upstream = await pickUpstream();
  step(`forking ${upstream} on :${ANVIL_PORT}`);
  const anvil = spawn(
    foundryBin("anvil"),
    [
      "--fork-url", upstream, "--port", String(ANVIL_PORT), "--silent", "--chain-id", String(CHAIN_ID), "--accounts", "1",
      // Public endpoints 429 under load; throttle the backend and let it retry rather than abort the run.
      "--compute-units-per-second", "120", "--fork-retry-backoff", "2000", "--retries", "10", "--timeout", "45000",
    ],
    { stdio: "ignore" },
  );
  children.push(anvil);
  for (let i = 0; i < 240; i++) { try { await rpc("eth_chainId", []); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }

  const deployerKey = generatePrivateKey();
  const solverKey = generatePrivateKey();
  const sellerKey = generatePrivateKey();
  const deployer = privateKeyToAccount(deployerKey);
  const solver = privateKeyToAccount(solverKey);
  const seller = privateKeyToAccount(sellerKey);
  for (const a of [deployer.address, solver.address, seller.address]) await rpc("anvil_setBalance", [a, toHex(parseEther("10"))]);

  step("deploying QuiverSettlement to the fork with the real deploy script");
  const out = execSync(
    `${foundryBin("forge")} script script/DeploySettlement.s.sol --rpc-url ${ANVIL} --broadcast --skip-simulation 2>&1`,
    { cwd: new URL("../../../contracts", import.meta.url).pathname, env: { ...process.env, DEPLOYER_PRIVATE_KEY: deployerKey }, encoding: "utf8" },
  );
  const settlement = /(?:deployed|expected) QuiverSettlement (0x[0-9a-fA-F]{40})/.exec(out)?.[1] as Address | undefined;
  if (!settlement) throw new Error(`could not parse settlement address from forge output:\n${out.slice(-1500)}`);
  console.log("  settlement", settlement);

  step(`booting Quiver API on :${API_PORT} against the fork`);
  const cfg: ApiConfig = { rpcUrl: ANVIL, settlement, port: API_PORT, dbPath: ":memory:", rfqWindowMs: 1500, exclusivitySeconds: 20, orderTtlSeconds: 180, v4LookbackBlocks: 20_000, watchMs: 1000 };
  const db = new ApiDb(":memory:");
  const bus = new Bus();
  const pub = createPublicClient({ transport: http(ANVIL, { batch: true }) }) as PublicClient;
  const app = createApi({ cfg, db, bus, client: pub });
  const server = serve({ fetch: app.fetch, port: API_PORT });
  const watcher = new Watcher(cfg, db, bus, pub);
  void watcher.run();
  const API = `http://127.0.0.1:${API_PORT}`;

  step("booting the reference solver");
  const solverProc = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: new URL("../../solver", import.meta.url).pathname,
    env: { ...process.env, QUIVER_API_URL: API, QUIVER_RPC_URL: ANVIL, SOLVER_PRIVATE_KEY: solverKey, SOLVER_NAME: "e2e-solver" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(solverProc);
  solverProc.stdout?.on("data", (d) => process.stdout.write(`  [solver] ${d}`));
  solverProc.stderr?.on("data", (d) => process.stdout.write(`  [solver!] ${d}`));
  for (let i = 0; i < 60; i++) {
    const m = (await (await fetch(`${API}/`)).json()) as { solversConnected: number };
    if (m.solversConnected > 0) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  step("seller wraps 0.2 ETH and approves Permit2 for WETH");
  const chain = { id: CHAIN_ID, name: "RHC fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [ANVIL] } } } as const;
  const sellerClient = createWalletClient({ account: seller, chain, transport: http(ANVIL) }).extend(publicActions);
  await sellerClient.waitForTransactionReceipt({ hash: await sellerClient.sendTransaction({ to: WETH, value: parseEther("0.2"), data: "0xd0e30db0" }) }); // deposit()
  await sellerClient.waitForTransactionReceipt({ hash: await sellerClient.writeContract({ address: WETH, abi: erc20Abi, functionName: "approve", args: [PERMIT2, maxUint256] }) });
  const wethBefore = await sellerClient.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [seller.address] });
  console.log("  seller WETH", wethBefore);

  const api = new QuiverApi(API);
  step("GET /quote 0.1 WETH -> USDG");
  const q = await api.quote(WETH, USDG, parseEther("0.1"));
  console.log(`  aggregate ${q.amountOut} via ${q.routes.map((r) => r.venues.join(">")).join(" + ")}; best direct ${q.bestDirect?.amountOut} (${q.bestDirect?.venue})`);

  step("POST /rfq (solvers bid for 1.5s)");
  const rfq = await api.rfq(WETH, USDG, parseEther("0.1"), seller.address);
  console.log(`  baseline ${rfq.baseline.amountOut}; bids: ${rfq.bids.map((b) => `${b.solver.slice(0, 8)}=${b.amountOut}`).join(", ") || "none"}`);
  if (!rfq.best) throw new Error("no solver bid");

  step("seller signs the order with the winner's exclusivity (one Permit2 witness signature)");
  const nowSec = Math.floor(Date.now() / 1000);
  const minBuy = (BigInt(rfq.best.amountOut) * 997n) / 1000n; // accept up to 0.3% below the winning bid
  const signed = await signOrder(
    {
      seller: seller.address, sellToken: WETH, buyToken: USDG, sellAmount: parseEther("0.1"), minBuyAmount: minBuy, receiver: seller.address,
      deadline: BigInt(nowSec + 180), exclusiveSolver: rfq.best.solver as Address, exclusiveUntil: BigInt(rfq.best.exclusiveUntil), appData: ZERO_BYTES32,
    },
    settlement,
    (typed) => sellerClient.signTypedData({ account: seller, ...typed } as never),
    { chainId: CHAIN_ID },
  );
  console.log("  orderHash", signed.orderHash);

  step("POST /orders");
  const status = await api.submit(signed, rfq.rfqId);
  console.log("  ", status);

  step("waiting for the solver to fill");
  let filled;
  for (let i = 0; i < 60; i++) {
    filled = await api.status(signed.orderHash);
    if (filled.status !== "open") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log("  ", filled);
  if (filled?.status !== "filled") throw new Error(`order not filled: ${JSON.stringify(filled)}`);

  const usdg = await sellerClient.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [seller.address] });
  const wethAfter = await sellerClient.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [seller.address] });
  console.log(`  seller now holds ${usdg} USDG atomic (min was ${minBuy}); WETH ${wethBefore} -> ${wethAfter}`);
  if (usdg < minBuy) throw new Error("seller received less than the signed minimum");
  if (wethBefore - wethAfter !== parseEther("0.1")) throw new Error("seller was debited a different amount than signed");

  step("an unrestricted order (no RFQ) is also picked up by the open-order sweep");
  const signed2 = await signOrder(
    { seller: seller.address, sellToken: WETH, buyToken: USDG, sellAmount: parseEther("0.05"), minBuyAmount: 1n, receiver: seller.address, deadline: BigInt(nowSec + 180), exclusiveSolver: ZERO_ADDRESS, exclusiveUntil: 0n, appData: ZERO_BYTES32 },
    settlement,
    (typed) => sellerClient.signTypedData({ account: seller, ...typed } as never),
    { chainId: CHAIN_ID },
  );
  await api.submit(signed2);
  let filled2;
  for (let i = 0; i < 60; i++) {
    filled2 = await api.status(signed2.orderHash);
    if (filled2.status !== "open") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log("  ", filled2);
  if (filled2?.status !== "filled") throw new Error("second order not filled");

  console.log("\n✔ e2e passed: deploy, quote, rfq, sign, submit, solver fill, watcher, second fill");
  const stats = await (await fetch(`${API}/stats`)).json();
  console.log("  stats", stats, "solvers", await (await fetch(`${API}/solvers`)).json());
  server.close();
  watcher.stop();
  kill();
  process.exit(0);
}

main().catch((e) => {
  console.error("\n✖ e2e failed:", e);
  kill();
  process.exit(1);
});
