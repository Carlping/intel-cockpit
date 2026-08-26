import { createHash } from "node:crypto";
import { ConnectorValidationError } from "./contracts.mjs";

export const TELEGRAM_SENSOR_RETENTION_MS = 72 * 60 * 60 * 1_000;

const GROUP_STATUSES = new Set([
  "pending_consent",
  "active",
  "paused",
  "privacy_mode_blocking",
  "revoked",
]);
const SIGNAL_STATUSES = new Set([
  "quiet",
  "candidate",
  "live_signal",
  "corroborated",
  "interested",
  "watch",
  "linked",
  "dismissed",
]);

function iso(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("A valid date is required");
  return date.toISOString();
}

function scalarId(value, field) {
  const normalized = String(value ?? "");
  if (!/^-?\d{1,40}$/.test(normalized)) {
    throw new ConnectorValidationError(`${field} is invalid`, { field });
  }
  return normalized;
}

function safeGroup(record) {
  const status = GROUP_STATUSES.has(record?.status) ? record.status : "paused";
  return {
    bot_id: scalarId(record.bot_id, "bot_id"),
    chat_id: scalarId(record.chat_id, "chat_id"),
    owner_user_id: scalarId(record.owner_user_id, "owner_user_id"),
    chat_type: ["group", "supergroup"].includes(record.chat_type)
      ? record.chat_type
      : "supergroup",
    status,
    privacy_readable: record.privacy_readable === true,
    member_count: Number.isSafeInteger(record.member_count) && record.member_count >= 1
      ? record.member_count
      : null,
    consent_user_ids: [...new Set((record.consent_user_ids ?? []).map((value) => scalarId(value, "consent_user_id")))],
    paused_reason: typeof record.paused_reason === "string" ? record.paused_reason.slice(0, 200) : null,
    created_at: iso(record.created_at),
    updated_at: iso(record.updated_at),
    last_message_at: record.last_message_at ? iso(record.last_message_at) : null,
  };
}

function groupKey({ bot_id: botId, chat_id: chatId }) {
  return `${botId}\u0000${chatId}`;
}

function groupStatus(group, { preservePause = true } = {}) {
  if (!group.privacy_readable) return "privacy_mode_blocking";
  if (preservePause && group.status === "paused") return "paused";
  if (group.member_count == null) return "pending_consent";
  // The Bot itself occupies one member slot. Every human participant must consent.
  return group.consent_user_ids.length >= Math.max(0, group.member_count - 1)
    ? "active"
    : "pending_consent";
}

function memoryState(initial = {}) {
  return {
    version: 1,
    active_bot_id: initial.active_bot_id == null ? null : String(initial.active_bot_id),
    groups: Array.isArray(initial.groups) ? initial.groups.map(safeGroup) : [],
  };
}

