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
 * Not a sandbox. A path held in a variable (`> "$LOG"`, `perl -pi … "$LOG"`) cannot
 * be resolved statically, so it is allowed: that is how the agent writes and cleans
 * its log. A relative path counts as inside the repo.
 *
 * Claude Code runs a project subagent's frontmatter hooks only once workspace
 * trust has been accepted for the folder the agent file came from, and a
 * `claude -p` session does not count as accepting it.
 */
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve, sep } from "node:path";

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

/** A command line as the guard reads it: no expansion, no globbing. */
interface ShellLine {
  /** Each simple command's words, quotes stripped and redirections taken out. */
  readonly commands: ReadonlyArray<readonly string[]>;
  /** Where `>`, `>>`, `>|` and `&>` send output. */
  readonly outputs: readonly string[];
}

const SEPARATORS = new Set([";", "&", "|", "(", ")", "\n"]);

function parseShell(command: string): ShellLine {
  const commands: string[][] = [];
  const outputs: string[] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: string | null = null;
  // The next word is an argument, an output target, or an operand to drop (`< in`, `>&2`).
  let next: "arg" | "output" | "drop" = "arg";

  const endWord = () => {
    if (!inWord) return;
    if (next === "output") outputs.push(word);
    else if (next === "arg") words.push(word);
    next = "arg";
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    next = "arg";
    if (words.length > 0) commands.push(words);
    words = [];
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command.charAt(i);
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && /[$`"\\]/.test(command.charAt(i + 1))) {
        word += command.charAt(++i);
      } else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === "\\") {
      const escaped = command[++i];
      if (escaped !== undefined && escaped !== "\n") {
        word += escaped;
        inWord = true;
      }
      continue;
    }
    if (ch === "#" && !inWord) {
      while (i + 1 < command.length && command[i + 1] !== "\n") i++;
      continue;
    }
    if (ch === ">" || ch === "<" || (ch === "&" && command[i + 1] === ">")) {
      // An fd number glued to the operator (`2>`) belongs to it, not to the command.
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else endWord();
      let j = ch === "&" ? i + 2 : i + 1;
      while (j < command.length && "<>|".includes(command.charAt(j))) j++;
      if (command[j] === "&") {
        // `2>&1`, `>&2`: fd duplication, the operand is a descriptor.
        next = "drop";
        i = j;
      } else if (command[j] === "(") {
        // `>(…)`: process substitution, the parenthesis opens a command.
        i = j - 1;
      } else {
        next = ch === "<" ? "drop" : "output";
        i = j - 1;
      }
      continue;
    }
    if (ch === " " || ch === "\t") endWord();
    else if (SEPARATORS.has(ch)) endCommand();
    else {
      word += ch;
      inWord = true;
    }
  }
  endCommand();
  return { commands, outputs };
}

// Words that run the word after them as the command.
const COMMAND_PREFIXES = new Set([
  "!",
  "{",
  "if",
  "then",
  "else",
  "elif",
  "while",
  "until",
  "do",
  "time",
  "command",
  "builtin",
  "exec",
  "nohup",
]);

/** The command a simple command runs (`/bin/rm` reads as `rm`) and its arguments. */
function invocation(words: readonly string[]): { name: string; args: string[] } | null {
  const at = words.findIndex(
    (w) => !COMMAND_PREFIXES.has(w) && !/^[A-Za-z_]\w*=/.test(w),
  );
  const name = words[at];
  return name === undefined ? null : { name: basename(name), args: words.slice(at + 1) };
}

/** The arguments that are not options; everything after `--` is one. */
function operands(args: readonly string[]): string[] {
  const end = args.indexOf("--");
  const head = end === -1 ? args : args.slice(0, end);
  const tail = end === -1 ? [] : args.slice(end + 1);
  return [...head.filter((arg) => !arg.startsWith("-")), ...tail];
}

function outputTargets(line: ShellLine): string[] {
  const teed = line.commands.flatMap((words) => {
    const call = invocation(words);
    return call?.name === "tee" ? operands(call.args) : [];
  });
  return [...line.outputs, ...teed];
}

/** Paths a command writes to through `>`, `>>`, `>|`, `&>` or `tee`, quotes stripped. */
export function writeTargets(command: string): string[] {
  return outputTargets(parseShell(command));
}

const FILE_COMMANDS = new Set(["rm", "mv", "cp"]);

// perl switches that take no value; the digits are the optional values of `-0` and `-l`.
const PERL_FLAGS = /[0-9achlnpsStTuUvwWX]/;

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
      if (PERL_FLAGS.test(ch)) continue;
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

/** The paths that `rm`, `mv`, `cp` and `perl -i` would remove, move, copy or edit. */
function fileOperands(line: ShellLine): Array<{ tool: string; path: string }> {
  return line.commands.flatMap((words) => {
    const call = invocation(words);
    if (call === null) return [];
    const [tool, paths]: [string, string[]] =
      call.name === "perl"
        ? ["perl -i", perlInPlaceFiles(call.args)]
        : [call.name, FILE_COMMANDS.has(call.name) ? operands(call.args) : []];
    return paths.map((path) => ({ tool, path }));
  });
}

function insideRepo(path: string, repoRoots: readonly string[]): boolean {
  // A variable or a command substitution cannot be resolved here (see header).
  if (path.startsWith("$") || path.startsWith("`")) return false;
  if (path.startsWith("/dev/")) return false;
  const expanded =
    path === "~" || path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
  // Relative to the tree the agent cd'd into: inside the repo by construction.
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
  const line = parseShell(command);
  const written = outputTargets(line).find((target) => insideRepo(target, repoRoots));
  if (written !== undefined) {
    return `writing to \`${written}\` would touch the repo; logs go under $TMPDIR`;
  }
  const touched = fileOperands(line).find(({ path }) => insideRepo(path, repoRoots));
  if (touched !== undefined) {
    return `\`${touched.tool}\` on \`${touched.path}\` would touch the repo; only your logs under $TMPDIR are yours to remove or edit`;
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
