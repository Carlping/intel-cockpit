# IntelOS Cockpit

**A local-first intelligence cockpit that turns noisy external data streams into provenance-tracked evidence — and stops at the point where a human must decide.**

English (this file) · [繁體中文](README.zh-TW.md)

---

## What this is

IntelOS Cockpit ingests official statistical releases, regulatory filings, market
reaction data and manually forwarded Telegram messages, separates them by *speed*
and by *trustworthiness*, and presents them as a single `Fact → Context → Reaction`
lineage. Every claim carries its source, its vintage and its verification state.
Nothing becomes a decision without an explicit human confirmation step.

It is **not** a news homepage, a robo-advisor, a trading bot or a Bloomberg terminal
clone. It runs on one machine, binds to `127.0.0.1:4173`, and has no deployed public
instance.

## Why it exists

This repository is a working artifact of a specific engineering thesis: that an
individual directing AI agents can build a data pipeline whose *epistemics* are as
carefully engineered as its plumbing. The interesting parts are therefore not the
charts — they are the constraints:

- **Provenance is structural, not cosmetic.** `fact_state` and `impact_state` are
  separate fields. A repost of the same original channel does not count as a second
  independent source. Missing observations stay missing instead of becoming `0`.
- **The human is the only decision authority.** Agents may draft; they may not change
  an objective, mark a mission complete, promote external content to `Known`, alter a
  probability, or trigger a trade.
- **Failures close, not open.** Unconfigured paths, unreliable parses, missing
  credentials and corrupted canonical files all stop the pipeline and say why, rather
  than emitting a plausible-looking number.
- **The specifications are in the repo.** [`docs/`](docs/) contains the phase plans,
  implementation reports and acceptance evidence that the work was executed against —
  including the threat model that documents what is *not* solved.

## Architecture at a glance

```text
  external streams              ingest & classification          human loop             canonical state
┌────────────────────┐        ┌───────────────────────┐      ┌────────────────┐      ┌──────────────────┐
│ SEC EDGAR          │        │ Inbox                 │      │ swipe triage   │      │ <INTEL_ROOT>     │
│ FRED / BLS / BEA   │ fixed  │  unverified_external  │      │ confirm intent │      │  Situation       │
│ Treasury / CISA    │ egress │ S0–S8 ingest checks   │      │ set path %     │      │  Mission         │
│ Alpaca (IEX proxy) │ allow- │ fact_state            │      │ accept diff    │      │  Review          │
│ Telegram (opt-in)  │ list   │ impact_state          │      │                │      │  Forecast Ledger │
└────────────────────┘   ───▶ └──────────┬────────────┘ ───▶ └────────────────┘ ───▶ └──────────────────┘
                                         ▲                                            CAS + WAL + atomic
                              ┌──────────┴─────────┐                                  rename + read-back
                              │ <VAULT_ROOT>\wiki  │                                  Markdown = truth
                              │ read-only evidence │
                              └────────────────────┘
```

| Zone | Role | Rule |
| --- | --- | --- |
| `<VAULT_ROOT>\wiki` | Source wiki | Read-only; evidence and background knowledge only |
| `<INTEL_ROOT>` | Canonical intelligence | The only authoritative write target |
| `%LOCALAPPDATA%\IntelOS` | Runtime | Queues, checkpoints, WAL, encrypted raw Telegram, cache, quarantine, recovery. Must not live in OneDrive |
| Locally configured excluded subtrees | Private | Never read, searched, indexed, quoted or written |

Markdown in `<INTEL_ROOT>` is the state of record; runtime storage is never a second
source of truth. Every authoritative write goes through preview → `base_revision`
compare-and-swap → WAL → atomic rename → read-back validation.

## The evidence loop

The `Fact → Context → Reaction` panel deliberately draws its three columns from three
different kinds of evidence, and names an explicit incompleteness reason whenever one
is missing:

- **Fact — SEC EDGAR.** Watches allowlisted filings for Alphabet, Tesla, TSMC ADR and
  ASML. The first sync only establishes an accession baseline; it never replays old
  filings as fresh alerts.
- **Context — FRED.** `DFF`, `DGS2`, `DGS10`, `T10YIE`, `DTWEXBGS`, `NFCI`, retaining
  both the observation date and the realtime vintage.
- **Reaction — Alpaca.** The IEX WebSocket is treated as a *partial* real-time proxy.
  After a 15-minute window, historical bars prefer delayed SIP and degrade explicitly
  to IEX when entitlements are missing, recording window, feed, coverage, the SPY
  benchmark and abnormal return.

Related endpoints: `GET /api/v2/now`, `/api/v2/event-windows`, `/api/v2/signals/:id`,
`/api/v2/sources/performance`, `/api/v2/evidence-loop`, and `/api/v2/stream` (SSE).
The v1 API remains compatible. Design and staged acceptance:
[`docs/FACT_CONTEXT_REACTION_DASHBOARD_PLAN_2026-08-20.md`](docs/FACT_CONTEXT_REACTION_DASHBOARD_PLAN_2026-08-20.md).

## Decision boundaries the code enforces

- A single Telegram message cannot enter `Known`, create a mission, move a situation
  probability or trigger a trade — regardless of how credible it looks.
- When the rule-based parser cannot extract actual/forecast/previous reliably, it
  answers "cannot extract reliably" instead of guessing a number.
