import {
  type ControlPlaneStore,
  createControlPlaneStore,
  type ProviderCooldown,
} from "@worthline/db";

export type ProviderCooldownRead =
  | { mode: "local" }
  | { mode: "hosted"; deploymentKey: string; cooldowns: ProviderCooldown[] };

function controlPlaneConfig(): { url: string; authToken?: string } | null {
  const url = process.env["WORTHLINE_CONTROL_PLANE_DB_URL"]?.trim();
  if (!url) return null;
  const authToken = process.env["WORTHLINE_DB_AUTH_TOKEN"]?.trim();
  return { url, ...(authToken ? { authToken } : {}) };
}

const CONTROL_PLANE_TIMEOUT_MS = 1_000;

export class ProviderCooldownStoreTimeoutError extends Error {
  constructor(operation: "read" | "write", timeoutMs: number) {
    super(`Provider cooldown ${operation} timed out after ${timeoutMs}ms.`);
    this.name = "ProviderCooldownStoreTimeoutError";
  }
}

export async function withProviderCooldownTimeout<T>(
  operation: "read" | "write",
  task: Promise<T>,
  timeoutMs: number = CONTROL_PLANE_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new ProviderCooldownStoreTimeoutError(operation, timeoutMs)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function providerCooldownDeploymentKey(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const key =
    env["WORTHLINE_CHAT_DEPLOYMENT_KEY"]?.trim() ||
    env["VERCEL_URL"]?.trim() ||
    env["VERCEL_ENV"]?.trim();
  if (!key) {
    throw new Error(
      "Provider cooldown persistence requires WORTHLINE_CHAT_DEPLOYMENT_KEY, VERCEL_URL, or VERCEL_ENV.",
    );
  }
  return key;
}

async function runWithControlPlane<T>(
  config: { url: string; authToken?: string },
  operation: "read" | "write",
  run: (store: ControlPlaneStore) => Promise<T>,
): Promise<T> {
  const task = (async () => {
    const controlPlane = await createControlPlaneStore(config);
    try {
      return await run(controlPlane);
    } finally {
      controlPlane.close();
    }
  })();
  return withProviderCooldownTimeout(operation, task);
}

export async function readProviderCooldowns(): Promise<ProviderCooldownRead> {
  const config = controlPlaneConfig();
  if (!config) return { mode: "local" };
  const deploymentKey = providerCooldownDeploymentKey();
  return runWithControlPlane(config, "read", async (controlPlane) => {
    return {
      mode: "hosted" as const,
      deploymentKey,
      cooldowns: await controlPlane.readProviderCooldowns(deploymentKey),
    };
  });
}

export async function recordProviderCooldown(
  provider: string,
  cooldownUntil: Date,
): Promise<boolean> {
  const config = controlPlaneConfig();
  if (!config) return false;
  const deploymentKey = providerCooldownDeploymentKey();
  return runWithControlPlane(config, "write", async (controlPlane) => {
    await controlPlane.recordProviderCooldown(
      deploymentKey,
      provider,
      cooldownUntil.toISOString(),
    );
    return true;
  });
}
