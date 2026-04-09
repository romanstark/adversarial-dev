import type {
  SprintContract,
  EvalResult,
  SprintStabilityState,
  StabilizationSummary,
  CriterionOutcome,
  HarnessConfig,
} from "./types.ts";

const INCONCLUSIVE_PATTERN = /(cannot|can't|unable|not available|unavailable|not possible|missing|not installed|environment|could not run|chrome not available|permission denied|tooling unavailable|sdk unavailable)/i;

export function getCriterionThreshold(contract: SprintContract, criterion: string, fallback: number): number {
  const rawThreshold = contract.criteria.find((c) => c.name === criterion)?.threshold;
  if (typeof rawThreshold !== "number" || !Number.isInteger(rawThreshold)) {
    return fallback;
  }
  if (rawThreshold < 1 || rawThreshold > 10) {
    return fallback;
  }
  return rawThreshold;
}

function classifyOutcome(score: number, threshold: number, details: string): CriterionOutcome {
  if (score >= threshold) {
    return "pass";
  }

  return INCONCLUSIVE_PATTERN.test(details) ? "inconclusive" : "hard_fail";
}

export function buildStabilityStateFromEval(
  contract: SprintContract,
  evalResult: EvalResult,
  passThreshold: number,
): SprintStabilityState {
  const criteria: SprintStabilityState["criteria"] = {};

  for (const criterion of contract.criteria) {
    const threshold = getCriterionThreshold(contract, criterion.name, passThreshold);
    const feedback = evalResult.feedback.find((f) => f.criterion === criterion.name);
    const score = feedback?.score ?? 0;
    const details = feedback?.details ?? "No evaluator feedback";
    const outcome = classifyOutcome(score, threshold, details);

    criteria[criterion.name] = {
      locked: outcome === "pass",
      bestScore: outcome === "pass" ? score : 0,
      consecutiveHardFails: outcome === "hard_fail" ? 1 : 0,
      lastObservedScore: score,
      lastObservedOutcome: outcome,
    };
  }

  return {
    sprintNumber: contract.sprintNumber,
    criteria,
  };
}

export function stabilizeEvaluation(
  contract: SprintContract,
  rawEvalResult: EvalResult,
  config: Pick<HarnessConfig, "passThreshold" | "retryStrategy" | "hardFailUnlockStreak">,
  previousState?: SprintStabilityState,
): { result: EvalResult; state: SprintStabilityState; summary: StabilizationSummary } {
  const summary: StabilizationSummary = {
    lockedPassRetained: 0,
    unlockedRegressions: 0,
    inconclusiveRetained: 0,
  };

  const stateCriteria: SprintStabilityState["criteria"] = {};
  const scores: Record<string, number> = {};
  const feedback = contract.criteria.map((criterion) => {
    const threshold = getCriterionThreshold(contract, criterion.name, config.passThreshold);
    const rawItem = rawEvalResult.feedback.find((f) => f.criterion === criterion.name) ?? {
      criterion: criterion.name,
      score: 0,
      details: "No evaluator feedback returned for this criterion",
    };

    const rawOutcome = classifyOutcome(rawItem.score, threshold, rawItem.details);
    const prev = previousState?.criteria[criterion.name];

    let effectiveScore = rawItem.score;
    let effectiveDetails = rawItem.details;
    let locked = prev?.locked ?? false;
    let bestScore = prev?.bestScore ?? 0;
    let consecutiveHardFails = prev?.consecutiveHardFails ?? 0;

    if (rawOutcome === "pass") {
      locked = true;
      bestScore = Math.max(bestScore, rawItem.score);
      consecutiveHardFails = 0;
    } else if (config.retryStrategy === "stabilized" && prev?.locked) {
      if (rawOutcome === "inconclusive") {
        effectiveScore = Math.max(bestScore, threshold);
        effectiveDetails = `${rawItem.details} [stabilized: retained previous verified pass because this check was inconclusive in the current environment]`;
        summary.lockedPassRetained += 1;
        summary.inconclusiveRetained += 1;
        consecutiveHardFails = 0;
      } else {
        const nextHardFailCount = consecutiveHardFails + 1;
        if (nextHardFailCount < config.hardFailUnlockStreak) {
          effectiveScore = Math.max(bestScore, threshold);
          effectiveDetails = `${rawItem.details} [stabilized: retained previous verified pass; hard fail ${nextHardFailCount}/${config.hardFailUnlockStreak} before unlock]`;
          summary.lockedPassRetained += 1;
          consecutiveHardFails = nextHardFailCount;
        } else {
          locked = false;
          summary.unlockedRegressions += 1;
          consecutiveHardFails = nextHardFailCount;
        }
      }
    } else if (rawOutcome === "hard_fail") {
      consecutiveHardFails += 1;
    }

    const effectiveOutcome = classifyOutcome(effectiveScore, threshold, effectiveDetails);
    if (effectiveOutcome === "pass") {
      locked = true;
      bestScore = Math.max(bestScore, effectiveScore);
      consecutiveHardFails = 0;
    }

    scores[criterion.name] = effectiveScore;
    stateCriteria[criterion.name] = {
      locked,
      bestScore,
      consecutiveHardFails,
      lastObservedScore: rawItem.score,
      lastObservedOutcome: rawOutcome,
    };

    return {
      criterion: criterion.name,
      score: effectiveScore,
      details: effectiveDetails,
    };
  });

  const passed = contract.criteria.every((criterion) => {
    const threshold = getCriterionThreshold(contract, criterion.name, config.passThreshold);
    const score = scores[criterion.name] ?? 0;
    return score >= threshold;
  });

  return {
    result: {
      passed,
      scores,
      feedback,
      overallSummary: rawEvalResult.overallSummary,
    },
    state: {
      sprintNumber: contract.sprintNumber,
      criteria: stateCriteria,
    },
    summary,
  };
}

export function getFailedCriteria(
  contract: SprintContract,
  evalResult: EvalResult,
  passThreshold: number,
): string[] {
  return contract.criteria
    .filter((criterion) => {
      const threshold = getCriterionThreshold(contract, criterion.name, passThreshold);
      const score = evalResult.feedback.find((f) => f.criterion === criterion.name)?.score ?? 0;
      return score < threshold;
    })
    .map((criterion) => criterion.name);
}
