import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { denyReason, touchedPaths } from "@scripts/agents/gate-runner-guard";
import { describe, expect, test } from "vitest";

const REPO = "/work/worthline";
const ROOTS = [REPO];

describe("gate-runner guard: what the agent's own procedure needs", () => {
  test.each([
    "bun install --frozen-lockfile",
    `LOG="$(mktemp "\${TMPDIR:-/tmp}/gate-verify.XXXXXX")" && bun run verify > "$LOG" 2>&1; echo "exit=$? log=$LOG"`,
    "bun run build > /tmp/gate-build.log 2>&1; echo exit=$?",
    String.raw`perl -pi -e 's/\e\[[0-9;?]*[A-Za-z]//g' "$LOG"`,
    "git fetch origin main",
    "git diff --name-only origin/main...HEAD",
    "git diff origin/main...HEAD -G 'searchParams|PageProps|LayoutProps' --name-only -- apps/web",
    "git status --porcelain",
    "git log -1 --format='%h %s'",
    "git rev-parse --abbrev-ref HEAD",
    "grep -n 'error TS' /var/folders/x/T/gate-verify.abc",
    "sed -n '120,140p' /tmp/gate-verify.abc",
    "bunx vitest run --root apps/web --config vitest.config.ts app/x.test.ts",
    "bun run verify 2>/dev/null",
    `cd ${REPO}/.claude/worktrees/x && bun run verify > "$LOG" 2>&1`,
    "rm /tmp/gate-verify.abc",
    'rm -f "$LOG" 2>/dev/null',
    "cp /tmp/gate-verify.abc /tmp/gate-verify.keep",
    String.raw`perl -pi -e 's/\e\][^\a\e]*(?:\a|\e\\)//g; s/\e\[[0-9;?]*[A-Za-z]//g' "$LOG"`,
  ])("allows %s", (command) => {
    expect(denyReason(command, ROOTS)).toBeNull();
  });
});

describe("gate-runner guard: what only reads or names the repo", () => {
  test.each([
    "perl -ne 'print if /TODO/' apps/web/app/x.ts",
    `perl -i scripts/strip.pl "$LOG"`,
    "sort < apps/web/app/x.ts",
    "echo rm -rf apps/web",
    "grep -rn 'rm -rf' apps",
    "ls apps # rm -rf apps",
  ])("allows %s", (command) => {
    expect(denyReason(command, ROOTS)).toBeNull();
  });
});

describe("gate-runner guard: what changes state", () => {
  test.each([
    "git commit -qm wip",
    "git -C /work/worthline push origin HEAD",
    "git checkout -- apps/web/app/x.ts",
    "git reset --hard",
    "git add apps/web/app/x.ts",
    "git stash push -u",
    "git restore apps/web/app/x.ts",
    "git --no-pager cherry-pick abc123",
    "sed -i '' 's/a/b/' apps/web/app/x.ts",
    "sed -Ei 's/a/b/' apps/web/app/x.ts",
    "bun add zod",
    "bun remove zod",
    "bun install",
    "bun run format",
    "bunx biome check --write .",
    "bunx biome format --write apps/web",
    "echo x > apps/web/app/x.ts",
    "echo x >> README.md",
    `echo x > ${REPO}/packages/domain/src/x.ts`,
    `cd ${REPO} && bun run verify > gate.log 2>&1`,
    "bun run verify | tee apps/web/gate.log",
    "rm -rf apps/web",
    `rm -f ${REPO}/probe.txt`,
    "mv packages/domain/src/x.ts /tmp/",
    "cp /tmp/x.ts apps/web/app/x.ts",
    "cd /tmp && /bin/rm -rf -- apps",
    "perl -pi -e 's/a/b/' apps/web/app/x.ts",
    "perl -i.bak -pe 's/a/b/' apps/web/app/x.ts",
    "perl -p -i -e 's/a/b/' README.md",
    "perl -i /tmp/strip.pl README.md",
    "bun run verify &> gate.log",
    "bun run verify >& apps/web/gate.log",
    ": 3<>apps/web/app/x.ts",
    "rm -rf $'apps/web'",
    "echo `rm -rf apps/web`",
    "if true; then rm -rf apps; fi",
    "FOO=1 env -i rm -rf apps",
    "time -p rm -rf apps",
    "cp --target-directory=apps/web/app /tmp/x.ts",
    'rm -rf "$PWD/apps"',
  ])("denies %s", (command) => {
    expect(denyReason(command, ROOTS)).not.toBeNull();
  });
});

describe("touchedPaths", () => {
  test("ignores fd duplication, quotes and process substitution", () => {
    expect(touchedPaths(`echo "a > b" 2>&1 >&2 >(cat)`)).toEqual([]);
  });

  test("strips quotes from targets and reads every tee argument", () => {
    expect(touchedPaths(`cmd > "out dir/x.log" | tee -a one.log 'two.log'`)).toEqual([
      { by: ">", path: "out dir/x.log" },
      { by: "tee", path: "one.log" },
      { by: "tee", path: "two.log" },
    ]);
  });
});

describe("gate-runner guard as a Claude Code hook", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const script = join(repoRoot, "scripts/agents/gate-runner-guard.ts");

  function runHook(input: unknown) {
    return spawnSync("bun", [script], {
      input: typeof input === "string" ? input : JSON.stringify(input),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: repoRoot },
    });
  }

  const bashCall = (command: string) => ({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    cwd: repoRoot,
  });

  test("exits 0 for bun run verify", () => {
    const result = runHook(bashCall('bun run verify > "$LOG" 2>&1'));
    expect(result.status).toBe(0);
  });

  test("exits 2 with the reason on stderr for a state change", () => {
    const result = runHook(bashCall("git commit -qm wip"));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("git commands that change state");
  });

  test("exits 2 for a write into the repo by absolute path", () => {
    const result = runHook(bashCall(`echo x > ${join(repoRoot, "probe.txt")}`));
    expect(result.status).toBe(2);
  });

  test("fails closed when the input is not JSON", () => {
    expect(runHook("not json").status).toBe(2);
  });
});
