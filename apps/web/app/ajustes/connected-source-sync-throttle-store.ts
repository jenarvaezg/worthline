import { createControlPlaneStore, type UsageLimits } from "@worthline/db";

export async function countConnectedSourceSync(
  rateKey: string,
  windowKey: string,
): Promise<number | null> {
  const url = process.env["WORTHLINE_CONTROL_PLANE_DB_URL"];
  if (!url) {
    return null;
  }

  const authToken = process.env["WORTHLINE_DB_AUTH_TOKEN"];
  const controlPlane: Pick<UsageLimits, "recordConnectedSourceSync"> & {
    close(): void;
  } = await createControlPlaneStore({
    url,
    ...(authToken ? { authToken } : {}),
  });
  try {
    return await controlPlane.recordConnectedSourceSync(rateKey, windowKey);
  } finally {
    controlPlane.close();
  }
}
