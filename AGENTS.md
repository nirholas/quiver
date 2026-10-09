# AGENTS.md

Operating notes for AI coding agents (Claude Code, Codex, Cursor, Copilot and others) working in this repository. Everything here is derived from the files actually in the tree, so trust it over guesses, and update it when the facts change.

## What this repository is

Intent-based swap aggregation for Robinhood Chain: one-signature Permit2 orders, solver auctions, Uniswap v2/v3/v4 routing, on-chain limit enforcement.

- Source: https://github.com/nirholas/quiver
- Primary language: TypeScript

## Repository layout

- `apps/`
- `contracts/`
- `docs/`
- `packages/`
- `README.md`
- `package.json`

## Setup

```bash
pnpm install
```

## Commands

| Task | Command |
|---|---|
| build | `pnpm run build` |
| test | `pnpm test` |
| typecheck | `pnpm run typecheck` |

Run the test and lint commands above before you consider a change finished. If a command fails on code you did not touch, say so in your report instead of silently skipping it.

## Conventions

- `.env` files are gitignored; never commit credentials, and read configuration from environment variables.
- Commit messages follow Conventional Commits (`type(scope): summary`), matching the existing history.
- Read the surrounding code before adding to it, and match its naming, file organisation and error-handling style.
- Keep `README.md` accurate: if a change alters behaviour, commands or configuration, update the docs in the same commit.
- Do not leave TODO comments, stub functions, placeholder data or commented-out code behind. Finish what you start or leave it out.
- Small, focused commits with a subject line that describes the change, not the act of committing.

## Where to raise things

- Bugs and feature requests: https://github.com/nirholas/quiver/issues
- Questions and ideas: https://github.com/nirholas/quiver/discussions
- Security issues: report privately at https://github.com/nirholas/quiver/security/advisories/new, never in a public issue.
