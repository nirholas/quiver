import { parseAbiItem, type PublicClient } from "viem";
import type { ApiConfig } from "./config.js";
import type { ApiDb } from "./db.js";
import type { Bus } from "./bus.js";

const settledEvent = parseAbiItem(
  "event Settled(bytes32 indexed orderHash, address indexed seller, address indexed solver, address sellToken, address buyToken, uint256 sellSpent, uint256 buyAmount, uint256 fee)",
);

/** Follows Settled logs on the settlement contract and expires orders past their deadline. */
export class Watcher {
  private stopped = false;
  constructor(private readonly cfg: ApiConfig, private readonly db: ApiDb, private readonly bus: Bus, private readonly client: PublicClient) {}

  async tick(): Promise<void> {
    const head = Number(await this.client.getBlockNumber());
    const from = (this.db.cursor("settled") ?? head - 2_000) + 1;
    if (from <= head) {
      const logs = await this.client.getLogs({ address: this.cfg.settlement, event: settledEvent, fromBlock: BigInt(from), toBlock: BigInt(head) });
      const now = Math.floor(Date.now() / 1000);
      for (const l of logs) {
        const hash = l.args.orderHash!.toLowerCase();
        if (this.db.getOrder(hash)) {
          this.db.markFilled(hash, l.transactionHash!, l.args.buyAmount!.toString(), l.args.solver!, now);
          this.bus.publish({ type: "filled", orderHash: hash, txHash: l.transactionHash!, solver: l.args.solver! });
        }
      }
      this.db.setCursor("settled", head);
    }
    this.db.expireStale(Math.floor(Date.now() / 1000));
  }

  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.tick();
      } catch (error) {
        console.error(`[watcher] ${error instanceof Error ? error.message : error}`);
      }
      await new Promise((r) => setTimeout(r, this.cfg.watchMs));
    }
  }

  stop(): void {
    this.stopped = true;
  }
}
