import { createHash, timingSafeEqual } from "node:crypto";
import {
  ConnectorDisabledError,
  ConnectorRequestError,
  ConnectorValidationError,
  createContentHash,
  createHealthReport,
  createObservation,
} from "./contracts.mjs";

export const TELEGRAM_ALLOWED_UPDATES = Object.freeze([
  "message",
  "edited_message",
  "my_chat_member",
]);

const TELEGRAM_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const TELEGRAM_MAX_DELIVERY_ATTEMPTS = 3;
export const TELEGRAM_QUARANTINE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const TOKEN_PATTERN = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;
const TOKEN_IN_TEXT_PATTERN = /\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g;
const COMMANDS = new Set([
  "intel",
  "brief",
  "status",
  "forget",
  "forgetme",
  "revoke",
  "pair",
  "monitor",
  "consent",
  "pause",
  "resume",
]);

const SENSITIVE_SUBMISSION_RULES = Object.freeze([
  {
    category: "secret",
    pattern: /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret|password)\s*[:=]|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}|\bAKIA[0-9A-Z]{16}\b|\bBearer\s+[A-Za-z0-9._~+\/-]{20,})/i,
  },
  {
    category: "personal_data",
    pattern: /(?:\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b\d{3}-\d{2}-\d{4}\b|\b(?:\d[ -]*?){13,19}\b|(?:\+?\d[\d ().-]{8,}\d))/i,
  },
  {
    category: "mnpi",
    pattern: /(?:\bMNPI\b|material non[- ]public|nonpublic earnings|inside(?:r)? information|before (?:the )?(?:public )?(?:release|announcement)|尚未公開.{0,20}(?:財報|重大|併購|收購|消息)|內線消息|重大未公開資訊)/i,
  },
  {
    category: "protected_content",
    pattern: /(?:subscriber[- ]only|paid research|paywalled full[- ]text|do not (?:copy|distribute|forward)|confidential (?:report|research|document)|under (?:an )?NDA|付費(?:研報|報告|全文)|禁止(?:轉傳|散布|複製)|內部機密|機密報告)/i,
  },
]);

function id(value, field) {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).length > 40) {
    throw new ConnectorValidationError(`${field} is invalid`, { field });
  }
  const normalized = String(value);
  if (!/^-?\d+$/.test(normalized)) {
    throw new ConnectorValidationError(`${field} is invalid`, { field });
  }
  return normalized;
}

