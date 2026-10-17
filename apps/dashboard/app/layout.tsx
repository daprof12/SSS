import type { Metadata } from 'next';
import '@erp/tokens/tokens.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'ERP Dashboard',
  description: 'Emergency Response Platform — station, agency and platform dashboards',
};

// Applies the saved theme and motion choice before first paint, so there is no
// flash of the wrong theme. Mirrors lib/theme.ts.
const bootstrap = `(function(){try{var t=localStorage.getItem('erp-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t;var m=localStorage.getItem('erp-motion');if(m==='reduced')document.documentElement.dataset.motion='reduced';}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: bootstrap }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
