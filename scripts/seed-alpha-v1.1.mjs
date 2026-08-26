import { copyFile, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CorruptionError,
  NotFoundError,
  ValidationError,
  createIntelligenceStore,
  entityDirectory,
  resolveDefaultStorePaths,
  validateLogicalId,
} from "../server/store/index.mjs";
import { containsExcludedSegment, parseExcludedSegments } from "../server/privacy/excluded-segments.mjs";

const ENTITY_TYPES = ["InboxItem", "Situation", "Mission", "Review"];

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertSeedBoundaries(paths, { excludedSegments } = {}) {
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) {
    throw new ValidationError("Seed paths must be an object");
  }
  for (const key of ["vaultRoot", "wikiRoot", "intelRoot", "runtimeRoot"]) {
    if (typeof paths[key] !== "string" || !path.isAbsolute(paths[key])) {
      throw new ValidationError(`${key} must be an absolute path`);
    }
  }

  if (
    isInside(paths.wikiRoot, paths.intelRoot) ||
    isInside(paths.intelRoot, paths.wikiRoot)
  ) {
    throw new ValidationError("The intelligence root must not overlap the read-only Wiki root");
  }
  if (isInside(paths.vaultRoot, paths.runtimeRoot)) {
    throw new ValidationError("Runtime state must remain outside the Obsidian vault");
  }
  const segments = parseExcludedSegments(excludedSegments ?? paths.excludedSegments);
  if (containsExcludedSegment(paths.intelRoot, ["wiki", ...segments])) {
    throw new ValidationError("The seed target cannot be Wiki or an excluded subtree");
  }

  return Object.freeze({
    vaultRoot: path.resolve(paths.vaultRoot),
    wikiRoot: path.resolve(paths.wikiRoot),
    intelRoot: path.resolve(paths.intelRoot),
    runtimeRoot: path.resolve(paths.runtimeRoot),
    excludedSegments: segments,
  });
}

async function assertNoSymlinkPath(root, target) {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ValidationError("Seed target must remain inside vaultRoot");
  }
  let cursor = path.resolve(root);
  for (const segment of ["", ...relative.split(path.sep).filter(Boolean)]) {
    if (segment) cursor = path.join(cursor, segment);
    let info;
    try {
      info = await lstat(cursor);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new CorruptionError(`Seed refused a symlink in the target boundary: ${cursor}`);
    }
    if (!info.isDirectory()) {
      throw new CorruptionError(`Seed target boundary is not a directory: ${cursor}`);
    }
  }
}

function isoAfter(clock, days, hour = 7, minute = 30) {
  const value = clock();
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new ValidationError("Seed clock is invalid");
  date.setUTCDate(date.getUTCDate() + days);
  date.setUTCHours(hour, minute, 0, 0);
  return date.toISOString();
}

function unavailable(id, label, reason, extra = {}) {
  return { id, label, state: "unavailable", as_of: null, reason, ...extra };
}

