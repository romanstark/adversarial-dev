import { Codex } from "@openai/codex-sdk";
import { EVALUATOR_SYSTEM_PROMPT } from "../shared/prompts.ts";
import { CODEX_MODEL, CODEX_NETWORK_ACCESS } from "../shared/config.ts";
import { log, logError } from "../shared/logger.ts";
import type { SprintContract, EvalResult } from "../shared/types.ts";

function getCriterionThreshold(contract: SprintContract, criterion: string, fallback: number): number {
  const rawThreshold = contract.criteria.find((c) => c.name === criterion)?.threshold;
  if (typeof rawThreshold !== "number" || !Number.isFinite(rawThreshold)) {
    return fallback;
  }
  if (rawThreshold < 0 || rawThreshold > 10) {
    return fallback;
  }
  return rawThreshold;
}

export async function runEvaluator(
  workDir: string,
  contract: SprintContract,
  passThreshold: number,
): Promise<EvalResult> {
  const sprint = contract.sprintNumber;
  log("EVALUATOR", `Evaluating sprint ${sprint} against ${contract.criteria.length} criteria`);

  const taskPrompt = `## Sprint Contract to Evaluate Against

${JSON.stringify(contract, null, 2)}

## Pass Threshold

Each criterion must satisfy its own \
\`threshold\` from the sprint contract. If a criterion has no threshold, use ${passThreshold}/10.

## Instructions

Examine the application in the \`app/\` directory. Read the code, run it if possible, and score each criterion. Output ONLY the JSON evaluation object.`;

  const fullPrompt = `${EVALUATOR_SYSTEM_PROMPT}\n\n---\n\n${taskPrompt}`;

  const codex = new Codex();
  const thread = codex.startThread({
    workingDirectory: workDir,
    sandboxMode: "danger-full-access",
    networkAccessEnabled: CODEX_NETWORK_ACCESS,
    approvalPolicy: "never",
    model: CODEX_MODEL,
  });

  const turn = await thread.run(fullPrompt);
  const response = turn.finalResponse ?? "";

  log("EVALUATOR", `Evaluation complete for sprint ${sprint}`);

  const invalidThresholds = contract.criteria
    .filter((criterion) => Number.isFinite(criterion.threshold) && (criterion.threshold < 0 || criterion.threshold > 10))
    .map((criterion) => `${criterion.name}=${criterion.threshold}`);

  if (invalidThresholds.length > 0) {
    log(
      "EVALUATOR",
      `Ignoring ${invalidThresholds.length} out-of-range contract thresholds (expected 0-10): ${invalidThresholds.join(", ")}`,
    );
  }

  const evalResult = parseEvalResult(response, contract, passThreshold);

  const passedCount = evalResult.feedback.filter((f) => f.score >= getCriterionThreshold(contract, f.criterion, passThreshold)).length;
  const totalCount = evalResult.feedback.length;
  const verdict = evalResult.passed ? "PASSED" : "FAILED";
  log("EVALUATOR", `Sprint ${sprint}: ${verdict} (${passedCount}/${totalCount} criteria passed)`);

  for (const item of evalResult.feedback) {
    const threshold = getCriterionThreshold(contract, item.criterion, passThreshold);
    const status = item.score >= threshold ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
    log("EVALUATOR", `  [${status}] ${item.criterion}: ${item.score}/10 (threshold ${threshold}) - ${item.details.slice(0, 100)}`);
  }

  return evalResult;
}

function parseEvalResult(
  response: string,
  contract: SprintContract,
  passThreshold: number,
): EvalResult {
  // Try multiple strategies to extract JSON from the response
  const candidates: string[] = [];

  // Strategy 1: Look for the LAST JSON code block (most likely the final answer)
  const codeBlocks = [...response.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (const match of codeBlocks.reverse()) {
    if (match[1]) candidates.push(match[1].trim());
  }

  // Strategy 2: Find the largest {...} block containing expected fields
  const braceMatch = response.match(/\{[\s\S]*"passed"[\s\S]*"feedback"[\s\S]*\}/);
  if (braceMatch) candidates.push(braceMatch[0]);

  // Strategy 3: Raw response as-is
  candidates.push(response.trim());

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as EvalResult;
      if (parsed.feedback && Array.isArray(parsed.feedback)) {
        parsed.passed = parsed.feedback.every((f) => f.score >= getCriterionThreshold(contract, f.criterion, passThreshold));
        return parsed;
      }
    } catch {
      // Try next candidate
    }
  }

  logError("EVALUATOR", "Failed to parse evaluation JSON from any extraction strategy");
  return {
    passed: false,
    scores: {},
    feedback: contract.criteria.map((c) => ({
      criterion: c.name,
      score: 0,
      details: "Evaluator failed to produce parseable output",
    })),
    overallSummary: "Evaluation parsing failed. Raw response: " + response.slice(0, 500),
  };
}
