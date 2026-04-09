import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import {
  CONTRACT_NEGOTIATION_GENERATOR_PROMPT,
  CONTRACT_NEGOTIATION_EVALUATOR_PROMPT,
} from "../shared/prompts.ts";
import { CLAUDE_MODEL } from "../shared/config.ts";
import { log, logError, logDivider } from "../shared/logger.ts";
import {
  initWorkspace,
  writeSpec,
  readSpec,
  writeContract,
  readContract,
  readFeedback,
  writeFeedback,
  readProgress,
  writeProgress,
  findLatestFeedbackRound,
  readSprintStabilityState,
  writeSprintStabilityState,
} from "../shared/files.ts";
import { stabilizeEvaluation, buildStabilityStateFromEval, getFailedCriteria } from "../shared/evaluation.ts";
import type {
  HarnessConfig,
  ResumeMode,
  SprintContract,
  EvalResult,
  HarnessProgress,
  HarnessResult,
  SprintResult,
  SprintStabilityState,
} from "../shared/types.ts";

import { runPlanner } from "./planner.ts";
import { runGenerator } from "./generator.ts";
import { runEvaluator } from "./evaluator.ts";

export async function runHarness(config: HarnessConfig): Promise<HarnessResult> {
  const startTime = Date.now();
  const results: SprintResult[] = [];
  const isResume = config.resumeMode !== undefined;
  const resumeMode: ResumeMode = config.resumeMode ?? "strict";

  log("HARNESS", "Initializing Claude Agent SDK harness");
  log("HARNESS", `Work directory: ${config.workDir}`);
  log("HARNESS", `Max sprints: ${config.maxSprints} | Max retries: ${config.maxRetriesPerSprint} | Threshold: ${config.passThreshold}/10`);
  log("HARNESS", `Retry strategy: ${config.retryStrategy} (unlock streak: ${config.hardFailUnlockStreak})`);
  if (isResume) {
    log("HARNESS", `Resume mode: ${resumeMode}`);
  }

  await initWorkspace(config.workDir, { clean: !isResume });

  let spec: string;
  let totalSprints = 0;
  let startSprint = 1;
  let initialRetryForSprint = 0;
  let reuseExistingContractOnStartSprint = false;
  let lastEvalForStartSprint: EvalResult | undefined;
  let stabilityStateForStartSprint: SprintStabilityState | undefined;

  const progress: HarnessProgress = isResume
    ? await readProgress(config.workDir)
    : {
      status: "planning",
      currentSprint: 0,
      totalSprints: 0,
      completedSprints: 0,
      retryCount: 0,
    };

  if (!isResume) {
    // Phase 1: Planning
    logDivider();
    log("HARNESS", "PHASE 1: PLANNING");
    logDivider();

    await writeProgress(config.workDir, progress);

    const plannerResponse = await runPlanner(config.userPrompt, config.workDir);

    // Planner may have written spec.md via Write tool, or returned it as text
    try {
      spec = await readSpec(config.workDir);
    } catch {
      log("HARNESS", "Planner returned spec as text, writing to spec.md");
      await writeSpec(config.workDir, plannerResponse);
      spec = plannerResponse;
    }

    // Parse sprint count from spec - look for "Sprint N" patterns
    totalSprints = deriveTotalSprints(spec, config.maxSprints);
    progress.totalSprints = totalSprints;
    log("HARNESS", `Planner produced ${totalSprints} sprints`);
  } else {
    spec = await readSpec(config.workDir);
    totalSprints = progress.totalSprints > 0 ? progress.totalSprints : deriveTotalSprints(spec, config.maxSprints);
    progress.totalSprints = totalSprints;

    if (progress.status === "complete") {
      log("HARNESS", "Resume requested but harness is already complete.");
      return { success: true, sprints: [], totalDurationMs: Date.now() - startTime };
    }

    if (progress.currentSprint <= 0) {
      throw new Error("Cannot resume: progress.json does not contain a valid currentSprint");
    }

    startSprint = progress.currentSprint;
    const latestRound = await findLatestFeedbackRound(config.workDir, startSprint);
    if (latestRound !== null) {
      lastEvalForStartSprint = await readFeedback(config.workDir, startSprint, latestRound);
      try {
        stabilityStateForStartSprint = await readSprintStabilityState(config.workDir, startSprint);
      } catch {
        // Backward compatibility: older runs do not have stability snapshots
      }
    }

    if (resumeMode === "strict") {
      if (progress.status === "failed" && latestRound !== null && latestRound >= config.maxRetriesPerSprint) {
        throw new Error(
          `Cannot strictly resume sprint ${startSprint}: retry budget exhausted (last round ${latestRound})`,
        );
      }
      initialRetryForSprint = latestRound === null ? 0 : latestRound + 1;
      reuseExistingContractOnStartSprint = true;
    } else if (resumeMode === "reset-retries") {
      initialRetryForSprint = 0;
      reuseExistingContractOnStartSprint = true;
    } else {
      initialRetryForSprint = 0;
      reuseExistingContractOnStartSprint = false;
      lastEvalForStartSprint = undefined;
      stabilityStateForStartSprint = undefined;
    }

    log("HARNESS", `Resuming at sprint ${startSprint}/${totalSprints} from retry ${initialRetryForSprint}`);
  }

  // Phase 2-4: Sprint Loop
  for (let sprint = startSprint; sprint <= totalSprints; sprint++) {
    logDivider();
    log("HARNESS", `SPRINT ${sprint}/${totalSprints}`);
    logDivider();

    // Phase 2: Contract Negotiation
    progress.status = "negotiating";
    progress.currentSprint = sprint;
    progress.retryCount = sprint === startSprint ? initialRetryForSprint : 0;
    await writeProgress(config.workDir, progress);

    let contract: SprintContract;
    const shouldReuseContract = sprint === startSprint && reuseExistingContractOnStartSprint;
    if (shouldReuseContract) {
      log("HARNESS", "Reusing existing sprint contract...");
      contract = await readContract(config.workDir, sprint);
    } else {
      log("HARNESS", "Negotiating sprint contract...");
      contract = await negotiateContract(config.workDir, spec, sprint);
      await writeContract(config.workDir, contract);
    }
    log("HARNESS", `Contract agreed: ${contract.criteria.length} criteria for ${contract.features.length} features`);

    // Phase 3-4: Build-Evaluate Loop
    let passed = false;
    let lastEval: EvalResult | undefined = sprint === startSprint ? lastEvalForStartSprint : undefined;
    let sprintStabilityState: SprintStabilityState | undefined = sprint === startSprint ? stabilityStateForStartSprint : undefined;
    let attempts = 0;

    const retryStart = sprint === startSprint ? initialRetryForSprint : 0;

    for (let retry = retryStart; retry <= config.maxRetriesPerSprint; retry++) {
      attempts = retry + 1;

      // Build
      progress.status = "building";
      progress.retryCount = retry;
      await writeProgress(config.workDir, progress);

      if (!sprintStabilityState && lastEval) {
        sprintStabilityState = buildStabilityStateFromEval(contract, lastEval, config.passThreshold);
      }

      const retryFocusCriteria = lastEval
        ? getFailedCriteria(contract, lastEval, config.passThreshold)
        : [];

      await runGenerator(config.workDir, spec, contract, lastEval, retryFocusCriteria);

      // Evaluate
      progress.status = "evaluating";
      await writeProgress(config.workDir, progress);

      const rawEval = await runEvaluator(config.workDir, contract, config.passThreshold);
      const stabilized = stabilizeEvaluation(contract, rawEval, config, sprintStabilityState);
      lastEval = stabilized.result;
      sprintStabilityState = stabilized.state;

      if (config.retryStrategy === "stabilized") {
        await writeSprintStabilityState(config.workDir, sprint, sprintStabilityState);
        const { lockedPassRetained, unlockedRegressions, inconclusiveRetained } = stabilized.summary;
        if (lockedPassRetained > 0 || unlockedRegressions > 0) {
          log(
            "HARNESS",
            `Stabilized retry: retained ${lockedPassRetained} locked pass(es) (${inconclusiveRetained} inconclusive), unlocked ${unlockedRegressions} regression(s)`,
          );
        }
      }

      await writeFeedback(config.workDir, sprint, retry, lastEval);

      if (lastEval.passed) {
        passed = true;
        log("HARNESS", `Sprint ${sprint} PASSED on attempt ${attempts}`);
        break;
      }

      if (retry < config.maxRetriesPerSprint) {
        log("HARNESS", `Sprint ${sprint} failed attempt ${attempts}, retrying...`);
      } else {
        logError("HARNESS", `Sprint ${sprint} FAILED after ${attempts} attempts`);
      }
    }

    results.push({
      sprintNumber: sprint,
      passed,
      attempts,
      evalResult: lastEval,
    });

    if (passed) {
      progress.completedSprints++;
    } else {
      progress.status = "failed";
      await writeProgress(config.workDir, progress);
      logError("HARNESS", `Harness stopped: sprint ${sprint} could not pass evaluation`);
      break;
    }
  }

  // Final status
  const allPassed = results.every((r) => r.passed);
  progress.status = allPassed ? "complete" : "failed";
  await writeProgress(config.workDir, progress);

  const totalDuration = Date.now() - startTime;
  logDivider();
  log("HARNESS", `Harness ${allPassed ? "COMPLETED" : "FAILED"} in ${(totalDuration / 1000 / 60).toFixed(1)} minutes`);
  log("HARNESS", `Sprints: ${results.filter((r) => r.passed).length}/${results.length} passed`);

  return { success: allPassed, sprints: results, totalDurationMs: totalDuration };
}

