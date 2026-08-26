export type ReadingDepthId = "scan" | "map" | "understand" | "decide" | "deep";

export type CognitiveReaderInput = {
  asOf: string;
  sourceRevision: string | number;
  needsYou: unknown[];
  changes: unknown[];
  missions: unknown[];
  watching: unknown[];
  connectors: unknown[];
  situations: unknown[];
  briefing: unknown;
};

export type CognitiveSource = { label: string; href: string; status?: string };
export type CognitiveEvidence = {
  id: string;
  kind: string;
  text: string;
  status: string;
  asOf: string;
  source?: { label: string; href: string };
};
export type CognitiveMission = {
  id: string;
  title: string;
  objective: string;
  nextAction: string;
  doneCondition: string;
  stopCondition: string;
  reviewDate: string;
  status: string;
};
export type CognitiveScenario = {
  id: string;
  label: string;
  probability: number | null;
  summary: string;
  trigger: string;
  implication: string;
  invalidation: string;
};
export type RetrievalCue = { prompt: string; answer: string };

export type CognitiveBrief = {
  title: string;
  asOf: string;
  orientation: {
    state: string;
    headline: string;
    significance: string;
    nextAction: string;
    uncertainty: string;
  };
  map: {
    question: string;
    before: string;
    now: string;
    impact: string;
    nodes: string[];
  };
  model: {
    assessment: string;
    confidence: number | null;
    evidence: CognitiveEvidence[];
    knownCount: number;
    inferenceCount: number;
    unknownCount: number;
    contradictionCount: number;
  };
  decision: {
    missions: CognitiveMission[];
    scenarios: CognitiveScenario[];
    watchCondition: string;
    stopCondition: string;
    reopenCondition: string;
    nextReview: string;
  };
  deepDive: {
    transcript: string[];
    sources: CognitiveSource[];
    briefingStatus: string;
    duration: string;
  };
  memory: {
    claims: string[];
    openQuestions: string[];
    retrievalCues: RetrievalCue[];
    tags: string[];
  };
};

export type MemoryPacket = {
  schema_version: "intel-memory-packet/1";
  provenance: {
    kind: "derived_snapshot";
    source_system: "IntelOS";
    source_revision: string | number | null;
    canonical_truth: string;
  };
  id: string;
  type: "cognitive_brief";
  title: string;
  as_of: string;
  reading_depth: { id: ReadingDepthId; label: string; task: string };
  status: string;
  summary_30s: CognitiveBrief["orientation"];
  architecture_3m: CognitiveBrief["map"];
  evidence_10m: CognitiveBrief["model"];
  decision_25m: CognitiveBrief["decision"];
  deep_dive_50m: CognitiveBrief["deepDive"];
  memory: CognitiveBrief["memory"];
  tags: string[];
  source_refs: Array<{ id: string; title: string; uri: string; status: string | null }>;
  index_text: string;
};

export const READING_DEPTHS: ReadonlyArray<{
  id: ReadingDepthId;
  label: string;
  task: string;
  minimumLayer: number;
}>;

export function depthIndex(depthId: ReadingDepthId | string): number;
export function buildCognitiveBrief(input?: CognitiveReaderInput | Record<string, unknown>): CognitiveBrief;
export function buildMemoryPacket(input?: CognitiveReaderInput | Record<string, unknown>, depthId?: ReadingDepthId): MemoryPacket;
export function serializeMemoryPacket(packet: MemoryPacket): string;
