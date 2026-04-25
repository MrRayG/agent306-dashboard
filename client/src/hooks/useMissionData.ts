/**
 * useMissionData — fans out the three Mission Control fetches in parallel.
 *
 * Each panel owns its own loading/error state so one failing endpoint does
 * not blank the page (per spec). Refetch every 30s.
 *
 * Endpoints:
 *   /api/public/eval          — 306EVAL composite + dimensions
 *   /api/public/status        — current activity label (tile data NOT
 *                               currently exposed here; tiles fall back
 *                               to '—' until a SelfRec proposes adding it)
 *   /api/public/metacognition — insight ledger + self-integrity
 */

import { useQuery } from "@tanstack/react-query";

export interface PublicEvalDimension {
  name: string;
  key: string;
  agent?: string;
  score: number;
  trend?: "improving" | "declining" | "stable" | "up" | "down" | "steady";
  narrative?: string;
}

export interface PublicEvalBenchmark {
  composite: number;
  drift?: "improving" | "declining" | "stable" | string;
  dimensions: PublicEvalDimension[];
  calibrationDirective?: string;
  weakestDimension?: string;
  // The spec optimistically referenced these fields on /api/public/eval.
  // They are not currently emitted by getPublicEval() — tolerate missing.
  // TODO(SelfRec): add drift7dAvg / drift30dAvg / driftDelta / notice to
  // server/publicApi.ts → getPublicEval as a follow-up.
  drift7dAvg?: number;
  drift30dAvg?: number;
  driftDelta?: number;
  notice?: string;
}

export interface PublicEvalResponse {
  benchmark: PublicEvalBenchmark | null;
  generatedAt: string;
}

export interface PublicStatusResponse {
  currentStatus: string;
  statusLabel: string;
  lastUpdated: string;
  uptime: boolean;
  // The spec optimistically described AgentHQ-style room tiles on this
  // endpoint. They are not present today — Mission Control falls back to '—'
  // and shows a "could not load" caption per the spec's graceful-degrade
  // guidance.
  // TODO(SelfRec): expose broadcast/library/diplomatic/studio/character/
  // vault/lab/signal blobs on /api/public/status (mirroring /api/house).
  broadcast?: { lastEpisode?: string; cycleCount?: number; isLive?: boolean };
  signal?: { total?: number; founderPosts?: number; lastRefreshed?: string };
  library?: { totalEntries?: number; lastIngested?: string };
  diplomatic?: { followingCount?: number; replyCount?: number; lastSync?: string };
  studio?: { voiceName?: string; articlesPublished?: number };
  character?: { voiceMaturity?: number; growthVector?: string };
  vault?: { ethName?: string; railwayStatus?: string };
  lab?: { totalPosts?: number; avgScore?: number };
}

export interface PublicMetacognitionResponse {
  cognition?: {
    insightLedger?: {
      total?: number;
      proposed?: number;
      accepted?: number;
      inFlight?: number;
      verified?: number;
      failed?: number;
      expired?: number;
      open?: number;
      lastCycleReflected?: number;
      verified30d?: number;
      failed30d?: number;
    };
    selfChange?: {
      selfIntegrityLevel?: number;
      verifiedRatio?: number;
    };
  };
  generatedAt?: string;
}

const REFRESH_MS = 30_000;

export function useMissionEval() {
  return useQuery<PublicEvalResponse>({
    queryKey: ["/api/public/eval"],
    refetchInterval: REFRESH_MS,
  });
}

export function useMissionStatus() {
  return useQuery<PublicStatusResponse>({
    queryKey: ["/api/public/status"],
    refetchInterval: REFRESH_MS,
  });
}

export function useMissionMetacognition() {
  return useQuery<PublicMetacognitionResponse>({
    queryKey: ["/api/public/metacognition"],
    refetchInterval: REFRESH_MS,
  });
}
