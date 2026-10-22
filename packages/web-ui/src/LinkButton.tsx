'use client';
// A button that goes somewhere. Used wherever a "link" sits with other buttons, so it lines up and
// behaves exactly like them. App pages open in place; phone numbers, SMS and files open as usual;
// Ctrl/⌘-click opens a new tab.
import { useRouter } from 'next/navigation';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function LinkButton({
  href,
  newTab,
  className = 'btn',
  children,
  onClick,
  ...rest
}: { href?: string; newTab?: boolean; children: ReactNode } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'>) {
  const router = useRouter();
  const inApp = !!href && href.startsWith('/') && !newTab;
  return (
    <button
      type="button"
      className={className}
      disabled={!href || rest.disabled}
      onMouseEnter={() => inApp && router.prefetch(href!)}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || !href) return;
        if (newTab || e.metaKey || e.ctrlKey) return void window.open(href, '_blank', 'noopener');
        if (href.startsWith('#')) {
          window.location.hash = href;
          document.getElementById(href.slice(1))?.scrollIntoView({ behavior: 'smooth' });
        } else if (href.startsWith('/')) router.push(href);
        else window.location.assign(href);
      }}
      {...rest}
    >
      {children}
    </button>
  );
}
