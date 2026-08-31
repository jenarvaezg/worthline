import {
  type ControlPlaneTarget,
  controlPlaneTargetFromEnv,
  withControlPlaneStore,
} from "@web/control-plane-store";
import type { ProviderCooldown, UsageLimits } from "@worthline/db";

export type ProviderCooldownRead =
  | { mode: "local" }
  | { mode: "hosted"; deploymentKey: string; cooldowns: ProviderCooldown[] };

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

/**
 * The shared opener (#1694) plus this store's own deadline: the cooldown read
 * sits in front of every chat turn, so a slow control plane must lose the race
 * rather than hold the turn. The timeout wraps open AND run — the whole task,
 * exactly as before the helper existed.
 */
async function runWithControlPlane<T>(
  target: ControlPlaneTarget,
  operation: "read" | "write",
  run: (
    store: Pick<UsageLimits, "readProviderCooldowns" | "recordProviderCooldown">,
  ) => Promise<T>,
): Promise<T> {
  const task = withControlPlaneStore<
    T,
    Pick<UsageLimits, "readProviderCooldowns" | "recordProviderCooldown">
  >(run, { target });
  return withProviderCooldownTimeout(operation, task);
}

export async function readProviderCooldowns(): Promise<ProviderCooldownRead> {
  const target = controlPlaneTargetFromEnv();
  if (!target) return { mode: "local" };
  const deploymentKey = providerCooldownDeploymentKey();
  return runWithControlPlane(target, "read", async (controlPlane) => {
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
  const target = controlPlaneTargetFromEnv();
  if (!target) return false;
  const deploymentKey = providerCooldownDeploymentKey();
  return runWithControlPlane(target, "write", async (controlPlane) => {
    await controlPlane.recordProviderCooldown(
      deploymentKey,
      provider,
      cooldownUntil.toISOString(),
    );
    return true;
  });
}
