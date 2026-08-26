import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConnectorDisabledError, ConnectorValidationError } from "./contracts.mjs";
import {
  preflightRuntimeDirectories,
  prepareRuntimeDirectory,
} from "../runtime-boundary.mjs";

const DEFAULT_RUNTIME_ROOT = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "IntelOS",
);

const PROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[void][System.Reflection.Assembly]::LoadWithPartialName('System.Security')
$inputBase64 = [Console]::In.ReadToEnd().Trim()
$plain = [Convert]::FromBase64String($inputBase64)
$cipher = [System.Security.Cryptography.ProtectedData]::Protect(
  $plain,
  $null,
  [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([Convert]::ToBase64String($cipher))
`;

const UNPROTECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[void][System.Reflection.Assembly]::LoadWithPartialName('System.Security')
$inputBase64 = [Console]::In.ReadToEnd().Trim()
$cipher = [Convert]::FromBase64String($inputBase64)
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect(
  $cipher,
  $null,
  [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([Convert]::ToBase64String($plain))
`;

function isWithin(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertRuntimePathOutsideOneDrive(
  candidate,
  { env = process.env } = {},
) {
  const resolved = path.resolve(candidate);
  const oneDriveRoots = [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial].filter(Boolean);
  if (
    oneDriveRoots.some((root) => isWithin(resolved, root)) ||
    resolved.split(/[\\/]+/).some((segment) => segment.toLocaleLowerCase("en-US") === "onedrive")
  ) {
    throw new ConnectorValidationError("Runtime secrets and raw updates cannot be stored in OneDrive", {
      field: "baseDir",
      code: "onedrive_runtime_path_rejected",
    });
  }
  return resolved;
}

function safeName(name) {
  if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(name)) {
    throw new ConnectorValidationError("Store name has an invalid format", { field: "name" });
  }
  return name;
}

function runPowerShell(script, input, { spawnImpl = spawn } = {}) {
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  const executable = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return new Promise((resolve, reject) => {
    const child = spawnImpl(
      executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    const stdout = [];
    let outputBytes = 0;
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes <= 10 * 1024 * 1024) stdout.push(chunk);
    });
    // Consume stderr without surfacing values that could contain sensitive input.
    child.stderr.on("data", () => {});
    child.on("error", () => reject(new Error("Windows DPAPI process could not start")));
    child.on("close", (code) => {
      if (code !== 0 || outputBytes > 10 * 1024 * 1024) {
        reject(new Error("Windows DPAPI operation failed"));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8").trim());
    });
    child.stdin.end(input);
  });
}

export function createDpapiProtector({
  platform = process.platform,
  spawnImpl = spawn,
} = {}) {
  const available = platform === "win32";
  const requireWindows = () => {
    if (!available) {
      throw new ConnectorDisabledError(
        "DPAPI storage is disabled because Windows CurrentUser protection is unavailable",
        { code: "dpapi_unavailable" },
      );
    }
  };

  return Object.freeze({
    available,
    async protect(value) {
      requireWindows();
      const plain = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
      const cipherBase64 = await runPowerShell(PROTECT_SCRIPT, plain.toString("base64"), {
        spawnImpl,
      });
      return Buffer.from(cipherBase64, "base64");
    },
    async unprotect(value) {
      requireWindows();
      const cipher = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const plainBase64 = await runPowerShell(UNPROTECT_SCRIPT, cipher.toString("base64"), {
        spawnImpl,
      });
      return Buffer.from(plainBase64, "base64");
    },
  });
}

async function atomicWrite(filePath, bytes, { runtimeRoot, env }) {
  await prepareRuntimeDirectory(runtimeRoot, path.dirname(filePath), { env });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function preflightFileParents(runtimeRoot, filePaths, env) {
  return preflightRuntimeDirectories({
    runtimeRoot,
    directories: [...new Set(filePaths.map((filePath) => path.dirname(filePath)))],
    env,
  });
}

export function createDpapiSecretStore({
  baseDir = path.join(DEFAULT_RUNTIME_ROOT, "secrets"),
  runtimeRoot = path.dirname(baseDir),
  protector = createDpapiProtector(),
  env = process.env,
} = {}) {
  const guardedRuntimeRoot = assertRuntimePathOutsideOneDrive(runtimeRoot, { env });
  const root = assertRuntimePathOutsideOneDrive(baseDir, { env });
  const fileFor = (name) => path.join(root, `${safeName(name)}.dpapi`);

  return Object.freeze({
    available: Boolean(protector.available),
    async write(name, secret) {
      if (typeof secret !== "string" || !secret) {
        throw new ConnectorValidationError("Secret must be a non-empty string", { field: "secret" });
      }
      const cipher = await protector.protect(Buffer.from(secret, "utf8"));
      await atomicWrite(fileFor(name), cipher, { runtimeRoot: guardedRuntimeRoot, env });
    },
    async read(name) {
      await preflightFileParents(guardedRuntimeRoot, [fileFor(name)], env);
      let cipher;
      try {
        cipher = await readFile(fileFor(name));
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
      const plain = await protector.unprotect(cipher);
      return plain.toString("utf8");
    },
    async remove(name) {
      const target = fileFor(name);
      await preflightFileParents(guardedRuntimeRoot, [target], env);
      await rm(target, { force: true });
    },
  });
}

export function createFileCheckpointStore({
  baseDir = path.join(DEFAULT_RUNTIME_ROOT, "checkpoints"),
  runtimeRoot = path.dirname(baseDir),
  env = process.env,
} = {}) {
  const guardedRuntimeRoot = assertRuntimePathOutsideOneDrive(runtimeRoot, { env });
  const root = assertRuntimePathOutsideOneDrive(baseDir, { env });
  const fileFor = (connectorId) => path.join(root, `${safeName(connectorId)}.json`);
  return Object.freeze({
    async load(connectorId) {
      await preflightFileParents(guardedRuntimeRoot, [fileFor(connectorId)], env);
      try {
        const parsed = JSON.parse(await readFile(fileFor(connectorId), "utf8"));
        if (!Number.isSafeInteger(parsed.next_offset) || parsed.next_offset < 0) {
          throw new Error("Invalid durable checkpoint");
        }
        return parsed;
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    },
    async save(connectorId, checkpoint) {
      if (!Number.isSafeInteger(checkpoint?.next_offset) || checkpoint.next_offset < 0) {
        throw new ConnectorValidationError("next_offset must be a non-negative safe integer", {
          field: "next_offset",
        });
      }
      const value = {
        version: 1,
        next_offset: checkpoint.next_offset,
        last_successful_poll_at: checkpoint.last_successful_poll_at ?? null,
        last_update_at: checkpoint.last_update_at ?? null,
      };
      await atomicWrite(
        fileFor(connectorId),
        Buffer.from(`${JSON.stringify(value)}\n`, "utf8"),
        { runtimeRoot: guardedRuntimeRoot, env },
      );
      return value;
    },
    async clear(connectorId) {
      const target = fileFor(connectorId);
      await preflightFileParents(guardedRuntimeRoot, [target], env);
      await rm(target, { force: true });
    },
  });
}

export function createEncryptedRawUpdateStore({
  baseDir = path.join(DEFAULT_RUNTIME_ROOT, "encrypted-telegram"),
  quarantineDir,
  runtimeRoot = path.dirname(baseDir),
  protector = createDpapiProtector(),
  env = process.env,
} = {}) {
  const guardedRuntimeRoot = assertRuntimePathOutsideOneDrive(runtimeRoot, { env });
  const root = assertRuntimePathOutsideOneDrive(baseDir, { env });
  const quarantineRoot = assertRuntimePathOutsideOneDrive(
    quarantineDir ??
      (path.basename(baseDir) === "encrypted-telegram"
        ? path.join(path.dirname(baseDir), "quarantine", "telegram")
        : path.join(baseDir, ".quarantine")),
    { env },
  );
  const botHashFor = (botId) =>
    createHash("sha256").update(String(botId)).digest("hex").slice(0, 24);
  const fileFor = (botId, updateId) => {
    if (!Number.isSafeInteger(updateId) || updateId < 0) {
      throw new ConnectorValidationError("Telegram update_id must be a non-negative safe integer", {
        field: "update_id",
      });
    }
    return path.join(root, botHashFor(botId), `${updateId}.dpapi`);
  };
  const retryFileFor = (botId, updateId) => {
    fileFor(botId, updateId);
    return path.join(root, botHashFor(botId), `${updateId}.retry.dpapi`);
  };
  const quarantineFileFor = (botId, updateId) => {
    fileFor(botId, updateId);
    return path.join(quarantineRoot, botHashFor(botId), `${updateId}.dpapi`);
  };
  const directoryFor = (botId) => {
    return path.join(root, botHashFor(botId));
  };
  const quarantineDirectoryFor = (botId) => path.join(quarantineRoot, botHashFor(botId));

  const readEncryptedJson = async (target) => {
    await preflightFileParents(guardedRuntimeRoot, [target], env);
    try {
      const cipher = await readFile(target);
      const plain = await protector.unprotect(cipher);
      return JSON.parse(plain.toString("utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  };
  const writeEncryptedJson = async (target, value) => {
    const cipher = await protector.protect(Buffer.from(JSON.stringify(value), "utf8"));
    await atomicWrite(target, cipher, { runtimeRoot: guardedRuntimeRoot, env });
  };

  const removeUpdateFiles = async (botId, updateId) => {
    const targets = [
      fileFor(botId, updateId),
      retryFileFor(botId, updateId),
      quarantineFileFor(botId, updateId),
    ];
    await preflightFileParents(guardedRuntimeRoot, targets, env);
    for (const target of targets) await rm(target, { force: true });
  };

  const messageMatches = (update, criteria) => {
    const message = update?.message ?? update?.edited_message;
    if (!message) return false;
    return (
      (criteria.chatId == null || String(message.chat?.id) === criteria.chatId) &&
      (criteria.userId == null || String(message.from?.id) === criteria.userId) &&
      (criteria.messageId == null || String(message.message_id) === criteria.messageId)
    );
  };

  return Object.freeze({
    available: Boolean(protector.available),
    async put({ botId, update }) {
      const target = fileFor(botId, update?.update_id);
      await preflightFileParents(
        guardedRuntimeRoot,
        [target, quarantineFileFor(botId, update?.update_id)],
        env,
      );
      try {
        await stat(quarantineFileFor(botId, update?.update_id));
        return { duplicate: true, quarantined: true, key: update.update_id };
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      try {
        await stat(target);
        return { duplicate: true, key: update.update_id };
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const cipher = await protector.protect(Buffer.from(JSON.stringify(update), "utf8"));
      try {
        await atomicWrite(target, cipher, { runtimeRoot: guardedRuntimeRoot, env });
        return { duplicate: false, key: update.update_id };
      } catch (error) {
        // A concurrent retry may have committed the same immutable update first.
        try {
          await stat(target);
          return { duplicate: true, key: update.update_id };
        } catch {
          throw error;
        }
      }
    },
    async get({ botId, updateId }) {
      return readEncryptedJson(fileFor(botId, updateId));
    },
    async getFailure({ botId, updateId }) {
      return readEncryptedJson(retryFileFor(botId, updateId));
    },
    async recordFailure({ botId, updateId, failedAt, failureCode = "delivery_failed" }) {
      const rawTarget = fileFor(botId, updateId);
      await preflightFileParents(guardedRuntimeRoot, [rawTarget], env);
      await stat(rawTarget);
      const target = retryFileFor(botId, updateId);
      const previous = await readEncryptedJson(target);
      const timestamp = new Date(failedAt ?? Date.now()).toISOString();
      const attempts = (Number.isSafeInteger(previous?.attempts) ? previous.attempts : 0) + 1;
      const value = {
        version: 1,
        update_id: updateId,
        attempts,
        first_failed_at: previous?.first_failed_at ?? timestamp,
        last_failed_at: timestamp,
        failure_code: /^[a-z0-9_]{1,64}$/.test(failureCode) ? failureCode : "delivery_failed",
      };
      await writeEncryptedJson(target, value);
      return value;
    },
    async clearFailure({ botId, updateId }) {
      const target = retryFileFor(botId, updateId);
      await preflightFileParents(guardedRuntimeRoot, [target], env);
      await rm(target, { force: true });
    },
    async quarantine({ botId, updateId, quarantinedAt, reasonCode = "delivery_attempts_exhausted" }) {
      const target = quarantineFileFor(botId, updateId);
      const existing = await readEncryptedJson(target);
      if (existing) {
        const rawTargets = [fileFor(botId, updateId), retryFileFor(botId, updateId)];
        await preflightFileParents(guardedRuntimeRoot, rawTargets, env);
        for (const rawTarget of rawTargets) await rm(rawTarget, { force: true });
        return { duplicate: true, attempts: existing.failure?.attempts ?? null };
      }
      const update = await readEncryptedJson(fileFor(botId, updateId));
      if (!update) {
        throw new ConnectorValidationError("Raw Telegram update is unavailable for quarantine", {
          field: "updateId",
          code: "telegram_raw_update_missing",
        });
      }
      const failure = await readEncryptedJson(retryFileFor(botId, updateId));
      const envelope = {
        version: 1,
        quarantined_at: new Date(quarantinedAt ?? Date.now()).toISOString(),
        reason_code: /^[a-z0-9_]{1,64}$/.test(reasonCode)
          ? reasonCode
          : "delivery_attempts_exhausted",
        failure,
        update,
      };
      await writeEncryptedJson(target, envelope);
      const rawTargets = [fileFor(botId, updateId), retryFileFor(botId, updateId)];
      await preflightFileParents(guardedRuntimeRoot, rawTargets, env);
      for (const rawTarget of rawTargets) await rm(rawTarget, { force: true });
      return { duplicate: false, attempts: failure?.attempts ?? null };
    },
    async isQuarantined({ botId, updateId }) {
      const target = quarantineFileFor(botId, updateId);
      await preflightFileParents(guardedRuntimeRoot, [target], env);
      try {
        await stat(target);
        return true;
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
    },
    async getQuarantined({ botId, updateId }) {
      return readEncryptedJson(quarantineFileFor(botId, updateId));
    },
    async remove({ botId, updateId }) {
      await removeUpdateFiles(botId, updateId);
    },
    async removeMatching({ botId, chatId, userId, messageId } = {}) {
      if (botId == null) {
        throw new ConnectorValidationError("botId is required", { field: "botId" });
      }
      const criteria = {
        chatId: chatId == null ? undefined : String(chatId),
        userId: userId == null ? undefined : String(userId),
        messageId: messageId == null ? undefined : String(messageId),
      };
      if (!criteria.chatId && !criteria.userId && !criteria.messageId) {
        throw new ConnectorValidationError("At least one raw-update match criterion is required", {
          field: "removeMatching",
        });
      }
      let removed = 0;
      const scopedDirectories = [
        [directoryFor(botId), false],
        [quarantineDirectoryFor(botId), true],
      ];
      await preflightRuntimeDirectories({
        runtimeRoot: guardedRuntimeRoot,
        directories: scopedDirectories.map(([directory]) => directory),
        env,
      });
      for (const [directory, quarantined] of scopedDirectories) {
        let entries;
        try {
          entries = await readdir(directory, { withFileTypes: true });
        } catch (error) {
          if (error?.code === "ENOENT") continue;
          throw error;
        }
        for (const entry of entries) {
          if (!entry.isFile() || !/^\d+\.dpapi$/.test(entry.name)) continue;
          const target = path.join(directory, entry.name);
          const value = await readEncryptedJson(target);
          const update = quarantined ? value?.update : value;
          if (messageMatches(update, criteria)) {
            const updateId = Number(entry.name.slice(0, -".dpapi".length));
            await removeUpdateFiles(botId, updateId);
            removed += 1;
          }
        }
      }
      return { removed };
    },
    async purgeOlderThan(cutoff) {
      const cutoffMs = cutoff instanceof Date ? cutoff.getTime() : Date.parse(cutoff);
      if (!Number.isFinite(cutoffMs)) throw new TypeError("cutoff must be a valid date");
      let removed = 0;
      let botDirs = [];
      await preflightRuntimeDirectories({
        runtimeRoot: guardedRuntimeRoot,
        directories: [root],
        env,
      });
      try {
        botDirs = await readdir(root, { withFileTypes: true });
      } catch (error) {
        if (error?.code === "ENOENT") return 0;
        throw error;
      }
      const botDirectories = botDirs
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => path.join(root, entry.name));
      await preflightRuntimeDirectories({
        runtimeRoot: guardedRuntimeRoot,
        directories: [root, ...botDirectories],
        env,
      });
      for (const directory of botDirectories) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) {
            await preflightRuntimeDirectories({
              runtimeRoot: guardedRuntimeRoot,
              directories: [path.join(directory, entry.name)],
              env,
            });
          }
          if (!entry.isFile() || !/^\d+\.dpapi$/.test(entry.name)) continue;
          const target = path.join(directory, entry.name);
          const metadata = await stat(target);
          if (metadata.mtimeMs < cutoffMs) {
            await rm(target, { force: true });
            const updateId = Number(entry.name.slice(0, -".dpapi".length));
            await rm(path.join(directory, `${updateId}.retry.dpapi`), { force: true });
            removed += 1;
          }
        }
      }
      return removed;
    },
    async purgeQuarantineOlderThan(cutoff) {
      const cutoffMs = cutoff instanceof Date ? cutoff.getTime() : Date.parse(cutoff);
      if (!Number.isFinite(cutoffMs)) throw new TypeError("cutoff must be a valid date");
      let removed = 0;
      let botDirs = [];
      await preflightRuntimeDirectories({
        runtimeRoot: guardedRuntimeRoot,
        directories: [quarantineRoot],
        env,
      });
      try {
        botDirs = await readdir(quarantineRoot, { withFileTypes: true });
      } catch (error) {
        if (error?.code === "ENOENT") return 0;
        throw error;
      }
      const botDirectories = botDirs
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => path.join(quarantineRoot, entry.name));
      await preflightRuntimeDirectories({
        runtimeRoot: guardedRuntimeRoot,
        directories: [quarantineRoot, ...botDirectories],
        env,
      });
      for (const directory of botDirectories) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) {
            await preflightRuntimeDirectories({
              runtimeRoot: guardedRuntimeRoot,
              directories: [path.join(directory, entry.name)],
              env,
            });
          }
          if (!entry.isFile() || !/^\d+\.dpapi$/.test(entry.name)) continue;
          const target = path.join(directory, entry.name);
          const envelope = await readEncryptedJson(target);
          const quarantinedAtMs = Date.parse(envelope?.quarantined_at ?? "");
          const retainedSince = Number.isFinite(quarantinedAtMs)
            ? quarantinedAtMs
            : (await stat(target)).mtimeMs;
          if (retainedSince < cutoffMs) {
            await rm(target, { force: true });
            removed += 1;
          }
        }
      }
      return removed;
    },
  });
}