function groupStoreFromAccessors({ load, save, clock }) {
  let writeQueue = Promise.resolve();
  const mutate = (operation) => {
    const result = writeQueue.then(async () => {
      const state = memoryState(await load());
      const value = await operation(state);
      state.groups = [...new Map(state.groups.map((group) => [groupKey(group), safeGroup(group)])).values()];
      await save(state);
      return value;
    });
    writeQueue = result.catch(() => {});
    return result;
  };
  const find = (state, botId, chatId) => state.groups.find(
    (group) => group.bot_id === String(botId) && group.chat_id === String(chatId),
  );

  return Object.freeze({
    async setActiveBot(botId) {
      return mutate((state) => {
        state.active_bot_id = scalarId(botId, "bot_id");
        state.groups = state.groups.filter((group) => group.bot_id === state.active_bot_id);
      });
    },
    async monitor({ botId, chatId, ownerUserId, chatType, privacyReadable }) {
      return mutate((state) => {
        const now = iso(clock());
        let group = find(state, botId, chatId);
        if (!group) {
          group = safeGroup({
            bot_id: botId,
            chat_id: chatId,
            owner_user_id: ownerUserId,
            chat_type: chatType,
            status: privacyReadable ? "pending_consent" : "privacy_mode_blocking",
            privacy_readable: privacyReadable,
            member_count: null,
            consent_user_ids: [],
            created_at: now,
            updated_at: now,
          });
          state.groups.push(group);
        } else {
          group.owner_user_id = scalarId(ownerUserId, "owner_user_id");
          group.privacy_readable = privacyReadable === true;
          group.status = privacyReadable ? "pending_consent" : "privacy_mode_blocking";
          group.paused_reason = privacyReadable ? null : "privacy_mode_blocking";
          group.updated_at = now;
        }
        return structuredClone(group);
      });
    },
    async consent({ botId, chatId, userId }) {
      return mutate((state) => {
        const group = find(state, botId, chatId);
        if (!group || group.status === "revoked") return null;
        const normalized = scalarId(userId, "user_id");
        group.consent_user_ids = [...new Set([...group.consent_user_ids, normalized])];
        group.updated_at = iso(clock());
        group.status = groupStatus(group, { preservePause: true });
        return structuredClone(group);
      });
    },
    async refresh({ botId, chatId, memberCount, privacyReadable }) {
      return mutate((state) => {
        const group = find(state, botId, chatId);
        if (!group || group.status === "revoked") return null;
        group.member_count = Number.isSafeInteger(memberCount) && memberCount >= 1
          ? memberCount
          : group.member_count;
        group.privacy_readable = privacyReadable === true;
        group.status = groupStatus(group, { preservePause: true });
        if (group.status !== "paused") group.paused_reason = group.status === "privacy_mode_blocking" ? "privacy_mode_blocking" : null;
        group.updated_at = iso(clock());
        return structuredClone(group);
      });
    },
    async pause({ botId, chatId, reason = "paused_by_owner" }) {
      return mutate((state) => {
        const group = find(state, botId, chatId);
        if (!group || group.status === "revoked") return null;
        group.status = "paused";
        group.paused_reason = String(reason).slice(0, 200);
        group.updated_at = iso(clock());
        return structuredClone(group);
      });
    },
    async resume({ botId, chatId }) {
      return mutate((state) => {
        const group = find(state, botId, chatId);
        if (!group || group.status === "revoked") return null;
        group.status = groupStatus(group, { preservePause: false });
        group.paused_reason = group.status === "active" ? null : group.status;
        group.updated_at = iso(clock());
        return structuredClone(group);
      });
    },
    async revoke({ botId, chatId, userId }) {
      return mutate((state) => {
        const group = find(state, botId, chatId);
        if (!group) return null;
        if (userId != null && String(userId) !== group.owner_user_id) {
          group.consent_user_ids = group.consent_user_ids.filter((value) => value !== String(userId));
          group.status = groupStatus(group, { preservePause: false });
        } else {
          group.status = "revoked";
          group.consent_user_ids = [];
          group.paused_reason = "revoked";
        }
        group.updated_at = iso(clock());
        return structuredClone(group);
      });
    },
    async isOwner({ botId, chatId, userId }) {
      const group = find(memoryState(await load()), botId, chatId);
      return Boolean(group && group.status !== "revoked" && group.owner_user_id === String(userId));
    },
    async authorizeSensor({ botId, chatId, userId }) {
      const group = find(memoryState(await load()), botId, chatId);
      return Boolean(
        group
        && group.status === "active"
        && group.privacy_readable
        && group.consent_user_ids.includes(String(userId)),
      );
    },
    async isMonitored({ botId, chatId }) {
      const group = find(memoryState(await load()), botId, chatId);
      return Boolean(group && group.status !== "revoked");
    },
    async markMessage({ botId, chatId, observedAt }) {
      return mutate((state) => {
        const group = find(state, botId, chatId);
        if (!group) return null;
        group.last_message_at = iso(observedAt ?? clock());
        group.updated_at = iso(clock());
        return structuredClone(group);
      });
    },
    async snapshot() {
      const state = memoryState(await load());
      return {
        version: state.version,
        active_bot_id: state.active_bot_id,
        groups: state.groups.map((group) => structuredClone(group)),
      };
    },
  });
}

export function createMemoryTelegramGroupStore({ state = {}, clock = () => new Date() } = {}) {
  let current = memoryState(state);
  return groupStoreFromAccessors({
    clock,
    async load() { return structuredClone(current); },
    async save(next) { current = memoryState(next); },
  });
}

export function createDpapiTelegramGroupStore({
  secretStore,
  secretName = "telegram-group-sensors",
  clock = () => new Date(),
} = {}) {
  if (!secretStore?.read || !secretStore?.write) throw new TypeError("secretStore is required");
  return groupStoreFromAccessors({
    clock,
    async load() {
      const value = await secretStore.read(secretName);
      return value ? JSON.parse(value) : {};
    },
    async save(state) {
      await secretStore.write(secretName, JSON.stringify(state));
    },
  });
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/https?:\/\/\S+/giu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, 4_000);
}

