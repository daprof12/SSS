import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @type {(phase: string) => import('next').NextConfig} */
export default function config(phase) {
  return {
    reactStrictMode: true,
    // Container images: a self-contained server with only the files it needs (deploy/docker).
    ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone', outputFileTracingRoot: root } : {}),
    transpilePackages: ['@erp/web-ui'],
    poweredByHeader: false,
    // `next dev` and `next build` get separate output folders, so running a build
    // while the dev server is up can't corrupt the dev cache ("Cannot find module './976.js'").
    // A second dev server on another port (two sessions at once) gets its own folder too.
    distDir: phase !== PHASE_DEVELOPMENT_SERVER ? '.next' : process.env.PORT ? `.next-dev-${process.env.PORT}` : '.next-dev',
    async headers() {
      return [
        {
          source: '/:path*',
          headers: [
            { key: 'X-Frame-Options', value: 'DENY' },
            { key: 'X-Content-Type-Options', value: 'nosniff' },
            { key: 'Referrer-Policy', value: 'no-referrer' },
            { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' },
          ],
        },
      ];
    },
  };
}
