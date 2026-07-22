import {
  type BenchmarkPriceCache,
  createControlPlaneStore,
  type ExposureProfileCatalog,
} from "@worthline/db";
import type { ReferenceDataReaders } from "@worthline/domain";

/** The two catalog/benchmark readers a reference session needs, plus its lifecycle. */
type ReferenceControlPlane = Pick<ExposureProfileCatalog, "readGlobalExposureProfiles"> &
  Pick<BenchmarkPriceCache, "readBenchmarkPrices"> & { close(): void };

import { after } from "next/server";
import { cache } from "react";
import { readStoreTarget } from "./read-store-target";
import {
  createControlPlaneReferenceDataReaders,
  createFixedBenchmarkSeriesReader,
  createFixedExposureCatalogReader,
  createUnavailableReferenceDataReaders,
} from "./reference-data-readers";
import type { StoreTarget } from "./store-resolver";

export interface ReferenceSession extends ReferenceDataReaders {
  close(): void;
}

const DEMO_EXPOSURE_CATALOG = {
  status: "available" as const,
  profiles: [] as const,
};

async function openControlPlaneStoreFromEnv(): Promise<ReferenceControlPlane> {
  const url = process.env.WORTHLINE_CONTROL_PLANE_DB_URL;
  if (!url) {
    throw new Error("WORTHLINE_CONTROL_PLANE_DB_URL is not configured.");
  }
  return createControlPlaneStore({
    url,
    ...(process.env.WORTHLINE_DB_AUTH_TOKEN
      ? { authToken: process.env.WORTHLINE_DB_AUTH_TOKEN }
      : {}),
  });
}

export function createReferenceSessionForTarget(
  target: StoreTarget,
  deps?: {
    openControlPlane?: () => Promise<ReferenceControlPlane>;
  },
): Promise<ReferenceSession> {
  if (target.kind === "demo") {
    return Promise.resolve({
      exposureCatalogReader: createFixedExposureCatalogReader(DEMO_EXPOSURE_CATALOG),
      benchmarkSeriesReader: createFixedBenchmarkSeriesReader(async () => ({
        status: "available",
        prices: [],
      })),
      close: () => {},
    });
  }

  if (!process.env.WORTHLINE_CONTROL_PLANE_DB_URL) {
    const readers = createUnavailableReferenceDataReaders("not_configured");
    return Promise.resolve({
      ...readers,
      close: () => {},
    });
  }

  const open = deps?.openControlPlane ?? openControlPlaneStoreFromEnv;
  return open().then((store) => {
    const readers = createControlPlaneReferenceDataReaders(store);
    return {
      ...readers,
      close: () => {
        store.close();
      },
    };
  });
}

/** One control-plane reference session per RSC request; closed after the response. */
export const getReferenceSession = cache(async (): Promise<ReferenceSession> => {
  const target = await readStoreTarget();
  const session = await createReferenceSessionForTarget(target);
  after(() => {
    session.close();
  });
  return session;
});
