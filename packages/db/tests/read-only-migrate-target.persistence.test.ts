/**
 * What a viewer's open costs at the schema gate (#1842, PRD #1718).
 *
 * A read-only open reads the version and nothing else: one `SELECT` against
 * `schema_meta` the first time a process meets a base at version, and zero
 * after that (the same `migratedTargets` memo an owner's open fills). A base
 * behind is never memoized, so the retry after the system's maintenance open
 * finds it warm and costs nothing more.
 */

import {
  __resetMigratedTargetsForTests,
  migrateTarget,
  WorkspaceSchemaBehindError,
} from "@db/database-target";
import { openLibsqlClient } from "@db/libsql-client";
import { migrate, SCHEMA_VERSION, writeSchemaVersion } from "@db/migrate";
import { readOnlyClient } from "@db/read-only-client";
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { instrumentClient } from "./instrument-libsql-client";

const VERSION_READ = "SELECT version FROM schema_meta LIMIT 1";

/** A migrated in-memory base, as the owner left it. */
async function baseAtVersion(): Promise<Client> {
  const client = openLibsqlClient(":memory:");
  await migrate(client);
  return client;
}

/** The viewer's client over `raw`, counting every statement that reaches it. */
function viewerClient(raw: Client): { client: Client; statements: string[] } {
  const statements: string[] = [];
  const counted = instrumentClient(raw, (sql) => statements.push(sql));
  return { client: readOnlyClient(counted), statements };
}

const target = (name: string) =>
  ({ kind: "url", url: `libsql://viewer-${name}.turso.io` }) as const;

beforeEach(() => __resetMigratedTargetsForTests());
afterEach(() => __resetMigratedTargetsForTests());

describe("migrateTarget · readOnly", () => {
  test("a base at version costs one version SELECT per process and URL, then zero", async () => {
    const first = viewerClient(await baseAtVersion());
    await migrateTarget(target("warm"), first.client, { readOnly: true });
    expect(first.statements).toEqual([VERSION_READ]);
    first.client.close();

    const second = viewerClient(await baseAtVersion());
    await migrateTarget(target("warm"), second.client, { readOnly: true });
    expect(second.statements).toEqual([]);
    second.client.close();
  });

  test("a base behind: one version read, refused, never memoized; the retry after maintenance is free", async () => {
    const raw = await baseAtVersion();
    await writeSchemaVersion(raw, SCHEMA_VERSION - 1);
    const viewer = viewerClient(raw);

    await expect(
      migrateTarget(target("behind"), viewer.client, { readOnly: true }),
    ).rejects.toBeInstanceOf(WorkspaceSchemaBehindError);
    expect(viewer.statements).toEqual([VERSION_READ]);

    // Not memoized: a second read-only attempt reads the version again.
    await expect(
      migrateTarget(target("behind"), viewer.client, { readOnly: true }),
    ).rejects.toBeInstanceOf(WorkspaceSchemaBehindError);
    expect(viewer.statements).toEqual([VERSION_READ, VERSION_READ]);

    // The system's full-access open brings the base up and memoizes it…
    await migrateTarget(target("behind"), raw);

    // …so the single read-only retry passes without touching the base.
    viewer.statements.length = 0;
    await migrateTarget(target("behind"), viewer.client, { readOnly: true });
    expect(viewer.statements).toEqual([]);
    raw.close();
  });
});