function validDate(value) {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function telegramDate(seconds, fallback) {
  return Number.isFinite(seconds) ? new Date(seconds * 1_000).toISOString() : fallback;
}

function messageText(message) {
  return typeof message?.text === "string"
    ? message.text.trim()
    : typeof message?.caption === "string"
      ? message.caption.trim()
      : "";
}

export function redactTelegramSecrets(value, token) {
  let safe = String(value ?? "").replace(TOKEN_IN_TEXT_PATTERN, "[REDACTED_TELEGRAM_TOKEN]");
  if (token) safe = safe.split(token).join("[REDACTED_TELEGRAM_TOKEN]");
  return safe;
}

export function classifyTelegramSubmissionRisk(observation) {
  const text = String(observation?.summary ?? "").slice(0, 20_000);
  for (const rule of SENSITIVE_SUBMISSION_RULES) {
    if (rule.pattern.test(text)) {
      return Object.freeze({ quarantine: true, category: rule.category });
    }
  }
  return Object.freeze({ quarantine: false, category: null });
}

export function parseTelegramCommand(message, { botUsername } = {}) {
  const text = messageText(message);
  if (!text.startsWith("/")) return null;
  const match = text.match(/^\/([A-Za-z]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const name = match[1].toLocaleLowerCase("en-US");
  if (!COMMANDS.has(name)) return null;
  if (
    match[2] &&
    botUsername &&
    match[2].toLocaleLowerCase("en-US") !== botUsername.toLocaleLowerCase("en-US")
  ) {
    return null;
  }
  return Object.freeze({ name, argument: (match[3] ?? "").trim() });
}

function attachmentKinds(message) {
  return [
    "animation",
    "audio",
    "document",
    "photo",
    "sticker",
    "video",
    "video_note",
    "voice",
  ].filter((key) => message?.[key] != null);
}

function isPrivateForward(message) {
  return message?.chat?.type === "private" && Boolean(message.forward_origin);
}

function isGroupChat(message) {
  return ["group", "supergroup"].includes(message?.chat?.type);
}

function forwardOriginKey(message) {
  const origin = message?.forward_origin;
  if (!origin || typeof origin !== "object") return null;
  if (origin.type === "channel" && origin.chat?.id != null) {
    return `channel:${origin.chat.id}:${origin.message_id ?? "unknown"}`;
  }
  if (origin.type === "user" && origin.sender_user?.id != null) {
    return `user:${origin.sender_user.id}`;
  }
  if (origin.type === "chat" && origin.sender_chat?.id != null) {
    return `chat:${origin.sender_chat.id}`;
  }
  if (origin.type === "hidden_user") return "hidden_user";
  return `forward:${origin.type ?? "unknown"}`;
}

function forwardOriginMetadata(message) {
  const origin = message?.forward_origin;
  if (!origin || typeof origin !== "object") return {};
  if (origin.type === "channel") {
    return {
      forward_origin_type: "channel",
      forward_origin_key: forwardOriginKey(message),
      ...(origin.chat?.title ? { forward_origin_title: String(origin.chat.title).slice(0, 200) } : {}),
      ...(origin.chat?.username ? { forward_origin_username: String(origin.chat.username).slice(0, 64) } : {}),
      ...(origin.date ? { forward_origin_published_at: telegramDate(origin.date) } : {}),
    };
  }
  if (origin.type === "chat") {
    return {
      forward_origin_type: "chat",
      forward_origin_key: forwardOriginKey(message),
      ...(origin.sender_chat?.title ? { forward_origin_title: String(origin.sender_chat.title).slice(0, 200) } : {}),
      ...(origin.sender_chat?.username ? { forward_origin_username: String(origin.sender_chat.username).slice(0, 64) } : {}),
      ...(origin.date ? { forward_origin_published_at: telegramDate(origin.date) } : {}),
    };
  }
  if (origin.type === "user") {
    const displayName = [origin.sender_user?.first_name, origin.sender_user?.last_name]
      .filter(Boolean)
      .join(" ")
      .slice(0, 200);
    return {
      forward_origin_type: "user",
      forward_origin_key: forwardOriginKey(message),
      ...(displayName ? { forward_origin_title: displayName } : {}),
      ...(origin.date ? { forward_origin_published_at: telegramDate(origin.date) } : {}),
    };
  }
  return {
    forward_origin_type: origin.type ?? "unknown",
    forward_origin_key: forwardOriginKey(message),
    forward_origin_hidden: origin.type === "hidden_user",
    ...(origin.sender_user_name ? { forward_origin_title: String(origin.sender_user_name).slice(0, 200) } : {}),
    ...(origin.date ? { forward_origin_published_at: telegramDate(origin.date) } : {}),
  };
}

export function isExplicitTelegramSubmission(message, { botId, botUsername } = {}) {
  const command = parseTelegramCommand(message, { botUsername });
  if (command?.name === "intel") return true;
  if (isPrivateForward(message)) return true;
  const repliedToBot =
    message?.reply_to_message?.from?.is_bot === true &&
    (botId == null || String(message.reply_to_message.from.id) === String(botId));
  return repliedToBot && Boolean(messageText(message));
}

function submissionText(message, command) {
  if (command?.name === "intel" && command.argument) return command.argument;
  if (command?.name === "intel" && message?.reply_to_message) {
    return messageText(message.reply_to_message);
  }
  return messageText(message);
}

export function telegramUpdateToObservation(
  update,
  { botId, botUsername, observedAt = new Date().toISOString() } = {},
) {
  const message = update?.message ?? update?.edited_message;
  if (!message) return null;
  const command = parseTelegramCommand(message, { botUsername });
  if (!isExplicitTelegramSubmission(message, { botId, botUsername })) return null;
  const text = submissionText(message, command);
  const attachments = attachmentKinds(message);
  if (!text && attachments.length === 0) return null;
  const chatId = id(message.chat?.id, "chat_id");
  const messageId = id(message.message_id, "message_id");
  const publishedAt = telegramDate(message.date, observedAt);
  const revisionAt = telegramDate(message.edit_date, publishedAt);
  const summary = text || `[Attachment omitted: ${attachments.join(", ")}]`;

  return createObservation({
    // Stable across edits: the writer upserts a revised snapshot rather than creating a second card.
    external_event_id: `telegram:${chatId}:${messageId}`,
    feed_id: "telegram.explicit-submit",
    published_at: publishedAt,
    observed_at: observedAt,
    as_of: revisionAt,
    content_hash: createContentHash({ text: summary, revisionAt, attachments }),
    source_url: `telegram://chat/${encodeURIComponent(chatId)}/message/${encodeURIComponent(messageId)}`,
    evidence_status: "unverified_external",
    matched_interest_ids: [],
    materiality: "unscored",
    coverage_state: "complete",
    license_ref: "user_submitted_explicitly",
    title: update.edited_message ? "Edited Telegram submission" : "Telegram submission",
    summary,
    payload: {
      transport: "telegram_bot_api",
      update_id: update.update_id,
      chat_id: chatId,
      message_id: messageId,
      ...(message.from?.id == null ? {} : { sender_id: String(message.from.id) }),
      edited: Boolean(update.edited_message),
      forwarded: Boolean(message.forward_origin),
      ...forwardOriginMetadata(message),
      attachment_kinds: attachments,
      attachment_downloaded: false,
      untrusted: true,
    },
    untrusted_external_content: true,
  });
}

export function telegramGroupUpdateToObservation(
  update,
  { observedAt = new Date().toISOString() } = {},
) {
  const message = update?.message ?? update?.edited_message;
  if (!message || !isGroupChat(message) || message.from?.is_bot === true) return null;
  const text = messageText(message);
  const attachments = attachmentKinds(message);
  if (!text && attachments.length === 0) return null;
  const chatId = id(message.chat?.id, "chat_id");
  const messageId = id(message.message_id, "message_id");
  const senderId = id(message.from?.id, "user_id");
  const publishedAt = telegramDate(message.date, observedAt);
  const revisionAt = telegramDate(message.edit_date, publishedAt);
  const summary = text || `[Attachment omitted: ${attachments.join(", ")}]`;
  const originKey = forwardOriginKey(message);
  return createObservation({
    external_event_id: `telegram-sensor:${chatId}:${messageId}`,
    feed_id: "telegram.group-sensor",
    published_at: publishedAt,
    observed_at: observedAt,
    as_of: revisionAt,
    content_hash: createContentHash({ text: summary, revisionAt, attachments }),
    source_url: `telegram://chat/${encodeURIComponent(chatId)}/message/${encodeURIComponent(messageId)}`,
    evidence_status: "unverified_external",
    matched_interest_ids: [],
    materiality: "unscored",
    coverage_state: "complete",
    license_ref: "private_group_participant_consent",
    title: update.edited_message ? "Edited Telegram group signal" : "Telegram group signal",
    summary,
    payload: {
      transport: "telegram_bot_api",
      update_id: update.update_id,
      chat_id: chatId,
      message_id: messageId,
      sender_id: senderId,
      edited: Boolean(update.edited_message),
      forwarded: Boolean(message.forward_origin),
      ...(originKey ? { forward_origin_key: originKey } : {}),
      attachment_kinds: attachments,
      attachment_downloaded: false,
      ambient_group_sensor: true,
      untrusted: true,
    },
    untrusted_external_content: true,
  });
}

function tupleKey(pair) {
  return `${String(pair.botId ?? pair.bot_id ?? "legacy-unbound")}\u0000${String(pair.chatId ?? pair.chat_id)}\u0000${String(pair.userId ?? pair.user_id)}`;
}

function tupleRecord(pair) {
  return {
    bot_id: String(pair.botId ?? pair.bot_id ?? "legacy-unbound"),
    chat_id: String(pair.chatId ?? pair.chat_id),
    user_id: String(pair.userId ?? pair.user_id),
  };
}

export function createMemoryTelegramAllowlistStore({ chatIds = [], userIds = [], pairs = [] } = {}) {
  const tuples = new Map();
  for (const pair of pairs) tuples.set(tupleKey(pair), tupleRecord(pair));
  for (let index = 0; index < Math.min(chatIds.length, userIds.length); index += 1) {
    const pair = tupleRecord({ chatId: chatIds[index], userId: userIds[index] });
    tuples.set(tupleKey(pair), pair);
  }
  return Object.freeze({
    async isAllowed({ botId, chatId, userId }) {
      return tuples.has(tupleKey({ botId, chatId, userId }));
    },
    async isChatAllowed(chatId, botId) {
      return [...tuples.values()].some(
        (pair) => pair.bot_id === String(botId ?? "legacy-unbound") && pair.chat_id === String(chatId),
      );
    },
    async pair({ botId, chatId, userId }) {
      const pair = tupleRecord({ botId, chatId, userId });
      tuples.set(tupleKey(pair), pair);
    },
    async revoke({ botId, chatId, userId }) {
      for (const [key, pair] of tuples) {
        if (botId != null && pair.bot_id !== String(botId)) continue;
        if (chatId != null && pair.chat_id !== String(chatId)) continue;
        if (userId != null && pair.user_id !== String(userId)) continue;
        tuples.delete(key);
      }
    },
    async setActiveBot(botId) {
      for (const [key, pair] of tuples) {
        if (pair.bot_id !== String(botId)) tuples.delete(key);
      }
    },
    async snapshot() {
      return { pairs: [...tuples.values()] };
    },
  });
}

export function createDpapiTelegramAllowlistStore({
  secretStore,
  secretName = "telegram-allowlist",
} = {}) {
  if (!secretStore?.read || !secretStore?.write) {
    throw new TypeError("secretStore with read/write is required");
  }
  let writeQueue = Promise.resolve();
  const load = async () => {
    const value = await secretStore.read(secretName);
    if (!value) return { pairs: [] };
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed.pairs)) {
      return { pairs: parsed.pairs.map((pair) => tupleRecord({ botId: pair.bot_id, chatId: pair.chat_id, userId: pair.user_id })) };
    }
    const chats = Array.isArray(parsed.chat_ids) ? parsed.chat_ids : [];
    const users = Array.isArray(parsed.user_ids) ? parsed.user_ids : [];
    return {
      pairs: Array.from({ length: Math.min(chats.length, users.length) }, (_, index) =>
        tupleRecord({ chatId: chats[index], userId: users[index] })),
    };
  };
  const mutate = (operation) => {
    writeQueue = writeQueue.then(async () => {
      const state = await load();
      operation(state);
      state.pairs = [...new Map(state.pairs.map((pair) => [tupleKey({ botId: pair.bot_id, chatId: pair.chat_id, userId: pair.user_id }), pair])).values()];
      await secretStore.write(secretName, JSON.stringify(state));
    });
    return writeQueue;
  };

  return Object.freeze({
    async isAllowed({ botId, chatId, userId }) {
      const state = await load();
      return state.pairs.some((pair) => tupleKey({ botId: pair.bot_id, chatId: pair.chat_id, userId: pair.user_id }) === tupleKey({ botId, chatId, userId }));
    },
    async isChatAllowed(chatId, botId) {
      return (await load()).pairs.some(
        (pair) => pair.bot_id === String(botId) && pair.chat_id === String(chatId),
      );
    },
    pair({ botId, chatId, userId }) {
      return mutate((state) => {
        state.pairs.push(tupleRecord({ botId, chatId, userId }));
      });
    },
    revoke({ botId, chatId, userId }) {
      return mutate((state) => {
        state.pairs = state.pairs.filter((pair) => {
          if (botId != null && pair.bot_id !== String(botId)) return true;
          if (chatId != null && pair.chat_id !== String(chatId)) return true;
          if (userId != null && pair.user_id !== String(userId)) return true;
          return false;
        });
      });
    },
    setActiveBot(botId) {
      return mutate((state) => {
        state.pairs = state.pairs.filter((pair) => pair.bot_id === String(botId));
      });
    },
    snapshot: load,
  });
}

function pairingHash(value) {
  return createHash("sha256").update(String(value), "utf8").digest();
}

function pairingMatches(argument, expectedHash) {
  if (!expectedHash || !argument) return false;
  const supplied = pairingHash(argument);
  return supplied.length === expectedHash.length && timingSafeEqual(supplied, expectedHash);
}

function messageFrom(update) {
  return update?.message ?? update?.edited_message;
}

function health(feedId, state, checkedAt, options = {}) {
  return Object.freeze({
    ...createHealthReport({
      feedId,
      state,
      checkedAt,
      coverageState: options.coverageState ?? "unknown",
      lastSuccessAt: options.lastSuccessAt,
      message: options.message,
      retryAfter: options.retryAfter,
    }),
    mode: options.mode ?? "explicit_submit_only",
    privacy_mode_expected: options.privacyModeExpected ?? true,
    attachment_download: false,
    ...options.extra,
  });
}

export class TelegramConnector {
  constructor({
    connectorId = "telegram-explicit-submit",
    tokenStore,
    tokenName = "telegram-bot-token",
    checkpointStore,
    rawStore,
    allowlistStore,
    groupStore = null,
    inboxSink,
    sensorSink = null,
    commandSink = async () => ({ accepted: true }),
    fetchImpl = globalThis.fetch,
    clock = () => new Date(),
  } = {}) {
    if (!tokenStore?.read || !tokenStore?.write) throw new TypeError("tokenStore is required");
    if (!checkpointStore?.load || !checkpointStore?.save) {
      throw new TypeError("checkpointStore is required");
    }
    if (
      !rawStore?.put ||
      !rawStore?.remove ||
      !rawStore?.getFailure ||
      !rawStore?.recordFailure ||
      !rawStore?.clearFailure ||
      !rawStore?.quarantine ||
      !rawStore?.purgeQuarantineOlderThan
    ) {
      throw new TypeError("rawStore with encrypted retry and quarantine support is required");
    }
    if (
      !allowlistStore?.isAllowed ||
      !allowlistStore?.isChatAllowed ||
      !allowlistStore?.pair ||
      !allowlistStore?.revoke
    ) {
      throw new TypeError("allowlistStore is required");
    }
    if (typeof inboxSink !== "function") throw new TypeError("inboxSink is required");
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl is required");
    this.connectorId = connectorId;
    this.tokenStore = tokenStore;
    this.tokenName = tokenName;
    this.checkpointStore = checkpointStore;
    this.rawStore = rawStore;
    this.allowlistStore = allowlistStore;
    this.groupStore = groupStore;
    this.inboxSink = inboxSink;
    this.sensorSink = sensorSink;
    this.commandSink = commandSink;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.bot = null;
    this.pairingCodeHash = null;
    this.monitorCodeHash = null;
    this.monitorCodeExpiresAt = null;
    this.pairedCount = 0;
    this.monitoredGroupCount = 0;
    this.canReadAllGroupMessages = false;
    this.lastHealth = health(this.connectorId, "disabled", this.clock().toISOString(), {
      message: "Telegram connector has not been bootstrapped",
    });
  }

  getHealth() {
    return this.lastHealth;
  }

  async getAllowlistSnapshot() {
    if (typeof this.allowlistStore.snapshot !== "function") {
      return { pairs: [], chat_ids: [], user_ids: [], available: false };
    }
    const snapshot = await this.allowlistStore.snapshot();
    const pairs = Array.isArray(snapshot.pairs) ? snapshot.pairs : [];
    return {
      pairs,
      chat_ids: [...new Set(pairs.map((pair) => String(pair.chat_id)))],
      user_ids: [...new Set(pairs.map((pair) => String(pair.user_id)))],
      available: true,
    };
  }

  async getGroupSnapshot() {
    if (!this.groupStore?.snapshot) return { groups: [], available: false };
    const snapshot = await this.groupStore.snapshot();
    return {
      groups: Array.isArray(snapshot.groups) ? snapshot.groups : [],
      available: true,
    };
  }

  armMonitorCode(code) {
    if (typeof code !== "string" || !/^[a-f0-9]{8,64}$/i.test(code)) {
      throw new ConnectorValidationError("Monitor code is invalid", { field: "monitor_code" });
    }
    this.monitorCodeHash = pairingHash(code);
    this.monitorCodeExpiresAt = this.clock().getTime() + 10 * 60 * 1_000;
    return { armed: true };
  }

  parseCommand(message) {
    return parseTelegramCommand(message, { botUsername: this.bot?.username });
  }

  async #token(provided) {
    const token = provided ?? (await this.tokenStore.read(this.tokenName));
    if (!TOKEN_PATTERN.test(token ?? "")) {
      throw new ConnectorDisabledError("Telegram token is missing or invalid", {
        code: "telegram_token_unavailable",
      });
    }
    return token;
  }

  async #request(method, payload, token, { timeoutMs = 15_000 } = {}) {
    let response;
    try {
      response = await this.fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(payload ?? {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ConnectorRequestError(redactTelegramSecrets(error?.message, token) || "Telegram request failed", {
        code: "telegram_network_error",
      });
    }
    const declaredLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_API_RESPONSE_BYTES) {
      throw new ConnectorRequestError("Telegram response exceeded the size limit", {
        code: "telegram_response_too_large",
      });
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_API_RESPONSE_BYTES) {
      throw new ConnectorRequestError("Telegram response exceeded the size limit", {
        code: "telegram_response_too_large",
      });
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ConnectorRequestError("Telegram returned invalid JSON", {
        code: "telegram_invalid_response",
        status: response.status,
      });
    }
    if (!response.ok || body.ok !== true) {
      const retryAfter = Number(body.parameters?.retry_after);
      throw new ConnectorRequestError(
        redactTelegramSecrets(body.description, token) || `Telegram returned HTTP ${response.status}`,
        {
          code: response.status === 429 ? "telegram_rate_limited" : "telegram_api_error",
          status: response.status,
          retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined,
        },
      );
    }
    return body.result;
  }

  async bootstrap({ token, pairingCode } = {}) {
    const checkedAt = this.clock().toISOString();
    try {
      const activeToken = await this.#token(token);
      const bot = await this.#request("getMe", {}, activeToken);
      if (!bot?.id || !bot?.is_bot) throw new Error("Telegram getMe returned an invalid bot");
      if (token) await this.tokenStore.write(this.tokenName, token);
      this.canReadAllGroupMessages = bot.can_read_all_group_messages === true;
      this.bot = {
        id: String(bot.id),
        username: bot.username ?? null,
        can_read_all_group_messages: this.canReadAllGroupMessages,
      };
      await this.allowlistStore.setActiveBot?.(this.bot.id);
      await this.groupStore?.setActiveBot?.(this.bot.id);
      const allowlist = await this.getAllowlistSnapshot();
      const groupSnapshot = await this.getGroupSnapshot();
      for (const group of groupSnapshot.groups.filter((item) => item.status !== "revoked")) {
        const memberCount = await this.#groupMemberCount(group.chat_id).catch(() => null);
        await this.groupStore.refresh({
          botId: this.bot.id,
          chatId: group.chat_id,
          memberCount,
          privacyReadable: this.canReadAllGroupMessages,
        });
      }
      const refreshedGroupSnapshot = await this.getGroupSnapshot();
      this.pairedCount = allowlist.available ? allowlist.pairs.length : 0;
      this.monitoredGroupCount = refreshedGroupSnapshot.available
        ? refreshedGroupSnapshot.groups.filter((group) => group.status !== "revoked").length
        : 0;
      this.pairingCodeHash = pairingCode ? pairingHash(pairingCode) : null;
      const privacyBlocking = this.monitoredGroupCount > 0 && !this.canReadAllGroupMessages;
      this.lastHealth = health(this.connectorId, privacyBlocking ? "degraded" : "healthy", checkedAt, {
        coverageState: "unknown",
        lastSuccessAt: checkedAt,
        message: privacyBlocking
          ? "privacy_mode_blocking: group sensors are paused until Group Privacy is disabled and the bot is re-added"
          : `Telegram bot authenticated; ${this.pairedCount} paired identity; ${this.monitoredGroupCount} monitored group; hybrid sensor mode ready`,
        mode: this.monitoredGroupCount > 0 ? "hybrid_sensor" : "explicit_submit_only",
        privacyModeExpected: this.monitoredGroupCount === 0,
        extra: {
          bot_username: this.bot.username,
          paired_count: this.pairedCount,
          monitored_group_count: this.monitoredGroupCount,
          can_read_all_group_messages: this.canReadAllGroupMessages,
          privacy_mode_blocking: privacyBlocking,
        },
      });
      return { ok: true, bot: { ...this.bot }, health: this.lastHealth };
    } catch (error) {
      const message = redactTelegramSecrets(error?.message, token);
      this.lastHealth = health(this.connectorId, "error", checkedAt, {
        message: message || "Telegram bootstrap failed",
      });
      return {
        ok: false,
        error: { code: error?.code ?? "telegram_bootstrap_failed", message },
        health: this.lastHealth,
      };
    }
  }

  async #authorizeOrPair(message, command) {
    const chatId = id(message.chat?.id, "chat_id");
    const userId = id(message.from?.id, "user_id");
    if (command?.name === "pair" && pairingMatches(command.argument, this.pairingCodeHash)) {
      await this.allowlistStore.pair({ botId: this.bot?.id, chatId, userId });
      const allowlist = await this.getAllowlistSnapshot();
      this.pairedCount = allowlist.available ? allowlist.pairs.length : this.pairedCount + 1;
      this.pairingCodeHash = null;
      return { allowed: true, paired: true, chatId, userId };
    }
    return {
      allowed: await this.allowlistStore.isAllowed({ botId: this.bot?.id, chatId, userId }),
      paired: false,
      chatId,
      userId,
    };
  }

  async #groupMemberCount(chatId) {
    const token = await this.#token();
    const count = await this.#request("getChatMemberCount", { chat_id: chatId }, token);
    return Number.isSafeInteger(count) && count >= 1 ? count : null;
  }

  async #refreshMonitoredGroup(chatId) {
    if (!this.groupStore) return null;
    const memberCount = await this.#groupMemberCount(chatId).catch(() => null);
    const group = await this.groupStore.refresh({
      botId: this.bot.id,
      chatId,
      memberCount,
      privacyReadable: this.canReadAllGroupMessages,
    });
    const snapshot = await this.getGroupSnapshot();
    this.monitoredGroupCount = snapshot.groups.filter((item) => item.status !== "revoked").length;
    return group;
  }

  async #processGroupControl(update, message, command) {
    if (!this.groupStore || !isGroupChat(message) || !command) return null;
    const chatId = id(message.chat.id, "chat_id");
    const userId = id(message.from.id, "user_id");
    const deliveryKey = `${this.connectorId}:${update.update_id}:group-control`;

    if (command.name === "monitor") {
      const monitorCodeExpired = !this.monitorCodeExpiresAt
        || this.clock().getTime() > this.monitorCodeExpiresAt;
      if (monitorCodeExpired || !pairingMatches(command.argument, this.monitorCodeHash)) {
        return { disposition: "monitor_code_rejected" };
      }
      await this.groupStore.monitor({
        botId: this.bot.id,
        chatId,
        ownerUserId: userId,
        chatType: message.chat.type,
        privacyReadable: this.canReadAllGroupMessages,
      });
      this.monitorCodeHash = null;
      this.monitorCodeExpiresAt = null;
      const group = await this.#refreshMonitoredGroup(chatId);
      await this.commandSink({
        delivery_key: deliveryKey,
        command: { name: "monitor", argument: "" },
        update_id: update.update_id,
        message_id: String(message.message_id),
        chat_id: chatId,
        user_id: userId,
        group,
        untrusted_external_content: true,
        execute_tools: false,
        create_mission: false,
      });
      return { disposition: "monitor_registered", group_status: group?.status ?? "pending_consent" };
    }

    if (!(await this.groupStore.isMonitored({ botId: this.bot.id, chatId }))) return null;

    if (command.name === "consent") {
      await this.groupStore.consent({ botId: this.bot.id, chatId, userId });
      let group = await this.#refreshMonitoredGroup(chatId);
      if (group?.status === "paused" && group.paused_reason === "membership_changed_requires_consent") {
        group = await this.groupStore.resume({ botId: this.bot.id, chatId });
      }
      await this.commandSink({
        delivery_key: deliveryKey,
        command: { name: "consent", argument: "" },
        update_id: update.update_id,
        message_id: String(message.message_id),
        chat_id: chatId,
        user_id: userId,
        group,
        untrusted_external_content: true,
        execute_tools: false,
        create_mission: false,
      });
      return { disposition: "consent_recorded", group_status: group?.status ?? "pending_consent" };
    }

    if (!["pause", "resume", "revoke"].includes(command.name)) return null;
    if (!(await this.groupStore.isOwner({ botId: this.bot.id, chatId, userId }))) {
      return { disposition: "group_control_owner_rejected" };
    }
    let group;
    if (command.name === "pause") {
      group = await this.groupStore.pause({ botId: this.bot.id, chatId, reason: "paused_by_owner" });
    } else if (command.name === "resume") {
      group = await this.#refreshMonitoredGroup(chatId);
      if (group?.status === "paused") group = await this.groupStore.resume({ botId: this.bot.id, chatId });
    } else {
      group = await this.groupStore.revoke({ botId: this.bot.id, chatId });
    }
    await this.commandSink({
      delivery_key: deliveryKey,
      command: { name: command.name, argument: "" },
      update_id: update.update_id,
      message_id: String(message.message_id),
      chat_id: chatId,
      user_id: userId,
      group,
      group_control: true,
      untrusted_external_content: true,
      execute_tools: false,
      create_mission: false,
    });
    return { disposition: `group_${command.name}`, group_status: group?.status ?? "revoked" };
  }

  async #processGroupSensor(update, message, observedAt) {
    if (!this.groupStore || !this.sensorSink || !isGroupChat(message)) return null;
    const chatId = id(message.chat.id, "chat_id");
    const userId = id(message.from.id, "user_id");
    if (!(await this.groupStore.isMonitored({ botId: this.bot.id, chatId }))) return null;
    if (message.from?.is_bot === true || message.sender_chat) {
      return { disposition: "group_sensor_unsupported_sender" };
    }
    const authorized = await this.groupStore.authorizeSensor({
      botId: this.bot.id,
      chatId,
      userId,
    });
    if (!authorized) return { disposition: "group_sensor_unconsented_ignored" };
    const observation = telegramGroupUpdateToObservation(update, { observedAt });
    if (!observation) return { disposition: "group_sensor_empty_ignored" };
    const risk = classifyTelegramSubmissionRisk(observation);
    if (risk.quarantine) return this.#quarantineSensitiveUpdate({ update, category: risk.category });
    const deliveryKey = `${this.connectorId}:${update.update_id}:sensor`;
    const sourceKey = observation.payload?.forward_origin_key
      ?? `${chatId}:${userId}`;
    return this.#deliverPersistedUpdate({
      update,
      deliveryKind: "sensor",
      deliver: async () => {
        await this.sensorSink({
          delivery_key: deliveryKey,
          observation,
          source_key: sourceKey,
          actor_key: `${chatId}:${userId}`,
          auto_create_mission: false,
          execute_external_content: false,
        });
        await this.groupStore.markMessage({ botId: this.bot.id, chatId, observedAt });
      },
      success: { disposition: "group_sensor", externalEventId: observation.external_event_id },
    });
  }

  async #deliverPersistedUpdate({ update, deliveryKind, deliver, success }) {
    const persisted = await this.rawStore.put({ botId: this.bot.id, update });
    if (persisted?.quarantined) {
      return {
        disposition: "quarantined",
        delivery_kind: deliveryKind,
        already_quarantined: true,
      };
    }
    const previousFailure = await this.rawStore.getFailure({
      botId: this.bot.id,
      updateId: update.update_id,
    });
    if (previousFailure?.attempts >= TELEGRAM_MAX_DELIVERY_ATTEMPTS) {
      await this.rawStore.quarantine({
        botId: this.bot.id,
        updateId: update.update_id,
        quarantinedAt: this.clock().toISOString(),
        reasonCode: "delivery_attempts_exhausted",
      });
      return {
        disposition: "quarantined",
        delivery_kind: deliveryKind,
        failure_count: previousFailure.attempts,
        recovered_after_interrupted_quarantine: true,
      };
    }
    try {
      await deliver();
    } catch {
      const failure = await this.rawStore.recordFailure({
        botId: this.bot.id,
        updateId: update.update_id,
        failedAt: this.clock().toISOString(),
        // Never persist a downstream error message: it may echo submitted content or a secret.
        failureCode: `${deliveryKind}_sink_failed`,
      });
      if (failure.attempts >= TELEGRAM_MAX_DELIVERY_ATTEMPTS) {
        await this.rawStore.quarantine({
          botId: this.bot.id,
          updateId: update.update_id,
          quarantinedAt: this.clock().toISOString(),
          reasonCode: "delivery_attempts_exhausted",
        });
        return {
          disposition: "quarantined",
          delivery_kind: deliveryKind,
          failure_count: failure.attempts,
        };
      }
      throw new ConnectorRequestError("Telegram durable delivery failed; retry scheduled", {
        code: "telegram_delivery_retry",
      });
    }
    await this.rawStore.clearFailure({ botId: this.bot.id, updateId: update.update_id });
    return success;
  }

  async #quarantineSensitiveUpdate({ update, category }) {
    const persisted = await this.rawStore.put({ botId: this.bot.id, update });
    if (!persisted?.quarantined) {
      await this.rawStore.quarantine({
        botId: this.bot.id,
        updateId: update.update_id,
        quarantinedAt: this.clock().toISOString(),
        reasonCode: `sensitive_${category}`,
      });
    }
    return {
      disposition: "quarantined_sensitive",
      delivery_kind: "inbox",
      risk_category: category,
      already_quarantined: Boolean(persisted?.quarantined),
    };
  }

  async #processUpdate(update, observedAt) {
    if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) {
      throw new ConnectorValidationError("Telegram update_id is invalid", { field: "update_id" });
    }
    if (update.my_chat_member) {
      const membership = update.my_chat_member;
      const status = membership.new_chat_member?.status;
      const chatId = membership.chat?.id;
      if (["left", "kicked"].includes(status) && chatId != null) {
        if (await this.allowlistStore.isChatAllowed?.(chatId, this.bot?.id)) {
          await this.allowlistStore.revoke({ botId: this.bot?.id, chatId });
        }
        if (await this.groupStore?.isMonitored?.({ botId: this.bot?.id, chatId })) {
          await this.groupStore.revoke({ botId: this.bot?.id, chatId });
        }
      }
      return { disposition: "membership_update" };
    }

    const message = messageFrom(update);
    if (!message?.chat || !message?.from) return { disposition: "unsupported_update" };
    const command = this.parseCommand(message);
    if (
      isGroupChat(message)
      && Array.isArray(message.new_chat_members)
      && message.new_chat_members.length > 0
      && await this.groupStore?.isMonitored?.({ botId: this.bot?.id, chatId: message.chat.id })
    ) {
      await this.groupStore.pause({
        botId: this.bot.id,
        chatId: message.chat.id,
        reason: "membership_changed_requires_consent",
      });
      return { disposition: "group_sensor_paused_for_new_member" };
    }
    const groupControl = await this.#processGroupControl(update, message, command);
    if (groupControl) return groupControl;
    if (!command && isGroupChat(message)) {
      const explicitAllowed = isExplicitTelegramSubmission(message, {
        botId: this.bot.id,
        botUsername: this.bot.username,
      }) && await this.allowlistStore.isAllowed({
        botId: this.bot.id,
        chatId: message.chat.id,
        userId: message.from.id,
      });
      if (!explicitAllowed) {
        const sensor = await this.#processGroupSensor(update, message, observedAt);
        if (sensor) return sensor;
      }
    }
    const authorization = await this.#authorizeOrPair(message, command);
    if (!authorization.allowed) {
      // Unknown chat/user data must not be written to raw storage or an Inbox.
      return { disposition: "unauthorized_ignored" };
    }
    if (authorization.paired) {
      await this.commandSink({
        delivery_key: `${this.connectorId}:${update.update_id}:pair`,
        command: { name: "pair", argument: "" },
        update_id: update.update_id,
        message_id: String(message.message_id),
        chat_id: authorization.chatId,
        user_id: authorization.userId,
        pairing_completed: true,
        untrusted_external_content: true,
        execute_tools: false,
        create_mission: false,
      });
      return { disposition: "paired", acknowledgement_sent: true };
    }

    const deliveryKey = `${this.connectorId}:${update.update_id}`;
    if (command && command.name !== "intel") {
      // Raw encrypted persistence happens before delivery. On retry, both rawStore.put
      // and the downstream sink must be idempotent; a raw duplicate is not proof of delivery.
      return this.#deliverPersistedUpdate({
        update,
        deliveryKind: "command",
        deliver: () =>
          this.commandSink({
            delivery_key: deliveryKey,
            command,
            update_id: update.update_id,
            message_id: String(message.message_id),
            chat_id: authorization.chatId,
            user_id: authorization.userId,
            untrusted_external_content: true,
            execute_tools: false,
            create_mission: false,
          }),
        success: { disposition: "command", command: command.name },
      });
    }

    const observation = telegramUpdateToObservation(update, {
      botId: this.bot.id,
      botUsername: this.bot.username,
      observedAt,
    });
    if (!observation) return { disposition: "authorized_non_submission" };
    const risk = classifyTelegramSubmissionRisk(observation);
    if (risk.quarantine) {
      // The encrypted quarantine is the durable commit for sensitive content.
      // Nothing derived from it is written to canonical Inbox/Brief state.
      return this.#quarantineSensitiveUpdate({ update, category: risk.category });
    }
    return this.#deliverPersistedUpdate({
      update,
      deliveryKind: "inbox",
      deliver: () =>
        this.inboxSink({
          delivery_key: deliveryKey,
          observation,
          upsert_key: observation.external_event_id,
          auto_create_mission: false,
          execute_external_content: false,
        }),
      success: { disposition: "inbox", externalEventId: observation.external_event_id },
    });
  }

  async pollOnce({ timeoutSeconds = 25, limit = 100 } = {}) {
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 50) {
      throw new ConnectorValidationError("timeoutSeconds must be between 0 and 50", {
        field: "timeoutSeconds",
      });
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ConnectorValidationError("limit must be between 1 and 100", { field: "limit" });
    }
    const now = this.clock();
    const checkedAt = now.toISOString();
    const token = await this.#token();
    if (!this.bot) {
      const bootstrapped = await this.bootstrap();
      if (!bootstrapped.ok) return bootstrapped;
    }
    const checkpoint = (await this.checkpointStore.load(this.connectorId)) ?? {
      next_offset: 0,
      last_successful_poll_at: null,
      last_update_at: null,
    };
    const previousSuccess = validDate(checkpoint.last_successful_poll_at);
    const coverageGap = previousSuccess
      ? now.getTime() - previousSuccess.getTime() > TELEGRAM_RETENTION_MS
      : false;

    try {
      await this.rawStore.purgeQuarantineOlderThan(
        new Date(now.getTime() - TELEGRAM_QUARANTINE_RETENTION_MS),
      );
      const updates = await this.#request(
        "getUpdates",
        {
          offset: checkpoint.next_offset,
          limit,
          timeout: timeoutSeconds,
          allowed_updates: TELEGRAM_ALLOWED_UPDATES,
        },
        token,
        { timeoutMs: (timeoutSeconds + 10) * 1_000 },
      );
      if (!Array.isArray(updates)) {
        throw new ConnectorRequestError("Telegram getUpdates result was not an array", {
          code: "telegram_invalid_response",
        });
      }
      const dispositions = [];
      let nextOffset = checkpoint.next_offset;
      let lastUpdateAt = checkpoint.last_update_at;
      for (const update of [...updates].sort((a, b) => a.update_id - b.update_id)) {
        if (Number.isSafeInteger(update?.update_id) && update.update_id < nextOffset) {
          dispositions.push({ update_id: update.update_id, disposition: "already_checkpointed" });
          continue;
        }
        const result = await this.#processUpdate(update, checkedAt);
        dispositions.push({ update_id: update.update_id, ...result });
        nextOffset = update.update_id + 1;
        const message = messageFrom(update);
        lastUpdateAt = message?.date ? telegramDate(message.date, checkedAt) : checkedAt;
        // This save is the acknowledgement. It happens only after encrypted raw storage
        // and the relevant idempotent sink have both completed.
        await this.checkpointStore.save(this.connectorId, {
          next_offset: nextOffset,
          last_successful_poll_at: checkpoint.last_successful_poll_at,
          last_update_at: lastUpdateAt,
        });
      }
      const quarantinedCount = dispositions.filter(
        (item) => item.disposition.startsWith("quarantined"),
      ).length;
      const sensitiveQuarantinedCount = dispositions.filter(
        (item) => item.disposition === "quarantined_sensitive",
      ).length;
      const committed = await this.checkpointStore.save(this.connectorId, {
        next_offset: nextOffset,
        last_successful_poll_at: checkedAt,
        last_update_at: lastUpdateAt,
      });
      const groupSnapshot = await this.getGroupSnapshot();
      const monitoredGroups = groupSnapshot.groups.filter((group) => group.status !== "revoked");
      this.monitoredGroupCount = monitoredGroups.length;
      const privacyBlocking = monitoredGroups.length > 0 && !this.canReadAllGroupMessages;
      this.lastHealth = health(
        this.connectorId,
        coverageGap
          ? "coverage_gap"
          : privacyBlocking || quarantinedCount
            ? "degraded"
            : "healthy",
        checkedAt,
        {
          coverageState: coverageGap ? "coverage_gap" : "complete",
          lastSuccessAt: checkedAt,
          message: coverageGap
            ? "Polling resumed after Telegram's 24-hour retention window; missing coverage is possible"
            : privacyBlocking
              ? "privacy_mode_blocking: group sensors cannot receive ordinary messages"
            : quarantinedCount
              ? sensitiveQuarantinedCount
                ? `${quarantinedCount} update(s) quarantined; ${sensitiveQuarantinedCount} matched a sensitive-content safety rule`
                : `${quarantinedCount} update(s) quarantined after bounded delivery retries`
              : `Listening; ${this.pairedCount} paired identity; ${monitoredGroups.length} monitored group; ${updates.length} new update(s)`,
          mode: monitoredGroups.length > 0 ? "hybrid_sensor" : "explicit_submit_only",
          privacyModeExpected: monitoredGroups.length === 0,
          extra: {
            paired_count: this.pairedCount,
            monitored_group_count: monitoredGroups.length,
            active_group_count: monitoredGroups.filter((group) => group.status === "active").length,
            can_read_all_group_messages: this.canReadAllGroupMessages,
            privacy_mode_blocking: privacyBlocking,
            ...(coverageGap ? { gap_since_last_success_at: previousSuccess.toISOString() } : {}),
          },
        },
      );
      return {
        ok: true,
        updates_received: updates.length,
        dispositions,
        quarantined_updates: quarantinedCount,
        sensitive_quarantined_updates: sensitiveQuarantinedCount,
        checkpoint: committed,
        coverage_gap: coverageGap,
        health: this.lastHealth,
      };
    } catch (error) {
      const message = redactTelegramSecrets(error?.message, token) || "Telegram poll failed";
      this.lastHealth = health(this.connectorId, "error", checkedAt, {
        coverageState: coverageGap ? "coverage_gap" : "unknown",
        lastSuccessAt: checkpoint.last_successful_poll_at ?? undefined,
        retryAfter: error?.retryAfter,
        message,
        mode: this.monitoredGroupCount > 0 ? "hybrid_sensor" : "explicit_submit_only",
        privacyModeExpected: this.monitoredGroupCount === 0,
      });
      return {
        ok: false,
        error: {
          code: error?.code ?? "telegram_poll_failed",
          message,
          retry_after_seconds: error?.retryAfter,
        },
        health: this.lastHealth,
      };
    }
  }

  async sendText({ chatId, text } = {}) {
    const safeChatId = id(chatId, "chat_id");
    if (typeof text !== "string" || !text.trim()) {
      throw new ConnectorValidationError("text is required", { field: "text" });
    }
    const normalizedText = text.trim();
    if ([...normalizedText].length > 4_096) {
      throw new ConnectorValidationError("Telegram text cannot exceed 4096 characters", {
        field: "text",
      });
    }
    const explicitChat = await this.allowlistStore.isChatAllowed(safeChatId, this.bot?.id);
    const monitoredChat = await this.groupStore?.isMonitored?.({
      botId: this.bot?.id,
      chatId: safeChatId,
    });
    if (!explicitChat && !monitoredChat) {
      throw new ConnectorDisabledError("Telegram chat is not allowlisted", {
        code: "telegram_chat_not_allowlisted",
      });
    }
    const token = await this.#token();
    const result = await this.#request(
      "sendMessage",
      {
        chat_id: safeChatId,
        text: normalizedText,
        // Deliberately omit parse_mode: external content cannot become Telegram HTML/Markdown.
        link_preview_options: { is_disabled: true },
      },
      token,
    );
    return {
      ok: true,
      chat_id: String(result.chat?.id ?? safeChatId),
      message_id: result.message_id,
    };
  }

  async editText({ chatId, messageId, text } = {}) {
    const safeChatId = id(chatId, "chat_id");
    const safeMessageId = id(messageId, "message_id");
    if (typeof text !== "string" || !text.trim()) {
      throw new ConnectorValidationError("text is required", { field: "text" });
    }
    const normalizedText = text.trim();
    if ([...normalizedText].length > 4_096) {
      throw new ConnectorValidationError("Telegram text cannot exceed 4096 characters", {
        field: "text",
      });
    }
    const explicitChat = await this.allowlistStore.isChatAllowed(safeChatId, this.bot?.id);
    const monitoredChat = await this.groupStore?.isMonitored?.({
      botId: this.bot?.id,
      chatId: safeChatId,
    });
    if (!explicitChat && !monitoredChat) {
      throw new ConnectorDisabledError("Telegram chat is not allowlisted", {
        code: "telegram_chat_not_allowlisted",
      });
    }
    const token = await this.#token();
    const result = await this.#request(
      "editMessageText",
      {
        chat_id: safeChatId,
        message_id: Number(safeMessageId),
        text: normalizedText,
        link_preview_options: { is_disabled: true },
      },
      token,
    );
    return {
      ok: true,
      chat_id: String(result.chat?.id ?? safeChatId),
      message_id: result.message_id ?? Number(safeMessageId),
    };
  }

  async forget({ chatId, userId, messageId, rawUpdateIds = [] } = {}) {
    const safeChatId = chatId == null ? undefined : id(chatId, "chat_id");
    const safeUserId = userId == null ? undefined : id(userId, "user_id");
    const safeMessageId = messageId == null ? undefined : id(messageId, "message_id");
    if (!safeChatId && !safeUserId && !safeMessageId && rawUpdateIds.length === 0) {
      throw new ConnectorValidationError("A forget scope is required", { field: "forget" });
    }
    for (const updateId of rawUpdateIds) {
      await this.rawStore.remove({ botId: this.bot?.id ?? this.connectorId, updateId });
    }
    let rawMatchesRemoved = 0;
    if (
      typeof this.rawStore.removeMatching === "function" &&
      (safeChatId || safeUserId || safeMessageId)
    ) {
      const result = await this.rawStore.removeMatching({
        botId: this.bot?.id ?? this.connectorId,
        chatId: safeChatId,
        userId: safeUserId,
        messageId: safeMessageId,
      });
      rawMatchesRemoved = result.removed;
    }
    if (typeof this.inboxSink.forget === "function") {
      await this.inboxSink.forget({
        source: "telegram",
        chat_id: safeChatId,
        user_id: safeUserId,
        message_id: safeMessageId,
      });
    }
    if (typeof this.sensorSink?.forget === "function") {
      await this.sensorSink.forget({
        chat_id: safeChatId,
        user_id: safeUserId,
        message_id: safeMessageId,
      });
    }
    return {
      forgotten: true,
      raw_updates_removed: rawUpdateIds.length + rawMatchesRemoved,
    };
  }

  async revoke({ chatId, userId } = {}) {
    if (chatId == null && userId == null) {
      throw new ConnectorValidationError("chatId or userId is required", { field: "revoke" });
    }
    await this.allowlistStore.revoke({ botId: this.bot?.id, chatId, userId });
    if (chatId != null && await this.groupStore?.isOwner?.({
      botId: this.bot?.id,
      chatId,
      userId,
    })) {
      await this.groupStore.revoke({ botId: this.bot?.id, chatId });
    } else if (chatId != null && userId != null) {
      await this.groupStore?.revoke?.({ botId: this.bot?.id, chatId, userId });
    }
    const allowlist = await this.getAllowlistSnapshot();
    this.pairedCount = allowlist.available ? allowlist.pairs.length : Math.max(0, this.pairedCount - 1);
    return { revoked: true };
  }
}