function urlKeys(value) {
  const urls = String(value ?? "").match(/https?:\/\/[^\s<>"']+/giu) ?? [];
  return [...new Set(urls.map((raw) => {
    try {
      const url = new URL(raw.replace(/[),.;!?]+$/u, ""));
      for (const key of [...url.searchParams.keys()]) {
        if (/^(?:utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
      }
      url.hash = "";
      return url.toString();
    } catch {
      return null;
    }
  }).filter(Boolean))];
}

function textTokens(value) {
  const normalized = normalizeText(value);
  const words = normalized.split(/\s+/u).filter((token) => token.length >= 3);
  const han = [...normalized.replace(/[^\p{Script=Han}]/gu, "")];
  const bigrams = han.slice(0, -1).map((character, index) => `${character}${han[index + 1]}`);
  return new Set([...words, ...bigrams].slice(0, 300));
}

function similarity(left, right) {
  const a = textTokens(left);
  const b = textTokens(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function language(value) {
  const text = String(value ?? "");
  if (/[\u3040-\u30ff]/u.test(text)) return "ja";
  if (/[\uac00-\ud7af]/u.test(text)) return "ko";
  const han = text.match(/[\u3400-\u9fff]/gu)?.length ?? 0;
  const latin = text.match(/[a-z]/giu)?.length ?? 0;
  if (han >= 4 && han >= latin * 0.25) return "zh-Hant";
  return latin >= 4 ? "en" : "other";
}

function signalState(initial = {}) {
  return {
    version: 1,
    signals: Array.isArray(initial.signals) ? initial.signals.filter((item) => item?.id) : [],
    stats: initial.stats && typeof initial.stats === "object" ? initial.stats : {},
  };
}

function publicSignal(signal) {
  const safe = structuredClone(signal);
  delete safe.source_keys;
  delete safe.actor_keys;
  delete safe.cluster_text;
  return safe;
}

function sensorStoreFromAccessors({ load, save, clock }) {
  let writeQueue = Promise.resolve();
  const mutate = (operation) => {
    const result = writeQueue.then(async () => {
      const state = signalState(await load());
      const value = await operation(state);
      await save(state);
      return value;
    });
    writeQueue = result.catch(() => {});
    return result;
  };
  const sourceHash = (value) => createHash("sha256").update(String(value)).digest("hex").slice(0, 24);

  return Object.freeze({
    async ingest({ observation, routing, sourceKey, actorKey }) {
      if (observation?.feed_id !== "telegram.group-sensor") {
        throw new ConnectorValidationError("Sensor store accepts only Telegram group observations", { field: "feed_id" });
      }
      return mutate((state) => {
        const now = new Date(clock());
        const nowIso = iso(now);
        const cutoff = now.getTime() - TELEGRAM_SENSOR_RETENTION_MS;
        state.signals = state.signals.filter((item) => Date.parse(item.last_seen_at) >= cutoff);
        const summary = String(observation.summary ?? "").slice(0, 4_000);
        const urls = urlKeys(summary);
        const origin = observation.payload?.forward_origin_key;
        const exactKey = urls[0] || origin || normalizeText(summary).slice(0, 800);
        const exactHash = createHash("sha256").update(exactKey).digest("hex");
        const recent = state.signals.filter((item) => now.getTime() - Date.parse(item.last_seen_at) <= 6 * 60 * 60 * 1_000);
        let signal = recent.find((item) => item.cluster_hash === exactHash);
        if (!signal) signal = recent.find((item) => similarity(item.cluster_text, summary) >= 0.78);
        const isNew = !signal;
        if (!signal) {
          signal = {
            id: `signal-${exactHash.slice(0, 20)}`,
            cluster_hash: exactHash,
            cluster_text: summary,
            title: summary.split(/\r?\n/u)[0].slice(0, 180) || "Telegram 群組訊號",
            summary: summary.slice(0, 2_000),
            source_url: observation.source_url,
            source_language: language(summary),
            first_seen_at: nowIso,
            last_seen_at: nowIso,
            mention_count: 0,
            source_keys: [],
            actor_keys: [],
            matched_interest_ids: [],
            matched_context: [],
            timeline: [],
            status: "quiet",
            evidence_status: "unverified_external",
            score: 0,
            score_components: {},
            user_disposition: null,
          };
          state.signals.push(signal);
        }
        const normalizedSource = sourceHash(sourceKey ?? observation.external_event_id);
        const normalizedActor = sourceHash(actorKey ?? sourceKey ?? observation.external_event_id);
        signal.source_keys = [...new Set([...signal.source_keys, normalizedSource])];
        signal.actor_keys = [...new Set([...signal.actor_keys, normalizedActor])];
        signal.mention_count += 1;
        signal.last_seen_at = nowIso;
        signal.summary = signal.summary || summary.slice(0, 2_000);
        signal.source_url = signal.source_url || observation.source_url;
        signal.matched_interest_ids = [...new Set([
          ...signal.matched_interest_ids,
          ...(observation.matched_interest_ids ?? []),
        ])];
        signal.matched_context = Array.isArray(routing?.matched_context)
          ? routing.matched_context.slice(0, 12)
          : signal.matched_context;
        signal.timeline = [...signal.timeline, {
          observed_at: observation.observed_at,
          source_url: observation.source_url,
          edited: observation.payload?.edited === true,
        }].slice(-20);

        const interest = Math.min(40, Math.max(0, Number(routing?.relevance_score ?? 0) * 10));
        const novelty = isNew ? 20 : 5;
        const velocity = Math.min(15, signal.source_keys.length * 5);
        const credibility = urls.length ? 12 : 8;
        const corroboration = signal.source_keys.length >= 2 ? 10 : 0;
        const total = interest + novelty + velocity + credibility + corroboration;
        const anchored = signal.matched_context.some((item) => ["situation", "mission", "watch_condition"].includes(item.kind));
        signal.score = total;
        signal.score_components = { interest, novelty, velocity, credibility, corroboration };
        signal.independent_source_count = signal.source_keys.length;
        signal.velocity_label = signal.source_keys.length >= 3
          ? "快速擴散"
          : signal.source_keys.length === 2
            ? "兩個獨立來源"
            : "單一來源";
        signal.status = signal.user_disposition
          ? signal.status
          : anchored && signal.source_keys.length >= 2
            ? "corroborated"
            : anchored && total >= 60
              ? "live_signal"
              : total >= 40
                ? "candidate"
                : "quiet";
        if (!SIGNAL_STATUSES.has(signal.status)) signal.status = "quiet";
        return publicSignal(signal);
      });
    },
    async list({ includeQuiet = false } = {}) {
      const state = signalState(await load());
      const cutoff = new Date(clock()).getTime() - TELEGRAM_SENSOR_RETENTION_MS;
      return state.signals
        .filter((item) => Date.parse(item.last_seen_at) >= cutoff)
        .filter((item) => includeQuiet || !["quiet", "dismissed"].includes(item.status))
        .sort((left, right) => right.score - left.score || Date.parse(right.last_seen_at) - Date.parse(left.last_seen_at))
        .map(publicSignal);
    },
    async get(signalId) {
      const signal = signalState(await load()).signals.find((item) => item.id === signalId);
      return signal ? publicSignal(signal) : null;
    },
    async disposition({ signalId, action, situationId }) {
      if (!["interested", "not_interested", "watch", "link_situation"].includes(action)) {
        throw new ConnectorValidationError("Unsupported signal disposition", { field: "action" });
      }
      return mutate((state) => {
        const signal = state.signals.find((item) => item.id === signalId);
        if (!signal) return null;
        signal.user_disposition = action;
        signal.status = action === "not_interested"
          ? "dismissed"
          : action === "link_situation"
            ? "linked"
            : action;
        signal.linked_situation_id = action === "link_situation" ? String(situationId ?? "") : null;
        signal.disposition_at = iso(clock());
        if (action === "not_interested") {
          signal.title = "[dismissed Telegram signal]";
          signal.summary = "";
          signal.cluster_text = "";
          signal.timeline = [];
        }
        return publicSignal(signal);
      });
    },
    async forget({ chatId, userId, messageId }) {
      const actorNeedle = chatId != null && userId != null
        ? sourceHash(`${chatId}:${userId}`)
        : null;
      return mutate((state) => {
        let removed = 0;
        state.signals = state.signals.filter((signal) => {
          const locator = String(signal.source_url ?? "");
          const chatMatches = chatId != null
            && locator.includes(`/chat/${encodeURIComponent(String(chatId))}/`);
          const messageMatches = messageId == null
            || locator.endsWith(`/message/${encodeURIComponent(String(messageId))}`);
          const matches = (chatMatches && messageMatches)
            || Boolean(actorNeedle && signal.actor_keys?.includes(actorNeedle));
          if (matches) removed += 1;
          return !matches;
        });
        return { removed };
      });
    },
    async purge() {
      return mutate((state) => {
        const cutoff = new Date(clock()).getTime() - TELEGRAM_SENSOR_RETENTION_MS;
        const before = state.signals.length;
        state.signals = state.signals.filter((item) => Date.parse(item.last_seen_at) >= cutoff);
        return before - state.signals.length;
      });
    },
  });
}

export function createMemoryTelegramSensorStore({ state = {}, clock = () => new Date() } = {}) {
  let current = signalState(state);
  return sensorStoreFromAccessors({
    clock,
    async load() { return structuredClone(current); },
    async save(next) { current = signalState(next); },
  });
}

export function createDpapiTelegramSensorStore({
  secretStore,
  secretName = "telegram-sensor-queue",
  clock = () => new Date(),
} = {}) {
  if (!secretStore?.read || !secretStore?.write) throw new TypeError("secretStore is required");
  return sensorStoreFromAccessors({
    clock,
    async load() {
      const value = await secretStore.read(secretName);
      return value ? JSON.parse(value) : {};
    },
    async save(state) {
      await secretStore.write(secretName, JSON.stringify(state));
    },
  });
}
