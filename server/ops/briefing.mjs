const MIN_TRANSCRIPT_SECONDS = 180;
const MAX_TRANSCRIPT_SECONDS = 360;
const MAX_BRIEF_ITEMS = 3;
const SAFE_SOURCE_SCHEMES = new Set(["https:", "http:", "obsidian:", "intel-os:"]);

function cleanText(value, maximum = 100) {
  const normalized = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, maximum - 1).trimEnd()}…`;
}

function normalizedUrl(value) {
  const url = new URL(String(value));
  if (!SAFE_SOURCE_SCHEMES.has(url.protocol)) {
    throw new TypeError(`Unsupported citation URL scheme: ${url.protocol}`);
  }
  return url.href;
}

function internalSource(item) {
  const entityType = cleanText(item.entity_type, 40);
  const entityId = cleanText(item.entity_id, 100);
  if (!entityType || !entityId) return null;
  const revision = Number.isSafeInteger(item.revision) ? item.revision : 1;
  return {
    title: `${entityType}: ${entityId} (revision ${revision})`,
    href: `intel-os://entity/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}?revision=${revision}`,
    as_of: item.updated_at || item.created_at || null,
  };
}

function itemSources(item) {
  const payload = item.payload && typeof item.payload === "object" ? item.payload : item;
  const candidates = Array.isArray(payload.sources)
    ? payload.sources
    : payload.source_url
      ? [{ title: payload.source_title || payload.title || "Source", href: payload.source_url }]
      : [];
  const normalized = candidates.map((source) => {
    const href = String(source?.href || source?.url);
    let parsed;
    try {
      parsed = new URL(href);
    } catch {
      throw new TypeError("Citation URL is invalid");
    }
    // Telegram locators contain private chat and message identifiers. Keep the
    // canonical Inbox identity as the citation boundary in Briefs and transcripts.
    if (parsed.protocol === "telegram:") {
      const internal = internalSource(item);
      if (!internal) {
        throw new TypeError("Telegram briefing items require a canonical entity identity");
      }
      return internal;
    }
    return {
      title: cleanText(source?.title || source?.label || "Source", 160),
      href: normalizedUrl(href),
      as_of: source?.as_of || null,
    };
  });
  if (!normalized.length) {
    const internal = internalSource(item);
    if (internal) normalized.push(internal);
  }
  if (!normalized.length) {
    throw new TypeError("Each briefing item requires a source or a canonical entity identity");
  }
  return normalized;
}

function estimateSpeechSeconds(text) {
  const cjk = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) || []).length;
  const withoutCjk = text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu, " ");
  const latinWords = (withoutCjk.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).length;
  return Math.ceil((cjk / 260 + latinWords / 145) * 60);
}

function citationMarker(index) {
  return `[S${index + 1}]`;
}

function normalizeItems(items) {
  if (!Array.isArray(items)) throw new TypeError("items must be an array");
  return items.slice(0, MAX_BRIEF_ITEMS).map((item, itemIndex) => {
    if (!item || typeof item !== "object") throw new TypeError("Briefing items must be objects");
    const payload = item.payload && typeof item.payload === "object" ? item.payload : item;
    return {
      index: itemIndex,
      title: cleanText(payload.title || payload.objective || item.entity_id || `Item ${itemIndex + 1}`, 100),
      assessment: cleanText(payload.current_assessment || payload.summary || payload.objective || "尚未形成穩定判斷。", 110),
      change: cleanText(
        payload.now || payload.before_after || payload.material_change_summary || "目前沒有足夠證據宣告新的實質變化。",
        100,
      ),
      why: cleanText(payload.why_it_matters || payload.why_now || "這項狀況仍可能影響既有判斷與下一步。", 100),
      unknown: cleanText(
        payload.unknown || payload.uncertainty || payload.contradiction || "仍需確認時效、來源完整性與反方證據。",
        100,
      ),
      nextAction: cleanText(payload.next_action || "先維持監看，等待 watch condition 或新證據命中。", 100),
      rawSources: itemSources(item),
    };
  });
}

