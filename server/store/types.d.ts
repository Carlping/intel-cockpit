export type EntityType = "InboxItem" | "Situation" | "Mission" | "Review";
export type EvidenceStatus =
  | "unverified_external"
  | "verified"
  | "manual_snapshot"
  | "official_proxy";

export interface InboxItem {
  title: string;
  status?:
    | "new"
    | "triaged"
    | "linked"
    | "reference_only"
    | "watch"
    | "not_relevant"
    | "wiki_ingest_pending";
  evidence_status?: EvidenceStatus;
  source_type?: string;
  source_url?: string;
  domain?: string;
  requires_decision?: boolean;
  matched_interest_ids?: string[];
  [key: string]: unknown;
}

export interface Situation {
  title: string;
  status?: "active" | "watch" | "closed";
  current_assessment: string;
  before: string;
  now: string;
  material_change?: boolean;
  watch_conditions: string[];
  stop_condition: string;
  reopen_condition: string;
  next_review_at: string;
  evidence: Array<{
    kind: "known" | "inference" | "unknown" | "contradiction";
    text: string;
    evidence_status?: EvidenceStatus;
    s0_s8_state?: "not_completed" | "pending" | "completed";
    s0_s8_handoff?: {
      state: "not_completed" | "pending" | "completed";
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }>;
  confidence?: number;
  requires_decision?: boolean;
  [key: string]: unknown;
}

export interface Mission {
  title: string;
  objective: string;
  status?: "active" | "blocked" | "completed" | "cancelled";
  why_now: string;
  next_action: string;
  done_condition: string;
  review_date: string;
  stop_condition: string;
  reopen_condition: string;
  [key: string]: unknown;
}

export interface Review {
  title: string;
  mission_id: string;
  outcome: string;
  lessons?: string[];
  reviewed_at: string;
  assessment_change: string;
  next_state: string;
  [key: string]: unknown;
}

export interface EntityDataMap {
  InboxItem: InboxItem;
  Situation: Situation;
  Mission: Mission;
  Review: Review;
}

export interface CanonicalEntity<T extends EntityType = EntityType> {
  schema_version: 1;
  entity_type: T;
  entity_id: string;
  revision: number;
  created_at: string;
  updated_at: string;
  content_sha256: string;
  payload: EntityDataMap[T];
}

export interface PreviewRequest<T extends EntityType = EntityType> {
  operation: "create" | "update";
  entity_type: T;
  entity_id?: string;
  base_revision: number;
  payload: Partial<EntityDataMap[T]>;
}

export interface PreviewResult<T extends EntityType = EntityType> {
  preview_id: string;
  base_revision: number;
  diff: Array<{ path: string; before: unknown; after: unknown }>;
  entity: CanonicalEntity<T>;
}

export interface RemoveResult {
  entity_type: EntityType;
  entity_id: string;
  removed_revision: number;
  removed_at: string;
  recovery_id: string | null;
}

export interface CommitBatchResult {
  transaction_id: string;
  entities: CanonicalEntity[];
}

export interface RecoveredTransactionOperation {
  entity_type: EntityType;
  entity_id: string;
  detected_after_unfinished_wal: boolean;
}

export interface RecoveredTransactionResult {
  transaction_id: string;
  state: "rolled_back";
  recovered_operations: RecoveredTransactionOperation[];
}
