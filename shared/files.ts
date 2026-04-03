import { mkdir, readFile, writeFile, access, rm, readdir, unlink } from "fs/promises";
import { join } from "path";
import { execSync } from "child_process";
import type { SprintContract, EvalResult, HarnessProgress } from "./types.ts";

export async function initWorkspace(
  workDir: string,
  options: { clean?: boolean } = {},
): Promise<void> {
  const clean = options.clean ?? true;
  await mkdir(join(workDir, "contracts"), { recursive: true });
  await mkdir(join(workDir, "feedback"), { recursive: true });
  await mkdir(join(workDir, "app"), { recursive: true });

  // Clean stale artifacts from previous runs
  if (clean) {
    try { await unlink(join(workDir, "spec.md")); } catch {}
    try { await unlink(join(workDir, "progress.json")); } catch {}
    for (const dir of ["contracts", "feedback"]) {
      try {
        const files = await readdir(join(workDir, dir));
        for (const f of files) {
          await unlink(join(workDir, dir, f));
        }
      } catch {}
    }
  }

  // Initialize app/ as its own git repo so agent commits stay isolated
  const appDir = join(workDir, "app");
  const gitDir = join(appDir, ".git");
  try {
    await access(gitDir);
  } catch {
    try {
      execSync("git init && git commit --allow-empty -m \"Initial commit\"", {
        cwd: appDir,
        stdio: "ignore",
      });
    } catch (err) {
      console.warn(`Warning: failed to initialize git in ${appDir}: ${err}`);
    }
  }
}

export async function findLatestFeedbackRound(
  workDir: string,
  sprintNumber: number,
): Promise<number | null> {
  const feedbackDir = join(workDir, "feedback");
  const pattern = new RegExp(`^sprint-${sprintNumber}-round-(\\d+)\\.json$`);

  try {
    const files = await readdir(feedbackDir);
    const rounds = files
      .map((file) => {
        const match = file.match(pattern);
        return match ? parseInt(match[1]!, 10) : null;
      })
      .filter((round): round is number => round !== null)
      .sort((a, b) => b - a);

    return rounds.length > 0 ? rounds[0]! : null;
  } catch {
    return null;
  }
}

export async function writeSpec(workDir: string, spec: string): Promise<void> {
  await writeFile(join(workDir, "spec.md"), spec, "utf-8");
}

export async function readSpec(workDir: string): Promise<string> {
  return readFile(join(workDir, "spec.md"), "utf-8");
}

export async function writeContract(workDir: string, contract: SprintContract): Promise<void> {
  const path = join(workDir, "contracts", `sprint-${contract.sprintNumber}.json`);
  await writeFile(path, JSON.stringify(contract, null, 2), "utf-8");
}

export async function readContract(workDir: string, sprintNumber: number): Promise<SprintContract> {
  const path = join(workDir, "contracts", `sprint-${sprintNumber}.json`);
  const raw = await readFile(path, "utf-8");
  try {
    return JSON.parse(raw) as SprintContract;
  } catch {
    throw new Error(`Invalid JSON in contract file: ${path}`);
  }
}

export async function writeFeedback(
  workDir: string,
  sprintNumber: number,
  round: number,
  result: EvalResult,
): Promise<void> {
  const path = join(workDir, "feedback", `sprint-${sprintNumber}-round-${round}.json`);
  await writeFile(path, JSON.stringify(result, null, 2), "utf-8");
}

export async function readFeedback(
  workDir: string,
  sprintNumber: number,
  round: number,
): Promise<EvalResult> {
  const path = join(workDir, "feedback", `sprint-${sprintNumber}-round-${round}.json`);
  const raw = await readFile(path, "utf-8");
  try {
    return JSON.parse(raw) as EvalResult;
  } catch {
    throw new Error(`Invalid JSON in feedback file: ${path}`);
  }
}

export async function writeProgress(workDir: string, progress: HarnessProgress): Promise<void> {
  await writeFile(join(workDir, "progress.json"), JSON.stringify(progress, null, 2), "utf-8");
}

export async function readProgress(workDir: string): Promise<HarnessProgress> {
  const raw = await readFile(join(workDir, "progress.json"), "utf-8");
  try {
    return JSON.parse(raw) as HarnessProgress;
  } catch {
    throw new Error(`Invalid JSON in progress file: ${join(workDir, "progress.json")}`);
  }
}