function assignSources(items) {
  const sources = [];
  const byHref = new Map();
  return {
    items: items.map((item) => {
      const sourceIndexes = item.rawSources.map((source) => {
        if (!byHref.has(source.href)) {
          byHref.set(source.href, sources.length);
          sources.push({
            id: `S${sources.length + 1}`,
            ...source,
          });
        }
        return byHref.get(source.href);
      });
      return { ...item, sourceIndexes };
    }),
    sources,
  };
}

const GUARDRAIL_PARAGRAPHS = Object.freeze([
  "在做決定前，請把『已知』與『推論』分開。已知只包含能回到來源、具有 as-of 時間且仍在有效期限內的內容；推論必須能說明若判斷錯誤，最先會在哪個觀察條件上露出破綻。這樣做的目的不是延後所有行動，而是避免把消息的急迫感誤認成決策的急迫性。",
  "接著檢查反方證據。若目前只有支持原假設的材料，應先降低信心而不是提高信心；若不同來源描述同一事件，也要確認它們是否其實引用同一個上游來源。沒有獨立驗證時，這些材料只能算一條證據鏈，不能算多數共識。",
  "對每個下一步，只保留一個可執行動作，並預先寫下完成條件、停止條件與重新開啟條件。行動結果回來後，先比較原假設與實際結果，再決定要接受、編輯、繼續監看或撤銷；系統不應替使用者自動改變任務目標，也不應把市場觀察直接變成交易指令。",
  "最後看資料覆蓋。若 Feed 過期、來源斷線、Telegram 離線超過可回補窗口，或關鍵觀察值只有手動快照，請把 coverage gap 當成未知，而不是當成沒有事件。沒有 material change 時，合理輸出是 No Change 或 No Action，首頁與語音都應保持安靜。",
]);

function buildTemplateParagraphs(items) {
  const paragraphs = [
    `這是今天的個人 Decision Brief。共選入 ${items.length} 個即將需要判斷的事項；排序依據是是否需要你決定、是否出現實質變化，以及是否存在明確的下一步。以下內容只整理證據、未知與決策條件，不構成投資建議，也不會替你執行交易或改寫 Mission objective。`,
  ];
  for (const item of items) {
    const markers = item.sourceIndexes.map(citationMarker).join(" ");
    paragraphs.push(
      `第 ${item.index + 1} 項，${item.title}。目前判斷是：${item.assessment} 這次需要注意的變化是：${item.change} ${markers}`,
      `它之所以重要，是因為：${item.why} 但目前仍有未知或矛盾：${item.unknown} 因此不要把這段判斷讀成已經證實的結論。${markers}`,
      `建議的唯一下一步是：${item.nextAction} 執行前先確認來源的 as-of、有效期限與 coverage state；執行後把結果送回 Situation，比較 Before 與 Now，再由你選擇 Accept、Edit、Watch 或 Dismiss。${markers}`,
    );
  }
  paragraphs.push(
    "現在進入決策檢查。先問：今天是否真的需要做出不可逆選擇？如果答案是否定的，就把注意力放在最接近命中的 watch condition；如果答案是肯定的，則只處理影響最大、可逆性最低且證據期限最短的那一項，其餘維持監看。",
  );
  for (const paragraph of GUARDRAIL_PARAGRAPHS) {
    if (estimateSpeechSeconds(paragraphs.join("\n\n")) >= MIN_TRANSCRIPT_SECONDS) break;
    paragraphs.push(paragraph);
  }
  paragraphs.push(
    "簡報到此結束。請以來源卡、時間戳與原始 Situation 為準；若新證據沒有改變原假設、影響或下一步，正式結論就是 No Change，系統應保持安靜。",
  );
  return paragraphs;
}

function citationAudit(paragraphs, sources) {
  const text = paragraphs.join("\n");
  const used = new Set(
    [...text.matchAll(/\[S(\d+)\]/g)].map((match) => `S${Number(match[1])}`),
  );
  const known = new Set(sources.map((source) => source.id));
  const unknown = [...used].filter((id) => !known.has(id));
  const unused = [...known].filter((id) => !used.has(id));
  return {
    valid: unknown.length === 0 && unused.length === 0,
    cited_source_count: used.size,
    source_count: sources.length,
    unknown_citations: unknown,
    uncited_sources: unused,
  };
}

