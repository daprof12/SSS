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
    poweredByHeader: false,
    transpilePackages: ['@erp/web-ui'],
    // Separate dev and build output so a build can't corrupt the running dev server.
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
            // Camera and microphone are for add-info photos and voice notes; location for reports and duty.
            { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=(self)' },
          ],
        },
        {
          // The service worker must never be served stale, or fixes never reach installed apps.
          source: '/sw.js',
          headers: [{ key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' }],
        },
      ];
    },
  };
}
