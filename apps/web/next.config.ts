import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [{
      source: "/p/:path*",
      headers: [
        { key: "Cache-Control", value: "no-store" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Robots-Tag", value: "noindex" },
      ],
    }];
  },
  // Next dev logs literal request URLs by default; bearer links must stay out.
  logging: { incomingRequests: { ignore: [/^\/(?:g|p)\//, /^\/api\/(?:groups|picks)\//] } },
  // PGlite ships WASM; let Node load it directly instead of bundling.
  serverExternalPackages: ["@electric-sql/pglite", "pglite-prisma-adapter"],
  outputFileTracingIncludes: {
    "/api/receipts/*/parse": [
      "../../pnpm-workspace.yaml", "../../packages/services/src/ocr-worker.cjs",
      "../../packages/services/node_modules/tesseract.js/**/*",
      "../../node_modules/.pnpm/tesseract.js*/**/*",
      "../../node_modules/.pnpm/tesseract.js-core*/**/*",
    ],
  },
};

export default nextConfig;
