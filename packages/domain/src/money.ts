// Money is integer kobo everywhere. A balance is the sum of ledger entries;
// entries are append-only and come only from webhooks or approved transfers.

export type Kobo = number & { readonly __brand: 'kobo' };

export function kobo(n: number): Kobo {
  if (!Number.isSafeInteger(n)) throw new Error(`Amount must be whole kobo, got ${n}`);
  return n as Kobo;
}

export const naira = (n: number): Kobo => kobo(Math.round(n * 100));

export function formatNaira(k: Kobo | number, opts: { sign?: boolean } = {}): string {
  const v = Number(k) / 100;
  const s = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', minimumFractionDigits: 2 }).format(Math.abs(v));
  if (!opts.sign) return v < 0 ? `-${s}` : s;
  return `${v < 0 ? '-' : '+'}${s}`;
}

export const ledgerEntryTypes = ['fund', 'bounty', 'reward', 'donation_in', 'donation_out', 'withdrawal', 'withdrawal_reversal', 'payment', 'fine', 'refund'] as const;
export type LedgerEntryType = (typeof ledgerEntryTypes)[number];

export interface WalletLimits {
  minFund: Kobo;
  maxFundPerTxn: Kobo;
  minWithdraw: Kobo;
  dailyWithdrawLimit: Kobo;
}

export type WithdrawCheck =
  | { ok: true }
  | { ok: false; field: 'amount' | 'bank'; message: string };

/** Final copy from States and Notifications (1). */
export function checkWithdrawal(input: {
  amount: Kobo;
  available: Kobo;
  withdrawnToday: Kobo;
  limits: WalletLimits;
  bank?: { nameMatches: boolean };
}): WithdrawCheck {
  const { amount, available, withdrawnToday, limits, bank } = input;
  if (amount < limits.minWithdraw) return { ok: false, field: 'amount', message: `Minimum withdrawal is ${formatNaira(limits.minWithdraw)}.` };
  if (amount > available) return { ok: false, field: 'amount', message: 'You do not have that much available.' };
  const left = limits.dailyWithdrawLimit - withdrawnToday;
  if (amount > left) return { ok: false, field: 'amount', message: `You can withdraw up to ${formatNaira(Math.max(0, left))} today.` };
  if (!bank) return { ok: false, field: 'bank', message: 'Add a bank account in your name first.' };
  if (!bank.nameMatches) return { ok: false, field: 'bank', message: 'This account name does not match your verified name.' };
  return { ok: true };
}

export function checkFund(amount: Kobo, limits: WalletLimits): WithdrawCheck {
  if (amount < limits.minFund) return { ok: false, field: 'amount', message: `Enter an amount of at least ${formatNaira(limits.minFund)}.` };
  if (amount > limits.maxFundPerTxn) return { ok: false, field: 'amount', message: `The most you can add at once is ${formatNaira(limits.maxFundPerTxn)}.` };
  return { ok: true };
}

export type DeleteBlocker = 'wallet_balance' | 'open_fines' | 'pending_withdrawal' | 'active_subscription';

/** Decided 2026-10-17: account deletion is blocked until settled. */
export function accountDeletionBlockers(s: {
  walletBalance: Kobo;
  heldBalance: Kobo;
  openFines: number;
  pendingWithdrawals: number;
  activeSubscription: boolean;
}): DeleteBlocker[] {
  const out: DeleteBlocker[] = [];
  if (s.walletBalance + s.heldBalance !== 0) out.push('wallet_balance');
  if (s.openFines > 0) out.push('open_fines');
  if (s.pendingWithdrawals > 0) out.push('pending_withdrawal');
  if (s.activeSubscription) out.push('active_subscription');
  return out;
}
