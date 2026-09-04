# @quiverdex/solver

The reference solver. Bids `quote * (1 - SOLVER_MARGIN_BPS)` on every RFQ, simulates `settle()` for orders it won (or unrestricted ones), and fills through the UniversalRouter. Needs `SOLVER_PRIVATE_KEY` with ETH on 4663. Guide: [docs/solver.md](../../docs/solver.md).
