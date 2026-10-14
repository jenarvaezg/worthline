import type {
  Client,
  InArgs,
  InStatement,
  ResultSet,
  Transaction,
  TransactionMode,
} from "@libsql/client";

/** The `code` every read-only refusal carries, however it was re-wrapped. */
export const READ_ONLY_WORKSPACE_CODE = "WORKSPACE_READ_ONLY";

/**
 * The read-only libSQL client of a viewer principal (#1842, PRD #1718).
 *
 * A viewer opens the owner's workspace with a Turso token that the server itself
 * refuses to write with. That token cannot be exercised locally (`?mode=ro` is
 * `URL_PARAM_NOT_SUPPORTED` on `@libsql/client` 0.18), and the store's write
 * guards live only at the Server Action doors — so this wrapper is the store's
 * own floor: every statement is classified BEFORE it reaches libSQL, and
 * anything that is not a read is refused with {@link ReadOnlyWorkspaceError}.
 *
 * The rule is an allow-list, never a deny-list:
 *   - a statement whose first keyword is `SELECT` (a leading comment, a `WITH`
 *     or an `EXPLAIN` does not qualify — they fail closed);
 *   - `PRAGMA [schema.]name` with no argument, for a name in
 *     {@link READ_ONLY_PRAGMAS} (a pragma with no `=` can still act —
 *     `optimize`, `wal_checkpoint` — so the name is checked too);
 *   - and only ONE statement: anything but whitespace and comments after the
 *     first top-level `;` refuses;
 *   - no bind-variable sigil (`$ : @ #`) outside a literal — see
 *     {@link VARIABLE_SIGILS}; values bind positionally with `?`.
 * `executeMultiple`, `migrate`, `sync` and any transaction that is not `"read"`
 * are refused outright; a `"read"` transaction hands back a handle under the
 * same rule.
 */
export class ReadOnlyWorkspaceError extends Error {
  /**
   * Carried as `code` so the refusal survives the layers that re-wrap a failed
   * statement: drizzle nests it as the `cause` of a `DrizzleQueryError`, and the
   * dated-fact commands re-raise a plain `Error` keeping only message + `code`.
   */
  readonly code = READ_ONLY_WORKSPACE_CODE;

  constructor(operation: string) {
    super(`This workspace is open read-only: ${operation} refused.`);
    this.name = "ReadOnlyWorkspaceError";
  }
}

/**
 * Whether `error` is — or was caused by — a read-only refusal. The one test a
 * caller needs: a viewer's write reaches it wrapped by drizzle or by the command
 * host, never as the bare instance.
 */
export function isReadOnlyWorkspaceError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    if (current instanceof ReadOnlyWorkspaceError) return true;
    if ((current as { code?: unknown }).code === READ_ONLY_WORKSPACE_CODE) return true;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Pragmas that only report state when read without an argument. */
const READ_ONLY_PRAGMAS = new Set([
  "application_id",
  "data_version",
  "foreign_keys",
  "freelist_count",
  "journal_mode",
  "page_count",
  "page_size",
  "schema_version",
  "user_version",
]);

const PRAGMA_READ = /^PRAGMA\s+(?:[A-Za-z_]\w*\s*\.\s*)?([A-Za-z_]\w*)$/i;

/**
 * Bind-variable sigils. SQLite's tokenizer lets a variable carry a Tcl-style
 * `(...)` suffix (`$a(';)`) that swallows a quote this scanner would read as
 * opening a literal — hiding a second statement behind it. Drizzle binds with
 * `?`, so no store read uses them: one outside a literal fails closed.
 */
const VARIABLE_SIGILS = new Set(["$", ":", "@", "#"]);

/**
 * The index just past the comment starting at `index`, or null when no comment
 * starts there. An unterminated comment runs to the end of the text, as in SQLite.
 */
function skipComment(sql: string, index: number): number | null {
  if (sql.startsWith("--", index)) {
    const close = sql.indexOf("\n", index + 2);
    return close === -1 ? sql.length : close + 1;
  }
  if (sql.startsWith("/*", index)) {
    const close = sql.indexOf("*/", index + 2);
    return close === -1 ? sql.length : close + 2;
  }
  return null;
}

/** Whether `sql` from `index` on is nothing but whitespace and comments. */
function onlyTrivia(sql: string, index: number): boolean {
  let cursor = index;
  while (cursor < sql.length) {
    if (/\s/.test(sql[cursor] ?? "")) {
      cursor += 1;
      continue;
    }
    const afterComment = skipComment(sql, cursor);
    if (afterComment === null) return false;
    cursor = afterComment;
  }
  return true;
}

