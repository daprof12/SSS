import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js';

/** @type {(phase: string) => import('next').NextConfig} */
export default function config(phase) {
  return {
    reactStrictMode: true,
    transpilePackages: ['@erp/web-ui'],
    poweredByHeader: false,
    // `next dev` and `next build` get separate output folders, so running a build
    // while the dev server is up can't corrupt the dev cache ("Cannot find module './976.js'").
    distDir: phase === PHASE_DEVELOPMENT_SERVER ? '.next-dev' : '.next',
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