export function buildAlphaSeedDefinitions({ clock = () => new Date() } = {}) {
  const nextReview = isoAfter(clock, 7, 11, 30);
  const missionReview = isoAfter(clock, 1, 11, 30);
  const noLiveData = "尚未接入或驗證即時資料；不得據此推斷目前市場狀態。";

  return [
    {
      entity_type: "Situation",
      entity_id: "situation-us-inflation-fed",
      payload: {
        title: "美國通膨與 Fed 政策方向",
        status: "watch",
        domain: "macro",
        keywords: [
          "Fed",
          "FOMC",
          "Federal Reserve",
          "CPI",
          "BLS",
          "inflation",
          "PCE",
          "BEA",
          "Truflation",
          "美國通膨",
          "聯準會",
        ],
        feed_ids: [
          "fed.monetary-policy",
          "bls.us-cpi",
          "bea.us-pce",
          "truflation.us-inflation.manual",
          "truflation.us-inflation.api",
        ],
        series_ids: ["CUUR0000SA0", "TruCPI-US"],
        current_assessment: "目前只建立監看框架；尚未取得足以更新判斷的即時證據。",
        before: "Alpha v1.1 尚未建立通膨與利率政策的正式基準。",
        now: "已建立來源角色、缺口與 review 條件；數值仍標示 unavailable。",
        watch_conditions: [
          "BLS CPI 或 BEA PCE 發布新一期官方數值。",
          "Fed 公告、會議紀錄或官員訊息造成政策路徑實質改變。",
          "使用者合法手動輸入新的 Truflation snapshot。",
        ],
        stop_condition: "來源不足或授權不清時停止形成方向性結論，只保留缺口提示。",
        reopen_condition: "取得有日期、來源與授權狀態的新觀察值後重新評估。",
        next_review_at: nextReview,
        confidence: 0,
        requires_decision: false,
        material_change: false,
        evidence: [
          {
            kind: "unknown",
            text: "BLS CPI、BEA PCE 與 Truflation 尚未在本機 Alpha 建立可比較的最新觀察值。",
          },
        ],
        indicator_availability: {
          state: "unavailable",
          indicators: [
            unavailable("bls-cpi", "BLS CPI", noLiveData, { source_role: "official_proxy" }),
            unavailable("bea-pce", "BEA PCE", noLiveData, { source_role: "official_proxy" }),
            unavailable("truflation-us", "Truflation US CPI", "等待使用者合法手動輸入；API feature flag 預設關閉。", {
              source_role: "alternative_inflation_estimate",
            }),
          ],
        },
      },
    },
    {
      entity_type: "Situation",
      entity_id: "situation-ai-infrastructure-cycle",
      payload: {
        title: "AI 基礎建設投資循環",
        status: "watch",
        domain: "industry",
        keywords: [
          "AI",
          "AI infrastructure",
          "artificial intelligence infrastructure",
          "data center",
          "cloud capex",
          "GPU",
          "AI 基礎建設",
          "資料中心",
          "雲端資本支出",
        ],
        feed_ids: [],
        series_ids: [],
        current_assessment: "已建立產業鏈監看框架，但沒有足以確認週期位置的最新證據。",
        before: "既有資訊分散於個人 Wiki，尚未形成可追蹤的 Situation。",
        now: "先以板塊與供應鏈環節呈現；未提供觀察清單前不展開個股。",
        watch_conditions: [
          "雲端業者資本支出、供應商交期或能源需求出現實質變化。",
          "新證據與使用者最近 14 天關注的 AI 基礎建設議題相符。",
        ],
        stop_condition: "只有一般新聞、沒有產業鏈或任務關聯時保持安靜。",
        reopen_condition: "取得財報、官方資料、產業人士輸入或使用者明確關注後重新評估。",
        next_review_at: nextReview,
        confidence: 0,
        requires_decision: false,
        material_change: false,
        evidence: [
          {
            kind: "unknown",
            text: "尚未完成需求、供給、資本支出與瓶頸的最新證據矩陣。",
          },
        ],
        sector_groups: [
          {
            id: "compute-and-semiconductors",
            label: "運算與半導體",
            state: "unavailable",
            members: [],
            reason: "使用者尚未提供持倉、觀察清單或明確個股資料。",
          },
          {
            id: "data-center-networking",
            label: "資料中心與網路",
            state: "unavailable",
            members: [],
            reason: noLiveData,
          },
          {
            id: "power-and-cooling",
            label: "電力、散熱與基礎設施",
            state: "unavailable",
            members: [],
            reason: noLiveData,
          },
        ],
      },
    },
    {
      entity_type: "Situation",
      entity_id: "situation-market-midterm-pullback",
      payload: {
        title: "市場中期回調與風險偏好",
        status: "watch",
        domain: "finance",
        keywords: [
          "midterm pullback",
          "market pullback",
          "risk appetite",
          "dip buying",
          "VIX",
          "VXN",
          "QLD",
          "TQQQ",
          "KDJ",
          "中期回調",
          "市場情緒",
          "抄底",
          "融資維持率",
        ],
        feed_ids: [],
        series_ids: ["VIX", "VXN", "QLD", "TQQQ", "KDJ-WEEKLY-J"],
        current_assessment: "抄底框架已建立，但技術圖表與即時指標尚未提供，不能判定已進入抄底區。",
        before: "指標只有概念清單，未納入 Situation 的可用性與證據狀態。",
        now: "以板塊為主呈現並顯式標記每個指標 unavailable；不自動產生交易 Mission。",
        watch_conditions: [
          "使用者提供 TradingView 圖表或目前持倉／觀察清單。",
          "至少兩類互相獨立的中期回調指標產生可驗證變化。",
          "市場風險變化與 Active Mission 或使用者近期關注交叉命中。",
        ],
        stop_condition: "缺少時點、來源或交叉驗證時，不形成買賣訊號。",
        reopen_condition: "取得有時間戳的圖表、指標與使用者風險邊界後重新評估。",
        next_review_at: nextReview,
        confidence: 0,
        requires_decision: false,
        material_change: false,
        evidence: [
          {
            kind: "unknown",
            text: "估值、情緒、價格結構、成交量、波動率與融資資料目前均未接入。",
          },
        ],
        playbook_reference: {
          label: "中期回調抄底策略",
          uri: "obsidian://open?vault=IntelOS&file=wiki%2Fplaybook.md",
          access: "read_only_source",
        },
        sector_groups: [
          { id: "ai-infrastructure", label: "AI 基礎建設", state: "unavailable", members: [] },
          { id: "semiconductors", label: "半導體", state: "unavailable", members: [] },
          { id: "energy-and-grid", label: "能源與電網", state: "unavailable", members: [] },
        ],
        pullback_indicators: [
          unavailable("valuation", "估值到便宜位置", noLiveData),
          unavailable("sentiment", "市場情緒過低", noLiveData),
          unavailable("price-structure", "底底高＋高點更高", "等待使用者提供 TradingView 圖表。"),
          unavailable("leveraged-etf-volume", "QLD／TQQQ 日或週爆量", noLiveData),
          unavailable("vix-vxn", "VIX／VXN 太高", noLiveData),
          unavailable("margin-balance", "融資餘額太低", noLiveData),
          unavailable("margin-maintenance", "融資維持率太低", noLiveData),
          unavailable("weekly-kdj-j", "KDJ J（週）≤ 0", "等待使用者提供 TradingView 圖表。"),
        ],
        chart: unavailable("tradingview-chart", "TradingView 多指標圖表", "使用者尚未提供圖表；Alpha 不含 PineScript 或自動截圖。"),
      },
    },
    {
      entity_type: "Mission",
      entity_id: "mission-alpha-dogfood",
      payload: {
        title: "Alpha v1.1 個人 dogfood",
        objective: "連續 7–14 天使用 Today → Inbox → Situation → Mission → Review 閉環。",
        status: "active",
        domain: "personal-system",
        why_now: "先驗證個人情報與任務閉環是否每天有用，再考慮團隊模板產品。",
        next_action: "在下一次登入時處理一筆真實 Inbox，並留下 Link、Watch 或 No Action 決定。",
        done_condition: "完成計畫中的 20 個 Inbox、3 個 Domain、3 個 Situations、3 個 Missions、1 個完整 Review 與 2 次正式 No Action。",
        review_date: missionReview,
        stop_condition: "若系統造成訊息疲勞、資料來源不清或要求繞過授權，立即停止該流程。",
        reopen_condition: "修正阻塞並由使用者確認後重新啟動。",
        requires_decision: false,
        action_history: [],
      },
    },
    {
      entity_type: "InboxItem",
      entity_id: "inbox-team-template-plan-archive",
      payload: {
        title: "團隊版情報系統模板規格（Alpha 期間封存）",
        status: "reference_only",
        evidence_status: "manual_snapshot",
        source_type: "internal_plan_reference",
        domain: "product",
        requires_decision: false,
        reference_type: "archived_team_template_plan",
        distribution_scope: "local_only",
        summary: "三週內只做單人版；10 人內團隊模板、上市與商業化規格保留作日後 reference，不進入 Source Wiki。",
        reopen_condition: "個人 Alpha 完成 7–14 天 dogfood 並通過可靠性驗收後再開啟。",
      },
    },
  ];
}

