import { createIntelligenceStore, resolveDefaultStorePaths } from "../server/store/index.mjs";
import {
  createDailyBackup,
  lintCanonicalState,
  maintainRuntimeArtifacts,
} from "../server/ops/index.mjs";

const paths = resolveDefaultStorePaths();
const store = await createIntelligenceStore(paths);
const lint = await lintCanonicalState({ store, quarantineCorrupt: true });
if (!lint.ok) {
  process.stderr.write(
    `${JSON.stringify({ ok: false, stage: "schema_lint", report: lint }, null, 2)}\n`,
  );
  process.exitCode = 2;
} else {
  const backup = await createDailyBackup({ store, timeZone: "America/New_York" });
  const runtimeMaintenance = await maintainRuntimeArtifacts({ store });
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      lint: {
        valid_count: lint.valid_count,
        warning_count: lint.warning_count,
      },
      backup: {
        state: backup.state,
        snapshot_date: backup.snapshot_date,
        backup_path: backup.backup_path,
        entity_count: backup.manifest.entity_count,
      },
      runtime: {
        pruned: runtimeMaintenance.pruned,
        storage: {
          state: runtimeMaintenance.health.state,
          level: runtimeMaintenance.health.level,
          runtime_bytes: runtimeMaintenance.health.runtime_bytes,
          free_bytes: runtimeMaintenance.health.free_bytes,
          total_bytes: runtimeMaintenance.health.total_bytes,
          free_percent: runtimeMaintenance.health.free_percent,
          unsafe_entry_count: runtimeMaintenance.health.unsafe_entry_count,
        },
      },
    }, null, 2)}\n`,
  );
}
