// Status chip — colour + word, never colour alone (Design Brief).
const TONE: Record<string, { tone: string; label: string }> = {
  pending_cancel: { tone: 'neutral', label: 'Sending' },
  received: { tone: 'info', label: 'Received' },
  offered: { tone: 'warning', label: 'Offered' },
  escalated: { tone: 'critical', label: 'Escalated' },
  accepted: { tone: 'info', label: 'Accepted' },
  en_route: { tone: 'info', label: 'En route' },
  reassigning: { tone: 'warning', label: 'Reassigning' },
  transferred: { tone: 'warning', label: 'Transferred' },
  on_scene: { tone: 'success', label: 'On scene' },
  closing: { tone: 'success', label: 'Closing' },
  resolved: { tone: 'success', label: 'Resolved' },
  unfounded: { tone: 'neutral', label: 'Unfounded' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
  merged: { tone: 'neutral', label: 'Merged' },
};

export function StateChip({ state }: { state: string }) {
  const t = TONE[state] ?? { tone: 'neutral', label: state };
  return <span className={`chip ${t.tone}`}>{t.label}</span>;
}
