import { resolve } from "path";
import { readFile } from "fs/promises";
import { runHarness } from "./harness.ts";
import { DEFAULT_CONFIG } from "../shared/config.ts";
import { log, logError, logDivider } from "../shared/logger.ts";
import type { HarnessConfig, ResumeMode, RetryStrategy } from "../shared/types.ts";

let userPrompt: string | undefined;
let promptFilePath: string | undefined;
let resumeMode: ResumeMode | undefined;
let retryStrategy: RetryStrategy | undefined;
let hardFailUnlockStreak: number | undefined;

const args = process.argv.slice(2);

for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;

  if (arg === "--file" || arg === "-f") {
    promptFilePath = args[i + 1];
    if (!promptFilePath) {
      console.error("Error: --file requires a path argument");
      process.exit(1);
    }
    i += 1;
    continue;
  }

  if (arg === "--resume") {
    resumeMode = "strict";
    continue;
  }

  if (arg.startsWith("--resume=")) {
    const mode = arg.split("=")[1];
    if (mode === "strict" || mode === "reset-retries" || mode === "reset-contract") {
      resumeMode = mode;
      continue;
    }
    console.error(`Error: invalid resume mode '${mode}'. Expected strict, reset-retries, or reset-contract.`);
    process.exit(1);
  }

  if (arg.startsWith("--retry-strategy=")) {
    const mode = arg.split("=")[1];
    if (mode === "strict" || mode === "stabilized") {
      retryStrategy = mode;
      continue;
    }
    console.error(`Error: invalid retry strategy '${mode}'. Expected strict or stabilized.`);
    process.exit(1);
  }

  if (arg.startsWith("--hard-fail-unlock-streak=")) {
    const raw = arg.split("=")[1];
    const parsed = raw ? parseInt(raw, 10) : NaN;
    if (Number.isInteger(parsed) && parsed >= 1) {
      hardFailUnlockStreak = parsed;
      continue;
    }
    console.error(`Error: invalid hard fail unlock streak '${raw}'. Expected integer >= 1.`);
    process.exit(1);
  }

  userPrompt = userPrompt ? `${userPrompt} ${arg}` : arg;
}

if (promptFilePath) {
  userPrompt = await readFile(resolve(promptFilePath), "utf-8");
}

if (!userPrompt && !resumeMode) {
  console.error("Usage: bun run codex-harness/index.ts <prompt>");
  console.error('       bun run codex-harness/index.ts --file <path-to-prompt.md>');
  console.error('       bun run codex-harness/index.ts --resume[=strict|reset-retries|reset-contract]');
  console.error('       bun run codex-harness/index.ts --retry-strategy=strict|stabilized <prompt>');
  console.error('       bun run codex-harness/index.ts --hard-fail-unlock-streak=2 <prompt>');
  console.error('       bun run codex-harness/index.ts --resume=reset-retries "optional prompt"');
  console.error('Example: bun run codex-harness/index.ts "Build a task manager with REST API and dashboard"');
  process.exit(1);
}

const config: HarnessConfig = {
  ...DEFAULT_CONFIG,
  userPrompt: userPrompt ?? "RESUME",
  workDir: resolve("workspace/codex"),
  resumeMode,
  retryStrategy: retryStrategy ?? DEFAULT_CONFIG.retryStrategy,
  hardFailUnlockStreak: hardFailUnlockStreak ?? DEFAULT_CONFIG.hardFailUnlockStreak,
};

logDivider();
log("HARNESS", "ADVERSARIAL DEV - Codex SDK Harness");
log("HARNESS", `Prompt: "${config.userPrompt}"`);
if (resumeMode) {
  log("HARNESS", `Resume: ${resumeMode}`);
}
log("HARNESS", `Retry strategy: ${config.retryStrategy}`);
log("HARNESS", `Hard fail unlock streak: ${config.hardFailUnlockStreak}`);
logDivider();

try {
  const result = await runHarness(config);

  logDivider();
  if (result.success) {
    log("HARNESS", "All sprints completed successfully!");
  } else {
    logError("HARNESS", "Harness completed with failures.");
  }

  log("HARNESS", `Total time: ${(result.totalDurationMs / 1000 / 60).toFixed(1)} minutes`);
  log("HARNESS", `Sprints passed: ${result.sprints.filter((s) => s.passed).length}/${result.sprints.length}`);

  for (const sprint of result.sprints) {
    const status = sprint.passed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
    log("HARNESS", `  Sprint ${sprint.sprintNumber}: [${status}] (${sprint.attempts} attempts)`);
  }

  process.exit(result.success ? 0 : 1);
} catch (error) {
  logError("HARNESS", `Fatal error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
