/**
 * How the gate-runner guard reads a Bash command line (#1816): the words of each
 * simple command, quotes stripped, with redirections taken out. Nothing is expanded
 * or globbed: a word keeps its `$VAR` and its `*`, and a `$(…)` inside double quotes
 * stays part of one word.
 */
import { basename } from "node:path";

export interface ShellLine {
  /** Each simple command's words, quotes stripped and redirections taken out. */
  readonly commands: ReadonlyArray<readonly string[]>;
  /** Where `>`, `>>`, `>|`, `&>`, `>&file` and `<>` send output. */
  readonly outputs: readonly string[];
}

// A backtick splits too: what runs inside it is a command of its own.
const SEPARATORS = new Set([";", "&", "|", "(", ")", "`", "\n"]);

// The operand of `>&` is a descriptor (`2>&1`, `>&-`); anything else is a file.
const DESCRIPTOR = /^(?:\d+-?|-)$/;

export function parseShellLine(command: string): ShellLine {
  const commands: string[][] = [];
  const outputs: string[] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: string | null = null;
  // What the word being read is to its command: an argument, where output goes,
  // the operand of `>&`, or an input it reads.
  let role: "argument" | "output" | "duplicate" | "input" = "argument";

  const endWord = () => {
    if (!inWord) return;
    if (role === "argument") words.push(word);
    else if (role === "output" || (role === "duplicate" && !DESCRIPTOR.test(word))) {
      outputs.push(word);
    }
    role = "argument";
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    role = "argument";
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
    // `$'…'` and `$"…"` are quotes, not a variable.
    if (ch === "$" && /['"]/.test(command.charAt(i + 1))) continue;
    if (ch === "\\") {
      const escaped = command[++i];
      if (escaped !== undefined && escaped !== "\n") {
        word += escaped;
        inWord = true;
      }
      continue;
    }
    if (ch === "#" && !inWord) {
      while (i + 1 < command.length && command.charAt(i + 1) !== "\n") i++;
      continue;
    }
    if (ch === ">" || ch === "<" || (ch === "&" && command.charAt(i + 1) === ">")) {
      // An fd number glued to the operator (`2>`) belongs to it, not to the command.
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else endWord();
      let j = ch === "&" ? i + 2 : i + 1;
      while (j < command.length && "<>|".includes(command.charAt(j))) j++;
      const writes = command.slice(i, j).includes(">");
      if (command.charAt(j) === "&") {
        role = writes ? "duplicate" : "input";
        i = j;
      } else if (command.charAt(j) === "(") {
        // `>(…)`, `<(…)`: process substitution, the parenthesis opens a command.
        i = j - 1;
      } else {
        role = writes ? "output" : "input";
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

// Words that run the word after them as the command: shell keywords and prefixes.
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
  "env",
]);

const ASSIGNMENT = /^[A-Za-z_]\w*=/;

/** The command a simple command runs (`/bin/rm` reads as `rm`) and its arguments. */
export function invocation(
  words: readonly string[],
): { name: string; args: string[] } | null {
  let at = 0;
  let prefixed = false;
  // Past assignments (`FOO=1`), keywords and prefixes, and a prefix's options (`time -p`).
  for (; at < words.length; at++) {
    const word = words[at] ?? "";
    if (COMMAND_PREFIXES.has(word)) prefixed = true;
    else if (!ASSIGNMENT.test(word) && !(prefixed && word.startsWith("-"))) break;
  }
  const name = words[at];
  return name === undefined ? null : { name: basename(name), args: words.slice(at + 1) };
}

/** The arguments that are not options; everything after `--` is one. */
export function operands(args: readonly string[]): string[] {
  const end = args.indexOf("--");
  const head = end === -1 ? args : args.slice(0, end);
  const tail = end === -1 ? [] : args.slice(end + 1);
  return [...head.filter((arg) => !arg.startsWith("-")), ...tail];
}
