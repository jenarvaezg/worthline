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
 * Not a sandbox. It reads the command line without running it (`shell-line.ts`). A
 * path held in a variable (`> "$LOG"`, `perl -pi … "$LOG"`) cannot be resolved, so it
 * is allowed: that is how the agent writes and cleans its log. A relative path, or
 * one under `$PWD`, counts as inside the repo. A command that another program runs
 * (`xargs rm`, `find -exec`, `sudo`) or that sits in a `$(…)` inside double quotes
 * is not seen.
 *
 * Claude Code runs a project subagent's frontmatter hooks only once workspace
 * trust has been accepted for the folder the agent file came from, and a
 * `claude -p` session does not count as accepting it.
 */
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { invocation, operands, parseShellLine } from "./shell-line";

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

// perl switches that take no value; the digits are the optional values of `-0` and `-l`.
const PERL_VALUELESS_SWITCHES = /[0-9achlnpsStTuUvwWX]/;

/** The files `perl` would edit in place: none without `-i`. */
function perlInPlaceFiles(args: readonly string[]): string[] {
  let inPlace = false;
  let inlineCode = false;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") {
      i++;
      break;
    }
    if (!arg.startsWith("-") || arg === "-") break;
    // A cluster of switches (`-pi`, `-0777ne`): `-i` takes the rest as its backup
    // suffix, and a switch with a value takes the rest or, for `-e` and `-I`, the
    // next argument.
    for (let k = 1; k < arg.length; k++) {
      const ch = arg.charAt(k);
      if (PERL_VALUELESS_SWITCHES.test(ch)) continue;
      if (ch === "i") inPlace = true;
      if (ch === "e" || ch === "E") inlineCode = true;
      if ("eEI".includes(ch) && k === arg.length - 1) i++;
      break;
    }
  }
  if (!inPlace) return [];
  // Without `-e`, the first operand is the script, not a file it edits.
  return inlineCode ? args.slice(i) : args.slice(i + 1);
}

const TARGET_DIRECTORY = "--target-directory=";

/** What `cp` and `mv` touch: their operands, and a destination named by option. */
function copyOperands(args: readonly string[]): string[] {
  const named = args
    .filter((arg) => arg.startsWith(TARGET_DIRECTORY))
    .map((arg) => arg.slice(TARGET_DIRECTORY.length));
  return [...operands(args), ...named];
}

// The commands that change the files they name, and how each one names them.
const PATH_READERS = new Map<string, (args: readonly string[]) => string[]>([
  ["tee", operands],
  ["rm", operands],
  ["mv", copyOperands],
  ["cp", copyOperands],
  ["perl", perlInPlaceFiles],
]);

/** Every path `command` would write, remove, move, copy or edit in place, and how. */
export function touchedPaths(command: string): Array<{ by: string; path: string }> {
  const line = parseShellLine(command);
  const named = line.commands.flatMap((words) => {
    const call = invocation(words);
    const read = call === null ? undefined : PATH_READERS.get(call.name);
    if (call === null || read === undefined) return [];
    const by = call.name === "perl" ? "perl -i" : call.name;
    return read(call.args).map((path) => ({ by, path }));
  });
  return [...line.outputs.map((path) => ({ by: ">", path })), ...named];
}

function insideRepo(path: string, repoRoots: readonly string[]): boolean {
  // Relative to the tree the agent cd'd into: inside the repo by construction.
  if (/^\$(?:PWD|\{PWD\})(?:\/|$)/.test(path)) return true;
  // Any other variable or command substitution cannot be resolved here (see header).
  if (path.startsWith("$") || path.startsWith("`")) return false;
  if (path.startsWith("/dev/")) return false;
  const expanded =
    path === "~" || path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
  if (!isAbsolute(expanded)) return true;
  const resolved = resolve(expanded);
  return repoRoots.some(
    (root) => resolved === root || resolved.startsWith(`${root}${sep}`),
  );
}

/** Why the guard blocks `command`, or `null` when it raises no objection. */
export function denyReason(command: string, repoRoots: readonly string[]): string | null {
  for (const rule of RULES) {
    if (rule.pattern.test(command)) return rule.reason;
  }
  const touched = touchedPaths(command).find(({ path }) => insideRepo(path, repoRoots));
  if (touched !== undefined) {
    const action = touched.by === ">" ? "writing to" : `\`${touched.by}\` on`;
    return `${action} \`${touched.path}\` would touch the repo; logs go under $TMPDIR`;
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
