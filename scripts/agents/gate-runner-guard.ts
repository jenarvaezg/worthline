/**
 * PreToolUse hook for the `gate-runner` subagent (#1623).
 *
 * gate-runner needs Bash to run the gate, and a subagent's `tools` field cannot
 * scope Bash by command. This hook is the backstop: it denies the Bash commands
 * that change the repo's state. The agent's prompt is still the rule; the hook
 * catches a slip.
 *
 * Contract (Claude Code hooks): the hook input JSON arrives on stdin, with the
 * command in `tool_input.command`. Exit 2 blocks the call and feeds stderr back to
 * the agent; exit 0 raises no objection.
 *
 * Not a sandbox. A redirect target held in a variable (`> "$LOG"`) cannot be
 * resolved statically, so it is allowed: that is how the agent writes its log.
 *
 * Claude Code runs a project subagent's frontmatter hooks only once workspace
 * trust has been accepted for the folder the agent file came from, and a
 * `claude -p` session does not count as accepting it.
 */
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

const MUTATING_GIT_VERBS = [
  "add",
  "am",
  "apply",
  "checkout",
  "cherry-pick",
  "clean",
  "commit",
  "merge",
  "mv",
  "pull",
  "push",
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "switch",
];

// `git`, then any global options (`-C <dir>`, `--no-pager`, `-c k=v`), then the verb.
const GIT_MUTATION = new RegExp(
  String.raw`\bgit(?:\s+(?:-[Cc]\s+\S+|--?[\w-]+(?:=\S+)?))*\s+(?:${MUTATING_GIT_VERBS.join("|")})(?![\w-])`,
);

const RULES: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: GIT_MUTATION,
    reason:
      "git commands that change state are not allowed (read-only git and `git fetch origin main` are)",
  },
  {
    pattern: /\bsed\b[^|;&\n]*?\s(?:-[A-Za-z]*i|--in-place)/,
    reason: "`sed -i` edits files in place",
  },
  {
    pattern: /\bbun\s+(?:add|a|remove|rm|update|upgrade)\b/,
    reason: "adding, removing or updating dependencies is not allowed",
  },
  {
    pattern: /\bbun\s+(?:install|i)\b(?![^|;&\n]*--frozen-lockfile)/,
    reason:
      "`bun install` runs only with `--frozen-lockfile`; a plain install rewrites bun.lock",
  },
  {
    pattern: /\bbun\s+(?:run\s+)?format(?![\w:-])/,
    reason: "`bun run format` rewrites files; report the format diagnostic instead",
  },
  {
    pattern: /\bbiome\b[^|;&\n]*?\s--(?:write|fix|apply|apply-unsafe|unsafe)\b/,
    reason: "`biome --write` / `--fix` rewrites files",
  },
];

const WORD_BREAK = /[\s;&|<>()]/;

function readWord(command: string, start: number): { word: string; end: number } {
  let word = "";
  let quote: string | null = null;
  let i = start;
  for (; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (WORD_BREAK.test(ch)) break;
    word += ch;
  }
  return { word, end: i };
}

/** Paths a command writes to through `>`, `>>`, `>|` or `tee`, quotes stripped. */
export function writeTargets(command: string): string[] {
  const targets: string[] = [];
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"') i++;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === ">") {
      let j = i + 1;
      if (command[j] === ">" || command[j] === "|") j++;
      // `2>&1`, `>&2`: fd duplication. `>(…)`: process substitution.
      if (command[j] === "&" || command[j] === "(") continue;
      while (command[j] === " " || command[j] === "\t") j++;
      const { word, end } = readWord(command, j);
      if (word) targets.push(word);
      i = end - 1;
      continue;
    }
    if (command.startsWith("tee", i) && /^tee(?:\s|$)/.test(command.slice(i, i + 4))) {
      const before = i === 0 ? " " : command[i - 1];
      if (!/[\s;&|(]/.test(before)) continue;
      let j = i + 3;
      while (j < command.length) {
        while (command[j] === " " || command[j] === "\t") j++;
        if (j >= command.length || WORD_BREAK.test(command[j])) break;
        const { word, end } = readWord(command, j);
        if (word && !word.startsWith("-")) targets.push(word);
        j = end;
      }
      i = j - 1;
    }
  }
  return targets;
}

function writesIntoRepo(target: string, repoRoots: readonly string[]): boolean {
  // A variable or a command substitution cannot be resolved here (see header).
  if (target.startsWith("$") || target.startsWith("`")) return false;
  if (target.startsWith("/dev/")) return false;
  const expanded =
    target === "~" || target.startsWith("~/") ? `${homedir()}${target.slice(1)}` : target;
  // Relative to the tree the agent cd'd into: inside the repo by construction.
  if (!isAbsolute(expanded)) return true;
  const path = resolve(expanded);
  return repoRoots.some((root) => path === root || path.startsWith(`${root}${sep}`));
}

/** Why the guard blocks `command`, or `null` when it raises no objection. */
export function denyReason(command: string, repoRoots: readonly string[]): string | null {
  for (const rule of RULES) {
    if (rule.pattern.test(command)) return rule.reason;
  }
  const intoRepo = writeTargets(command).find((target) =>
    writesIntoRepo(target, repoRoots),
  );
  if (intoRepo !== undefined) {
    return `writing to \`${intoRepo}\` would touch the repo; logs go under $TMPDIR`;
  }
  return null;
}

function gitToplevel(dir: string): string | null {
  const result = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  return result.status === 0 ? resolve(result.stdout.trim()) : null;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function block(message: string): never {
  process.stderr.write(`gate-runner guard: ${message}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  let input: { tool_name?: unknown; tool_input?: { command?: unknown }; cwd?: unknown };
  try {
    input = JSON.parse(await readStdin());
  } catch (error) {
    // Fail closed: a guard that cannot read its input must not wave commands through.
    block(`could not read the hook input (${String(error)})`);
  }
  if (input.tool_name !== "Bash") return;
  const command = input.tool_input?.command;
  if (typeof command !== "string") block("the Bash call carries no command string");

  const dirs = [process.env.CLAUDE_PROJECT_DIR, input.cwd].filter(
    (dir): dir is string => typeof dir === "string" && dir.length > 0,
  );
  const repoRoots = [
    ...new Set(dirs.map(gitToplevel).filter((root) => root !== null)),
  ] as string[];

  const reason = denyReason(command, repoRoots);
  if (reason !== null) {
    block(`blocked: ${reason}. You run the gate and report; the caller fixes.`);
  }
}

if (import.meta.main) {
  await main();
}
