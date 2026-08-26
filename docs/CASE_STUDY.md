# Case study: directing agents to build this system

This document exists because the code alone does not show the interesting part. Anyone
can have an agent generate 33,000 lines of JavaScript. The question a reader should be
able to answer from this repository is narrower and harder: **when an agent writes most
of the code, who decides what "correct" means, and what stops a plausible-looking wrong
answer from reaching a decision?**

Scope of the artifact, so the numbers are not doing rhetorical work: 99 tracked files,
~33,000 lines of runtime code (`server/`, `app/`, `worker/`, `scripts/`), 5,851 lines of
tests across 18 test files, 127 unit tests passing, 12 specification and acceptance
documents in [`docs/`](.). One user, one machine, no deployment.

## 1. The operating model

Work was not "ask the agent to build a dashboard". Every unit of work followed the same
shape, and the artifacts of each step are in this repository:

1. **A written plan with a stated product boundary before any code.**
   [`FACT_CONTEXT_REACTION_DASHBOARD_PLAN_2026-08-20.md`](FACT_CONTEXT_REACTION_DASHBOARD_PLAN_2026-08-20.md)
   opens with `local-only、單人使用、不部署、不自動交易` — local-only, single user, no
   deployment, no automated trading. Every later decision inherits that line.
2. **A survey of what already exists, including the inconvenient parts.** The same plan
   records that the SEC connector spec was present but permanently disabled and its JSON
   parser had no SEC case, that FRED had no connector at all, and that the working tree
   was full of uncommitted changes that must not be reset. Agents are optimistic about
   the current state of a codebase; the plan is where that optimism gets corrected.
3. **Per-phase acceptance criteria, written before the phase starts.** Phase 1 was not
   "add SEC support"; it was: baseline-only first sync, dedupe across restarts, unit
   coverage for 10-Q / 8-K / 6-K, and *fail closed when no contact email is configured*.
4. **An explicit non-goals list.** The plan's `不做` section forbids deployment,
   automated order placement, filling empty states with a news feed, simulating live data
   when credentials are absent, and calling IEX a consolidated market price. Most agent
   failure modes here are not bugs — they are helpfulness. The non-goals list is the
   cheapest control against helpfulness.
5. **A per-phase evidence document, then a handoff document.** Phases 1–3 each end with
   their own doc; [`FACT_CONTEXT_REACTION_FINAL_HANDOFF_2026-08-20.md`](FACT_CONTEXT_REACTION_FINAL_HANDOFF_2026-08-20.md)
   lists the acceptance run, the known limitations, and the optional follow-up work that
   was deliberately *not* done.
6. **A resume protocol.** The plan ends with the first three actions to take when work
   resumes: read this document and the latest phase checkpoint, run `git status --short`
   to confirm the dirty working tree was not cleaned, run the completed phases' focused
   tests. Long agent-assisted projects die at the seams between sessions.

## 2. What the specification refuses to allow

The design constraints that were expensive to hold are all of the same type: they forbid
the system from producing a confident output it has not earned.

| Constraint | Failure it prevents |
| --- | --- |
| `fact_state` and `impact_state` are separate fields | Market movement silently upgrading the certainty of the underlying fact |
| First SEC sync establishes a baseline only | Replaying months of old filings as fresh alerts |
| FRED snapshots keep both observation date and realtime vintage | A later revision rewriting what was knowable at decision time |
| IEX is labelled `iex_proxy`, never a consolidated price | A partial feed being read as the market |
| Parser answers "cannot extract reliably" | A guessed actual/forecast/previous number entering the record |
| `Path Map` refuses default probabilities; the user supplies three paths summing to 100% | The model's prior being mistaken for the user's judgement |
| Truflation is manual-only, with no scraping fallback on 401/403/429 | An availability failure quietly becoming a policy violation |
| Missing configuration, missing credentials, corrupt canonical files all stop the pipeline | A plausible number produced from an unconfigured system |

The agent may draft. It may not change an objective, mark a mission complete, promote
external content to `Known`, alter a probability, or trigger a trade. That is not a
prompt; those paths do not exist in the code.

## 3. Three things review caught

This is the part that is usually missing from AI-built portfolio projects, so it is
stated concretely rather than as a lesson learned.

