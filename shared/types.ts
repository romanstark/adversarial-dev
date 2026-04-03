export interface HarnessConfig {
  userPrompt: string;
  workDir: string;
  maxSprints: number;
  maxRetriesPerSprint: number;
  passThreshold: number;
  resumeMode?: ResumeMode;
}

export type ResumeMode = "strict" | "reset-retries" | "reset-contract";

export interface SprintContract {
  sprintNumber: number;
  features: string[];
  criteria: SprintCriterion[];
}

export interface SprintCriterion {
  name: string;
  description: string;
  threshold: number;
}

export interface EvalScore {
  criterion: string;
  score: number;
  details: string;
}

export interface EvalResult {
  passed: boolean;
  scores: Record<string, number>;
  feedback: EvalScore[];
  overallSummary: string;
}

export interface HarnessProgress {
  status: "planning" | "negotiating" | "building" | "evaluating" | "complete" | "failed";
  currentSprint: number;
  totalSprints: number;
  completedSprints: number;
  retryCount: number;
}

export interface SprintResult {
  sprintNumber: number;
  passed: boolean;
  attempts: number;
  evalResult?: EvalResult;
}

export interface HarnessResult {
  success: boolean;
  sprints: SprintResult[];
  totalDurationMs: number;
}
