import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Electron desktop shell (electron/main.js + ELECTRON.md) runs the standalone
  // server bundle in production. `next start` and Vercel deploys keep working.
  output: "standalone",

  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'naxzbbfqyhrlpzaogljk.supabase.co',
        pathname: '/storage/v1/object/public/**',
      },
    ],
  },
};

module.exports = nextConfig;