async function mirrorCanonical(sourceIntelRoot, targetIntelRoot) {
  let rootInfo;
  try {
    rootInfo = await lstat(sourceIntelRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new CorruptionError("Dry-run source intelligence root must be a regular directory");
  }
  for (const entityType of ENTITY_TYPES) {
    const directory = entityDirectory(entityType);
    const source = path.join(sourceIntelRoot, directory);
    const target = path.join(targetIntelRoot, directory);
    await mkdir(target, { recursive: true });
    let sourceInfo;
    try {
      sourceInfo = await lstat(source);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
      throw new CorruptionError(`Dry-run refused an unsafe canonical directory: ${directory}`);
    }
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new CorruptionError(`Dry-run refused a canonical symlink: ${directory}/${entry.name}`);
      }
      if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.startsWith(".")) continue;
      validateLogicalId(entry.name.slice(0, -3));
      await copyFile(path.join(source, entry.name), path.join(target, entry.name));
    }
  }
}

async function executeSeed({ store, definitions }) {
  const previews = [];
  const planned = [];
  const skipped = [];
  const blocked = [];

  // Validate the entire canonical store before creating any preview. A broken
  // unrelated file must not be hidden by a successful seed of known IDs.
  try {
    for (const entityType of ENTITY_TYPES) await store.list(entityType, { limit: 10_000 });
  } catch (error) {
    throw new CorruptionError(
      "Seed stopped before writing because canonical state failed validation. Preserve the files and run manual recovery; automatic raw Markdown migration is disabled.",
      { cause: error },
    );
  }

  for (const definition of definitions) {
    validateLogicalId(definition.entity_id);
    try {
      await store.get(definition.entity_type, definition.entity_id);
      skipped.push({
        entity_type: definition.entity_type,
        entity_id: definition.entity_id,
        reason: "already_present_user_owned_noop",
      });
      continue;
    } catch (error) {
      if (!(error instanceof NotFoundError)) {
        throw new CorruptionError(
          `Seed stopped before writing: ${definition.entity_type} ${definition.entity_id} is not a current, valid canonical entity. Preserve it and run manual recovery; automatic raw Markdown migration is disabled.`,
          { cause: error },
        );
      }
    }

    const operation = {
      operation: "create",
      entity_type: definition.entity_type,
      entity_id: definition.entity_id,
      base_revision: 0,
      payload: definition.payload,
    };
    try {
      const preview = await store.preview(operation);
      previews.push(preview.preview_id);
      planned.push({
        operation: operation.operation,
        entity_type: definition.entity_type,
        entity_id: definition.entity_id,
        base_revision: operation.base_revision,
        migration: false,
        diff: preview.diff,
      });
    } catch (error) {
      if (error instanceof ValidationError || error instanceof CorruptionError) {
        blocked.push({
          entity_type: definition.entity_type,
          entity_id: definition.entity_id,
          reason: error.message,
        });
        continue;
      }
      throw error;
    }
  }

  let commit = null;
  if (previews.length === 1) {
    const entity = await store.commit(previews[0]);
    commit = { mode: "single", entities: [entity] };
  } else if (previews.length > 1) {
    const result = await store.commitBatch(previews);
    commit = { mode: "batch", transaction_id: result.transaction_id, entities: result.entities };
  }

  return {
    planned,
    skipped,
    blocked,
    committed: commit?.entities.map((entity) => ({
      entity_type: entity.entity_type,
      entity_id: entity.entity_id,
      revision: entity.revision,
    })) ?? [],
    transaction: commit
      ? { mode: commit.mode, transaction_id: commit.transaction_id ?? null }
      : null,
  };
}

