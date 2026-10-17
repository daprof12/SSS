import type { Metadata, Viewport } from 'next';
import '@erp/tokens/tokens.css';
import './globals.css';
import { Pwa } from '@/components/Pwa';

export const metadata: Metadata = {
  title: 'ERP',
  description: 'Report an emergency in two taps and follow help to your door.',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon.svg', apple: '/icon.svg' },
  appleWebApp: { capable: true, title: 'ERP', statusBarStyle: 'black-translucent' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#000000' },
    { media: '(prefers-color-scheme: light)', color: '#FFFFFF' },
  ],
};

// Saved theme and motion before first paint (mirrors @erp/web-ui/theme).
const bootstrap = `(function(){try{var t=localStorage.getItem('erp-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t;var m=localStorage.getItem('erp-motion');if(m==='reduced')document.documentElement.dataset.motion='reduced';}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: bootstrap }} />
      </head>
      <body>
        <Pwa />
        {children}
      </body>
    </html>
  );
}
