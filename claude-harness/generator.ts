import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { GENERATOR_SYSTEM_PROMPT } from "../shared/prompts.ts";
import { CLAUDE_MODEL, CLAUDE_MAX_TURNS } from "../shared/config.ts";
import { log, logError } from "../shared/logger.ts";
import type { SprintContract, EvalResult } from "../shared/types.ts";

export async function runGenerator(
  workDir: string,
  spec: string,
  contract: SprintContract,
  previousFeedback?: EvalResult,
  retryFocusCriteria: string[] = [],
): Promise<{ response: string; sessionId?: string }> {
  const sprint = contract.sprintNumber;
  const attempt = previousFeedback ? "retry" : "initial";
  log("GENERATOR", `Sprint ${sprint} (${attempt}) - Building: ${contract.features.join(", ")}`);

  let prompt = `IMPORTANT: Your working directory is ${workDir}. All code MUST be created inside ${workDir}/app/. Do NOT create files outside of ${workDir}.\n\n## Product Spec\n\n${spec}\n\n## Sprint Contract\n\n${JSON.stringify(contract, null, 2)}`;

  if (previousFeedback) {
    prompt += `\n\n## Evaluation Feedback (MUST ADDRESS)\n\n${JSON.stringify(previousFeedback, null, 2)}`;
    if (retryFocusCriteria.length > 0) {
      prompt += `\n\n## Retry Focus (Scope Control)\n\nOnly these criteria are still failing and must be fixed now:\n${retryFocusCriteria.map((name) => `- ${name}`).join("\n")}`;
      prompt += "\n\nMinimize changes outside the failing criteria. Preserve behavior for criteria that already pass unless a dependency forces a shared fix.";
    }
    prompt += `\n\nThe previous attempt failed evaluation. Address every issue in the feedback above.`;
  } else {
    prompt += `\n\nImplement the features listed in this sprint contract. Work in the \`app/\` directory.`;
  }

  const options: Options = {
    cwd: workDir,
    systemPrompt: GENERATOR_SYSTEM_PROMPT,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    model: CLAUDE_MODEL,
    maxTurns: CLAUDE_MAX_TURNS,
    persistSession: true,
  };

  let fullResponse = "";
  let sessionId: string | undefined;

  for await (const msg of query({ prompt, options })) {
    if (msg.type === "assistant") {
      const message = msg as { message: { content: Array<{ type: string; text?: string; name?: string }> } };
      for (const block of message.message.content) {
        if (block.type === "text" && block.text) {
          fullResponse += block.text;
        } else if (block.type === "tool_use" && block.name) {
          log("GENERATOR", `  Tool: ${block.name}`);
        }
      }
    } else if (msg.type === "result") {
      const result = msg as { session_id?: string };
      sessionId = result.session_id;
      log("GENERATOR", `Sprint ${sprint} build complete (session: ${sessionId?.slice(0, 8)}...)`);
    }
  }

  if (!fullResponse) {
    log("GENERATOR", `Sprint ${sprint} completed (agent used tools only, no text output)`);
  }

  return { response: fullResponse, sessionId };
}
