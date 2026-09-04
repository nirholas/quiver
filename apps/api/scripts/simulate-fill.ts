/**
 * Diagnostic: deploy QuiverSettlement to an anvil fork, sign a WETH->USDG order with a fresh key, and simulate
 * settle() through (A) the router package's UniversalRouter interactions and (B) a plain SwapRouter02 call,
 * decoding any revert. Run when a solver reports simulation failures.
 */
import { spawn, execSync } from "node:child_process";
import { createWalletClient, createPublicClient, http, publicActions, parseEther, toHex, maxUint256, decodeErrorResult, encodeFunctionData, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID, PERMIT2, USDG, WETH, erc20Abi, settlementAbi, routerErrorsAbi, quote, buildInteractions } from "@quiverdex/router";
import { signOrder, ZERO_ADDRESS, ZERO_BYTES32 } from "@quiverdex/sdk";

const UP = process.env.RHC_MAINNET_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const PORT = 8300 + Math.floor(Math.random() * 300);
const ANVIL = `http://127.0.0.1:${PORT}`;
const anvil = spawn("anvil", ["--fork-url", UP, "--port", String(PORT), "--silent", "--chain-id", String(CHAIN_ID), "--accounts", "1", "--compute-units-per-second", "150", "--fork-retry-backoff", "2000"], { stdio: "ignore" });
const kill = () => anvil.kill("SIGKILL");
process.on("exit", kill);
const rpc = async (m: string, p: unknown[]) => { const r = await fetch(ANVIL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) }); return ((await r.json()) as { result: unknown }).result; };
for (let i = 0; i < 120; i++) { try { await rpc("eth_chainId", []); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }

const deployerKey = generatePrivateKey(), solverKey = generatePrivateKey(), sellerKey = generatePrivateKey();
const solver = privateKeyToAccount(solverKey), seller = privateKeyToAccount(sellerKey), deployer = privateKeyToAccount(deployerKey);
for (const a of [deployer.address, solver.address, seller.address]) await rpc("anvil_setBalance", [a, toHex(parseEther("10"))]);
const out = execSync(`forge script script/DeploySettlement.s.sol --rpc-url ${ANVIL} --broadcast --skip-simulation 2>&1`, { cwd: new URL("../../../contracts", import.meta.url).pathname, env: { ...process.env, DEPLOYER_PRIVATE_KEY: deployerKey }, encoding: "utf8" });
const settlement = /(?:deployed|expected) QuiverSettlement (0x[0-9a-fA-F]{40})/.exec(out)![1] as Address;
console.log("settlement", settlement);

const chain = { id: CHAIN_ID, name: "fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [ANVIL] } } } as const;
const sellerClient = createWalletClient({ account: seller, chain, transport: http(ANVIL) }).extend(publicActions);
const solverClient = createWalletClient({ account: solver, chain, transport: http(ANVIL) }).extend(publicActions);
const pub = createPublicClient({ chain, transport: http(ANVIL, { batch: true }) }) as PublicClient;
await sellerClient.waitForTransactionReceipt({ hash: await sellerClient.sendTransaction({ to: WETH, value: parseEther("0.2"), data: "0xd0e30db0" }) });
await sellerClient.waitForTransactionReceipt({ hash: await sellerClient.writeContract({ address: WETH, abi: erc20Abi, functionName: "approve", args: [PERMIT2, maxUint256] }) });

const nowSec = Math.floor(Date.now() / 1000);
const order = { seller: seller.address, sellToken: WETH, buyToken: USDG, sellAmount: parseEther("0.1"), minBuyAmount: 1n, receiver: seller.address, deadline: BigInt(nowSec + 600), exclusiveSolver: ZERO_ADDRESS as Address, exclusiveUntil: 0n, appData: ZERO_BYTES32 as Hex };
const signed = await signOrder(order, settlement, (t) => sellerClient.signTypedData({ account: seller, ...t } as never), { chainId: CHAIN_ID });
const onchainHash = await pub.readContract({ address: settlement, abi: settlementAbi, functionName: "hashOrder", args: [order] });
console.log("hashOrder ts == chain:", signed.orderHash.toLowerCase() === (onchainHash as string).toLowerCase());

const q = await quote(pub, WETH, USDG, order.sellAmount, {});
console.log("quote", q.amountOut, q.routes.map((r) => r.hops.map((h) => `${h.venue}${"fee" in h ? "/" + h.fee : ""}`).join(">")));

const errAbi = [...settlementAbi, ...erc20Abi, ...routerErrorsAbi] as const;
function explain(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  console.log("  revert:", msg.split("\n").filter(Boolean).slice(0, 5).join(" | ").slice(0, 600));
  const hex = msg.match(/0x[0-9a-fA-F]{8,}/g) ?? [];
  for (const h of hex.slice(0, 4)) {
    try {
      const d = decodeErrorResult({ abi: errAbi, data: h as Hex });
      console.log("  decoded:", d.errorName, d.args);
      if ((d.errorName as string) === "InteractionFailed") {
        const inner = (d.args as unknown as [bigint, Hex])[1];
        try {
          const di = decodeErrorResult({ abi: errAbi, data: inner });
          console.log("  inner:", di.errorName, di.args);
          if ((di.errorName as string) === "ExecutionFailed") {
            const m2 = (di.args as unknown as [bigint, Hex])[1];
            try { const d2 = decodeErrorResult({ abi: errAbi, data: m2 }); console.log("  inner2:", d2.errorName, d2.args); } catch { console.log("  inner2 raw:", m2.slice(0, 90)); }
          }
        } catch { console.log("  inner raw:", inner.slice(0, 120)); }
      }
    } catch { /* not decodable */ }
  }
}

console.log("== A. UniversalRouter interactions (router package)");
const ixA = buildInteractions(q.routes, order.minBuyAmount, BigInt(nowSec + 600));
try {
  const { result } = await solverClient.simulateContract({ address: settlement, abi: settlementAbi, functionName: "settle", args: [order, signed.permitNonce, signed.permitDeadline, signed.signature, ixA], account: solver });
  console.log("  OK, buyAmount", result);
} catch (e) { explain(e); }

console.log("== A2. raw eth_call for the full revert payload");
try {
  const data = encodeFunctionData({ abi: settlementAbi, functionName: "settle", args: [order, signed.permitNonce, signed.permitDeadline, signed.signature, ixA] });
  const r = await fetch(ANVIL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ from: solver.address, to: settlement, data }, "latest"] }) });
  const j = (await r.json()) as { error?: { data?: unknown; message?: string } };
  const raw = typeof j.error?.data === "string" ? j.error.data : JSON.stringify(j.error?.data);
  console.log("  raw:", String(raw).slice(0, 700));
  if (typeof raw === "string" && raw.startsWith("0x")) {
    const sel = raw.slice(0, 10);
    console.log("  selector", sel);
    if (sel === "0x2efbb8a4") {
      // InteractionFailed(uint256,bytes)? decode manually
      const idx = BigInt("0x" + raw.slice(10, 74));
      const off = Number(BigInt("0x" + raw.slice(74, 138)));
      const len = Number(BigInt("0x" + raw.slice(10 + off * 2, 10 + off * 2 + 64)));
      const inner = "0x" + raw.slice(10 + off * 2 + 64, 10 + off * 2 + 64 + len * 2);
      console.log("  interaction index", idx, "inner", inner.slice(0, 200));
      try { console.log("  inner decoded:", decodeErrorResult({ abi: errAbi, data: inner as Hex })); } catch { console.log("  inner selector", inner.slice(0, 10)); }
    }
  }
} catch (e) { console.log("  raw call failed", e); }
console.log("== trace via cast");
try {
  const data = encodeFunctionData({ abi: settlementAbi, functionName: "settle", args: [order, signed.permitNonce, signed.permitDeadline, signed.signature, ixA] });
  console.log(execSync(`cast call ${settlement} ${data} --from ${solver.address} --rpc-url ${ANVIL} --trace 2>&1 | grep -vE '^\s*$' | cut -c1-230 | head -40`, { encoding: "utf8" }));
} catch (e) { console.log((e as { stdout?: string }).stdout?.slice(0, 3000) ?? String(e)); }

console.log("== B. same order through SwapRouter02 exactInputSingle");
const sr = parseAbi(["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)"]);
const SR02 = "0xCaf681a66D020601342297493863E78C959E5cb2" as const;
const ixB = [
  { target: WETH, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [SR02, order.sellAmount] }) },
  { target: SR02, value: 0n, data: encodeFunctionData({ abi: sr, functionName: "exactInputSingle", args: [{ tokenIn: WETH, tokenOut: USDG, fee: 500, recipient: settlement, amountIn: order.sellAmount, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n }] }) },
];
try {
  const { result } = await solverClient.simulateContract({ address: settlement, abi: settlementAbi, functionName: "settle", args: [order, signed.permitNonce, signed.permitDeadline, signed.signature, ixB], account: solver });
  console.log("  OK, buyAmount", result);
} catch (e) { explain(e); }
kill(); process.exit(0);
