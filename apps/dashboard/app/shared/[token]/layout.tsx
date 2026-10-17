import type { Metadata } from 'next';

// The token is the only key to this page: keep it out of search engines and
// out of the Referer header sent to any link on the page.
export const metadata: Metadata = {
  title: 'Shared issue brief · ERP',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function SharedLayout({ children }: { children: React.ReactNode }) {
  return children;
}
