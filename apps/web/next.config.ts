import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  transpilePackages: [
    "@worthline/contracts",
    "@worthline/db",
    "@worthline/domain",
    "@worthline/pricing",
  ],
};

export default nextConfig;
