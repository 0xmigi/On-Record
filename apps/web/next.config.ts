import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // the og share card reads its fonts off disk at runtime — trace them into
  // the deployed function (path resolution isn't statically analyzable)
  outputFileTracingIncludes: {
    "/p/[id]/opengraph-image": ["./assets/og/*.ttf"],
  },
};

export default nextConfig;
