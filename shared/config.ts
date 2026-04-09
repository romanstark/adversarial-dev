import type { HarnessConfig } from "./types.ts";

export const DEFAULT_CONFIG: Omit<HarnessConfig, "userPrompt" | "workDir"> = {
  maxSprints: 10,
  maxRetriesPerSprint: 3,
  passThreshold: 7,
  retryStrategy: "stabilized",
  hardFailUnlockStreak: 2,
};

export const CLAUDE_MODEL = "claude-sonnet-4-6";
export const CODEX_MODEL = "gpt-5.4";

export const CLAUDE_MAX_TURNS = 80;
export const CODEX_NETWORK_ACCESS = true;