function deriveTotalSprints(spec: string, maxSprints: number): number {
  const sprintNumbers = Array.from(spec.matchAll(/sprint\s+(\d+)/gi))
    .map((m) => parseInt(m[1]!, 10))
    .filter((n) => n > 0 && n <= maxSprints);

  return sprintNumbers.length > 0
    ? Math.min(Math.max(...sprintNumbers), maxSprints)
    : 3;
}

async function negotiateContract(
  workDir: string,
  spec: string,
  sprintNumber: number,
): Promise<SprintContract> {
  // Generator proposes contract
  const proposalPrompt = `## Product Spec\n\n${spec}\n\n## Sprint Number: ${sprintNumber}\n\nPropose a sprint contract for this sprint.`;

  const proposalOptions: Options = {
    cwd: workDir,
    systemPrompt: CONTRACT_NEGOTIATION_GENERATOR_PROMPT,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    tools: ["Read"],
    model: CLAUDE_MODEL,
    maxTurns: 10,
    persistSession: false,
  };

  let proposalText = "";
  for await (const msg of query({ prompt: proposalPrompt, options: proposalOptions })) {
    if (msg.type === "assistant") {
      const message = msg as { message: { content: Array<{ type: string; text?: string }> } };
      for (const block of message.message.content) {
        if (block.type === "text" && block.text) {
          proposalText += block.text;
        }
      }
    }
  }

  // Evaluator reviews contract
  const reviewPrompt = `## Proposed Sprint Contract\n\n${proposalText}\n\nReview this contract.`;

  const reviewOptions: Options = {
    cwd: workDir,
    systemPrompt: CONTRACT_NEGOTIATION_EVALUATOR_PROMPT,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    tools: ["Read"],
    model: CLAUDE_MODEL,
    maxTurns: 10,
    persistSession: false,
  };

  let reviewText = "";
  for await (const msg of query({ prompt: reviewPrompt, options: reviewOptions })) {
    if (msg.type === "assistant") {
      const message = msg as { message: { content: Array<{ type: string; text?: string }> } };
      for (const block of message.message.content) {
        if (block.type === "text" && block.text) {
          reviewText += block.text;
        }
      }
    }
  }

  // Parse the final contract (either the proposal if approved, or the revised version)
  const contractSource = reviewText.trim() === "APPROVED" ? proposalText : reviewText;
  return parseContract(contractSource, sprintNumber);
}

function parseContract(text: string, sprintNumber: number): SprintContract {
  // Try multiple extraction strategies
  const candidates: string[] = [];
  const codeBlocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (const match of codeBlocks.reverse()) {
    if (match[1]) candidates.push(match[1].trim());
  }
  const braceMatch = text.match(/\{[\s\S]*"criteria"[\s\S]*\}/);
  if (braceMatch) candidates.push(braceMatch[0]);
  candidates.push(text.trim());

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as SprintContract;
      if (parsed.criteria && Array.isArray(parsed.criteria)) {
        parsed.sprintNumber = sprintNumber;
        return parsed;
      }
    } catch {
      // Try next candidate
    }
  }

  {
    logError("HARNESS", "Failed to parse contract JSON, creating default");
    return {
      sprintNumber,
      features: [`Sprint ${sprintNumber} features`],
      criteria: [
        {
          name: "basic_functionality",
          description: "Core features for this sprint are implemented and working",
          threshold: 7,
        },
        {
          name: "code_quality",
          description: "Code is clean, well-structured, and follows best practices",
          threshold: 7,
        },
        {
          name: "error_handling",
          description: "Errors are handled gracefully with appropriate user feedback",
          threshold: 7,
        },
      ],
    };
  }
}
