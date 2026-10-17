'use client';

import { useEffect, useId, useRef } from 'react';

interface Props {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  /** While true, the sheet cannot be dismissed (a request is in flight). */
  busy?: boolean;
  children: React.ReactNode;
  footer: React.ReactNode;
}

const FOCUSABLE = 'a[href], button:not([disabled]), select:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * One modal pattern for every confirmation (UX Gap Analysis §4): bottom sheet
 * under 768 px, centred dialog above; focus trapped; Esc and scrim close it
 * unless busy; focus returns to whatever opened it. Never stacks.
 */
export function Sheet({ open, title, description, onClose, busy, children, footer }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    const first = panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.preventDefault();
        onClose();
      }
      if (e.key !== 'Tab' || !panel.current) return;
      const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!items.length) return;
      const firstEl = items[0]!;
      const lastEl = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      (opener.current as HTMLElement | null)?.focus?.();
    };
  }, [open, busy, onClose]);

  if (!open) return null;
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div ref={panel} className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descId : undefined}>
        <div className="sheet-grip" aria-hidden />
        <h2 id={titleId}>{title}</h2>
        {description && (
          <p id={descId} className="sheet-desc">
            {description}
          </p>
        )}
        <div className="sheet-body">{children}</div>
        <div className="sheet-footer">{footer}</div>
      </div>
    </div>
  );
}
