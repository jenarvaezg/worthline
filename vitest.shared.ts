import { fileURLToPath } from "node:url";

const zone = (dir: string) => fileURLToPath(new URL(dir, import.meta.url));

export const sharedVitestConfig = {
  oxc: { jsx: { runtime: "automatic" as const } },
  resolve: {
    alias: [
      { find: /^@web\//, replacement: `${zone("apps/web/app")}/` },
      { find: /^@domain\//, replacement: `${zone("packages/domain/src")}/` },
      { find: /^@db\//, replacement: `${zone("packages/db/src")}/` },
      { find: /^@pricing\//, replacement: `${zone("packages/pricing/src")}/` },
      { find: /^@tests\//, replacement: `${zone("tests")}/` },
      { find: /^@e2e\//, replacement: `${zone("e2e")}/` },
      { find: /^@scripts\//, replacement: `${zone("scripts")}/` },
    ],
  },
  test: { environment: "node" as const },
};