export function createTemplateTranscriptGenerator() {
  return Object.freeze({
    id: "template-transcript-v1",
    async generate({ items }) {
      const assigned = assignSources(normalizeItems(items));
      if (!assigned.items.length) {
        return {
          state: "quiet",
          paragraphs: [
            "今天沒有需要你立即處理的 material change、阻塞 Mission 或即將到期的決策。系統維持監看，不用一般新聞填滿簡報，也不產生填充式音訊。",
          ],
          sources: [],
        };
      }
      return {
        state: "ready",
        paragraphs: buildTemplateParagraphs(assigned.items),
        sources: assigned.sources,
      };
    },
  });
}

function fixedTtsAdapter(state, reason) {
  return Object.freeze({
    id: `tts-${state}`,
    state,
    can_synthesize: false,
    reason,
    async synthesize() {
      return Object.freeze({
        state,
        can_synthesize: false,
        artifact_path: null,
        reason,
      });
    },
  });
}

export function createDisabledTtsAdapter(reason = "TTS is disabled for the local Alpha") {
  return fixedTtsAdapter("disabled", reason);
}

export function createUnavailableTtsAdapter(reason = "No reliable local or licensed cloud TTS is available") {
  return fixedTtsAdapter("unavailable", reason);
}

function assertGenerator(generator) {
  if (!generator || typeof generator.generate !== "function") {
    throw new TypeError("transcriptGenerator must implement async generate({ items, locale })");
  }
}

function assertTtsAdapter(adapter) {
  if (!adapter || typeof adapter.synthesize !== "function" || typeof adapter.state !== "string") {
    throw new TypeError("ttsAdapter must expose state and async synthesize({ transcript })");
  }
}

export async function projectDecisionBrief({
  items,
  transcriptGenerator = createTemplateTranscriptGenerator(),
  ttsAdapter = createDisabledTtsAdapter(),
  clock = () => new Date(),
  locale = "zh-TW",
} = {}) {
  assertGenerator(transcriptGenerator);
  assertTtsAdapter(ttsAdapter);
  const generatedAt = clock();
  if (!(generatedAt instanceof Date) || Number.isNaN(generatedAt.getTime())) {
    throw new TypeError("clock must return a valid Date");
  }
  const generated = await transcriptGenerator.generate({ items, locale });
  if (!generated || !Array.isArray(generated.paragraphs) || !Array.isArray(generated.sources)) {
    throw new TypeError("Transcript generator returned an invalid projection");
  }
  const paragraphs = generated.paragraphs.map((paragraph) => cleanText(paragraph, 2_000));
  const sources = generated.sources.map((source, index) => ({
    id: source.id || `S${index + 1}`,
    title: cleanText(source.title || `Source ${index + 1}`, 160),
    href: normalizedUrl(source.href),
    as_of: source.as_of || null,
  }));
  const audit = citationAudit(paragraphs, sources);
  if (!audit.valid) {
    throw new TypeError("Transcript citations do not map one-to-one to the source list");
  }
  const transcript = paragraphs.join("\n\n");
  const estimatedDuration = estimateSpeechSeconds(transcript);
  if (generated.state === "ready" && (
    estimatedDuration < MIN_TRANSCRIPT_SECONDS || estimatedDuration > MAX_TRANSCRIPT_SECONDS
  )) {
    throw new RangeError(
      `Decision Brief must project to 3–6 minutes; estimated ${estimatedDuration} seconds`,
    );
  }

  const audio = await ttsAdapter.synthesize({
    transcript,
    locale,
    sources,
  });
  if (!audio || typeof audio.state !== "string") {
    throw new TypeError("TTS adapter returned an invalid result");
  }
  return Object.freeze({
    schema_version: 1,
    state: generated.state || "ready",
    generated_at: generatedAt.toISOString(),
    locale,
    duration_seconds_estimate: estimatedDuration,
    transcript: paragraphs,
    sources,
    citation_audit: audit,
    audio: {
      state: audio.state,
      can_synthesize: audio.can_synthesize === true,
      artifact_path: audio.artifact_path || null,
      reason: audio.reason || null,
    },
  });
}

export const TRANSCRIPT_LIMITS = Object.freeze({
  minimum_seconds: MIN_TRANSCRIPT_SECONDS,
  maximum_seconds: MAX_TRANSCRIPT_SECONDS,
  maximum_items: MAX_BRIEF_ITEMS,
});