**Publish-readiness: the code documented its author's private life.** Before this repo
became public, personal absolute paths were hard-coded across README, docs and
`server/wiki/wiki-monitor.mjs`, and the permanently-excluded vault subtree was a literal
constant naming a category of private notes — publishing it would have announced the
existence of those notes to every reader. The fix was not redaction. Vault root,
intelligence root and excluded subtrees moved into an untracked local config
(`intel-os.config.json`, with environment-variable overrides), and the tools now **refuse
to start** until all three are configured, so the private-by-default behaviour is enforced
by code while the sensitive names stay on one machine. Covered by
`tests/privacy-config.test.mjs`.

**A proposed security control was rejected as theatre.** The candidate fix for the
unauthenticated localhost API was a local bearer-token file. It was dropped: any process
running as the same OS user that could call the API could also read the token file, so it
adds ceremony and no boundary. What shipped instead is a mandatory matching `Origin` on
every state-changing `/api` request (missing `Origin` is rejected, not waved through),
plus the residual risk written down in [`THREAT_MODEL.md`](THREAT_MODEL.md) in plain
language: *the local API has no authentication.* Choosing the honest smaller control over
the impressive-sounding one is the decision, and the threat model is where it is auditable.

**CI passed locally and failed on first run.** The rendered-HTML tests import from
`dist/`, so `npm test` only works if the build runs first — a dependency that is invisible
until the pipeline runs on a clean checkout. The workflow now builds before testing, and
the README says why in one line so the next person does not reorder it.

## 4. What is verified, and what is not

CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs lint, build and the
127 unit tests on every push and pull request, plus a non-blocking
`npm audit --audit-level=high`; Dependabot proposes grouped weekly updates.

CI does **not** verify the parts that matter most in production for this system: the
runtime is Windows-only, so Windows DPAPI credential sealing, Task Scheduler behaviour
and the real Obsidian vault interaction are exercised by hand on the target machine, not
in the pipeline. Telegram collection is long polling, so nothing is collected while the
machine is off; the system records `coverage_gap` instead of implying complete data. The
remaining known risks — including a `0.0.x` framework dependency — are listed in
[`THREAT_MODEL.md`](THREAT_MODEL.md) rather than in a footnote.

## 5. What this transfers to

The reusable content of this project is not the dashboard. It is a shape for making
agent-written systems trustworthy: specification before implementation, acceptance
criteria that name the failure and not just the feature, an explicit non-goals list to
absorb the agent's eagerness, fail-closed defaults so an unconfigured or degraded system
produces nothing rather than something, a documented human authority boundary, and a
threat model that states what remains unsolved. None of it depends on which model wrote
the code.

---

## 繁體中文摘要

這份文件回答一個問題：當程式主要由 AI agent 寫出來時，**是誰在定義「正確」，又是什麼機制
阻止一個看起來合理但錯誤的答案影響決策**。

- 工作方式：先寫計畫與產品邊界（local-only、單人、不部署、不自動交易），先盤點現況（包含
  「SEC connector 存在但被停用、parser 沒有 SEC case、FRED 完全沒有 connector、工作樹有大量
  未提交變更不得清除」這些不方便的事實），每個 Phase 都先寫好驗收條件，並附一份 `不做` 清單，
  完成後留下驗收與交接文件，最後定義「下次恢復工作的前三個動作」。
- agent 可以草擬，但不能改 objective、宣告 Mission 完成、把外部內容升級為 `Known`、改機率或
  觸發交易——這不是 prompt 約定，而是程式裡沒有那條路徑。
- Review 攔下的三件事：公開前程式碼寫死個人路徑並以常數形式洩漏私人筆記分類（改成未設定就
  拒絕啟動的本機 config）、local bearer token 被判定為無效防護（改成非 GET 一律要求合法
  `Origin`，並在威脅模型誠實寫明 local API 沒有身份驗證）、CI 首次失敗於 rendered-HTML 測試
  需要先 build。
- 誠實邊界：CI 驗的是平台獨立邏輯，Windows DPAPI、Task Scheduler 與真實 vault 互動仍是手動
  驗證；Telegram long polling 在關機期間標記 `coverage_gap`，不假裝資料完整。