/**
 * The first statement of `sql` (up to its first top-level `;`), or null when
 * anything but whitespace and comments follows that `;`, or when a bind-variable
 * sigil appears outside a literal. Quoted strings and identifiers and comments
 * are skipped, so a `;` inside them does not end the statement.
 */
function singleStatement(sql: string): string | null {
  let index = 0;
  while (index < sql.length) {
    const char = sql[index] ?? "";
    if (char === "'" || char === '"' || char === "`") {
      const close = sql.indexOf(char, index + 1);
      if (close === -1) return sql;
      index = close + 1;
      continue;
    }
    if (char === "[") {
      const close = sql.indexOf("]", index + 1);
      if (close === -1) return sql;
      index = close + 1;
      continue;
    }
    const afterComment = skipComment(sql, index);
    if (afterComment !== null) {
      index = afterComment;
      continue;
    }
    if (VARIABLE_SIGILS.has(char)) return null;
    if (char === ";") {
      return onlyTrivia(sql, index + 1) ? sql.slice(0, index) : null;
    }
    index += 1;
  }
  return sql;
}

/** True when `sql` is exactly one statement that only reads. */
export function isReadOnlyStatement(sql: string): boolean {
  const statement = singleStatement(sql)?.trim();
  if (!statement) return false;
  if (/^SELECT\b/i.test(statement)) return true;
  const pragma = PRAGMA_READ.exec(statement);
  return pragma?.[1] !== undefined && READ_ONLY_PRAGMAS.has(pragma[1].toLowerCase());
}

type BatchItem = InStatement | [string, InArgs?];

function statementSql(statement: BatchItem): string {
  if (typeof statement === "string") return statement;
  if (Array.isArray(statement)) return statement[0];
  return statement.sql;
}

/** The leading keyword, for the refusal message — never the args or the body. */
function leadingKeyword(sql: string): string {
  return /^\s*([A-Za-z]{1,20})/.exec(sql)?.[1]?.toUpperCase() ?? "statement";
}

function assertReads(statements: readonly BatchItem[]): void {
  for (const statement of statements) {
    const sql = statementSql(statement);
    if (!isReadOnlyStatement(sql)) {
      throw new ReadOnlyWorkspaceError(leadingKeyword(sql));
    }
  }
}

function readOnlyTransaction(tx: Transaction): Transaction {
  return {
    execute: async (statement: InStatement) => {
      assertReads([statement]);
      return tx.execute(statement);
    },
    batch: async (statements: InStatement[]) => {
      assertReads(statements);
      return tx.batch(statements);
    },
    executeMultiple: async () => {
      throw new ReadOnlyWorkspaceError("executeMultiple");
    },
    rollback: () => tx.rollback(),
    commit: () => tx.commit(),
    close: () => tx.close(),
    get closed() {
      return tx.closed;
    },
  };
}

/**
 * Wrap `client` so only reads reach it. The returned object never exposes the
 * raw client: the store built over it has no path to a write.
 */
export function readOnlyClient(client: Client): Client {
  function execute(statement: InStatement): Promise<ResultSet>;
  function execute(sql: string, args?: InArgs): Promise<ResultSet>;
  async function execute(statement: InStatement, args?: InArgs): Promise<ResultSet> {
    assertReads([statement]);
    return typeof statement === "string" && args !== undefined
      ? client.execute(statement, args)
      : client.execute(statement);
  }

  function transaction(mode?: TransactionMode): Promise<Transaction>;
  function transaction(): Promise<Transaction>;
  async function transaction(mode?: TransactionMode): Promise<Transaction> {
    // libSQL's own default is "write": only an explicit read is a read.
    if (mode !== "read") {
      throw new ReadOnlyWorkspaceError(`${mode ?? "write"} transaction`);
    }
    return readOnlyTransaction(await client.transaction("read"));
  }

  return {
    execute,
    batch: async (statements: BatchItem[], mode?: TransactionMode) => {
      if (mode === "write") throw new ReadOnlyWorkspaceError("write batch");
      assertReads(statements);
      return mode === undefined
        ? client.batch(statements)
        : client.batch(statements, mode);
    },
    migrate: async () => {
      throw new ReadOnlyWorkspaceError("migrate");
    },
    transaction,
    executeMultiple: async () => {
      throw new ReadOnlyWorkspaceError("executeMultiple");
    },
    sync: async () => {
      throw new ReadOnlyWorkspaceError("sync");
    },
    close: () => client.close(),
    reconnect: () => client.reconnect(),
    get closed() {
      return client.closed;
    },
    get protocol() {
      return client.protocol;
    },
  };
}