- `Path Map` refuses to invent domain-default probabilities: the user must supply three
  paths summing to 100% and accept the diff. Fewer than 20 comparable events is labelled
  `heuristic`.
- The `Forecast Ledger` records every path, horizon, outcome and Brier score, so the
  system's own calibration is auditable over time.
- Truflation is manual-only. If the API flag is off or returns 401/403/429, the system
  does **not** fall back to scraping.
- Text-to-speech stays `unavailable` rather than pretending an audio file exists.

## Security posture

Full analysis: [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) · reporting:
[`SECURITY.md`](SECURITY.md).

Enforced in code: canonical write boundary; runtime containment with rejection of
symlinks, junctions and reparse points; refusal to place runtime inside OneDrive;
CAS + WAL + read-back on every write; per-response CSP nonce with
`frame-ancestors 'none'`; static-asset path-traversal guard; a fixed outbound domain
allowlist (no user-supplied fetch targets); credentials stored only via Windows
CurrentUser DPAPI under `%LOCALAPPDATA%\IntelOS\secrets`, never in `localStorage`, `.env`
or logs; and a mandatory matching `Origin` on every state-changing `/api` request.

Honestly unresolved: the localhost API has **no authentication**, so any process running
as the same OS user can drive it. A local token file was considered and rejected — that
same process could read the token, so it would add ceremony without adding a boundary.
Telegram collection is long polling, so nothing is collected while the PC is off; the
system marks `coverage_gap` rather than claiming complete data.

## Getting started

Requirements: Windows, Node.js `>=22.13.0`, npm, and an existing local Obsidian vault.

```powershell
cd "<CHECKOUT>"
Copy-Item intel-os.config.example.json intel-os.config.json
# Fill in vaultRoot, intelRoot and excludedSegments for this machine.
npm install
npm run build
npm run test:unit
```

`intel-os.config.json` is untracked. `INTEL_OS_VAULT_ROOT`, `INTEL_OS_WIKI_ROOT`,
`INTEL_OS_ROOT`, `INTEL_OS_RUNTIME_ROOT` and `INTEL_OS_EXCLUDED_SEGMENTS` override the
file; environment variables win. Until the vault root, the canonical intelligence root
and the permanently excluded subtrees are configured, the tools **refuse to run**.

Seed alpha data — preview first, in an isolated environment that never touches the
target vault:

```powershell
npm run seed:alpha         # preview: additions, backfills, skips, blockers
npm run seed:alpha:apply   # explicit apply, restricted to <INTEL_ROOT>
```

Seeding is idempotent: valid existing entities are treated as user-owned and skipped,
never overwritten by templates, and situations never receive fabricated `Known`
evidence. Legacy, incomplete, hash-mismatched or otherwise damaged canonical files make
the seed fail closed and request manual recovery instead of rewriting raw Markdown.

Routing migration requires an explicit local playbook URI and fails closed without it:

```powershell
node scripts/migrate-alpha-v1.1-routing.mjs --playbook-uri "<LOCAL_PLAYBOOK_URI>"
node scripts/migrate-alpha-v1.1-routing.mjs --apply --playbook-uri "<LOCAL_PLAYBOOK_URI>"
```

Then start the local interface with `npm run local` (or the bundled `.cmd` launcher) and
open [http://127.0.0.1:4173/](http://127.0.0.1:4173/). Closing the console window stops
the collectors and the UI. `npm run start` serves an existing build without rebuilding.

### Telegram (optional)

Use a **dedicated bot** with no admin rights. Private-chat explicit submission works with
Privacy Mode left ON; only the optional private-group sensor requires disabling group
privacy, and even then the backend persists allowlisted chats only. Enter the BotFather
token exclusively in the localhost settings screen — never in a chat, a vault note,
`.env`, git, a URL or a screenshot. After `getMe` verification it is sealed with DPAPI.

Accepted submissions are `/intel`, replies to the bot, and explicit forwards to the bot's
private chat; all of it is treated as untrusted data, so embedded prompts, URLs and
trade instructions are never executed. Group messages land in a DPAPI-encrypted sensor
queue (raw ≤24h, candidates ≤72h) and require per-member `/consent`, with `/pause`,
`/resume`, `/revoke`, `/forget <message_id>` and `/forgetme` available from the phone.

## Verification

```powershell
npm run lint
npm run build
npm run test:unit   # build must precede tests: rendered-HTML tests import dist/
npm test
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs lint, build and the unit
suite on every push and pull request, plus a non-blocking `npm audit --audit-level=high`.
Dependabot proposes grouped weekly updates. Note that the runtime is Windows-only:
CI validates the platform-independent logic, not the DPAPI or Task Scheduler paths.

Daily maintenance (`node scripts/run-intelos-daily-maintenance.mjs`) is conservative by
design: it prunes only expired previews, WAL entries older than 7 days in a terminal
state (`prepared`, in-flight and `recovery_conflict` are kept forever), and `committed`
recovery snapshots older than 14 days with no failures. Any symlink, junction or reparse
escape aborts the sweep before deleting anything.

## Non-goals

No investment advice, no automated order placement, no auto-trading missions. No scraping
of Telegram public groups or channel history, no scraping of Truflation, no automatic
attachment downloads. No PineScript, no automated TradingView screenshots. No
multi-tenancy, no cloud deployment, no public demo instance.

## License

[MIT](LICENSE) — Copyright (c) 2026 Carlping.