export async function runAlphaSeed({
  paths = resolveDefaultStorePaths(),
  apply = false,
  allowTestRoots = false,
  clock = () => new Date(),
} = {}) {
  const safePaths = assertSeedBoundaries(paths, {
    allowTestRoots,
    excludedSegments: paths.excludedSegments,
  });
  const definitions = buildAlphaSeedDefinitions({ clock });
  await assertNoSymlinkPath(safePaths.vaultRoot, safePaths.intelRoot);

  if (apply) {
    const store = await createIntelligenceStore(safePaths);
    const result = await executeSeed({ store, definitions });
    return { mode: "apply", target: safePaths.intelRoot, target_written: result.committed.length > 0, ...result };
  }

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "intel-os-seed-dry-run-"));
  try {
    const stagingPaths = {
      vaultRoot: path.join(temporaryRoot, "vault"),
      wikiRoot: path.join(temporaryRoot, "vault", "wiki"),
      intelRoot: path.join(temporaryRoot, "vault", "intelligence", "live"),
      runtimeRoot: path.join(temporaryRoot, "runtime"),
    };
    await mkdir(stagingPaths.wikiRoot, { recursive: true });
    await mirrorCanonical(safePaths.intelRoot, stagingPaths.intelRoot);
    const store = await createIntelligenceStore(stagingPaths);
    const result = await executeSeed({ store, definitions });
    return {
      mode: "dry-run",
      target: safePaths.intelRoot,
      target_written: false,
      ...result,
      validated_in_staging: result.committed,
      validation_transaction: result.transaction,
      committed: [],
      transaction: null,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function usage() {
  return [
    "Alpha v1.1 safe seed",
    "",
    "  npm run seed:alpha             Preview in an isolated temporary store (default)",
    "  npm run seed:alpha:apply       Apply with CAS + WAL to the configured intelligence root",
    "",
    "No CLI path argument is accepted. Configure paths with the documented INTEL_OS_*",
    "environment variables and intel-os.config.json; excluded subtrees are never writable.",
  ].join("\n");
}

async function main(argv) {
  const unknown = argv.filter((argument) => !["--apply", "--help", "-h"].includes(argument));
  if (unknown.length) throw new ValidationError(`Unknown seed option: ${unknown[0]}`);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await runAlphaSeed({ apply: argv.includes("--apply") });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.blocked.length) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
