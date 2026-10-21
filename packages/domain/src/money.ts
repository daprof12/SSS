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

/**
 * Paystack's Nigerian transfer fee (Payout detail: "Gross, fees, net").
 * The recipient bears it: the bank receives gross − fee.
 */
export function transferFee(grossKobo: number): number {
  if (grossKobo <= 500_000) return 1_000; // ₦10 up to ₦5,000
  if (grossKobo <= 5_000_000) return 2_500; // ₦25 up to ₦50,000
  return 5_000; // ₦50 above
}

/** Banks and wallets people withdraw to, with Paystack bank codes. */
export const NIGERIAN_BANKS = [
  { code: '044', name: 'Access Bank' },
  { code: '023', name: 'Citibank' },
  { code: '050', name: 'Ecobank' },
  { code: '070', name: 'Fidelity Bank' },
  { code: '011', name: 'First Bank' },
  { code: '214', name: 'FCMB' },
  { code: '058', name: 'GTBank' },
  { code: '030', name: 'Heritage Bank' },
  { code: '082', name: 'Keystone Bank' },
  { code: '50211', name: 'Kuda' },
  { code: '50515', name: 'Moniepoint' },
  { code: '999992', name: 'OPay' },
  { code: '999991', name: 'PalmPay' },
  { code: '076', name: 'Polaris Bank' },
  { code: '221', name: 'Stanbic IBTC' },
  { code: '232', name: 'Sterling Bank' },
  { code: '033', name: 'UBA' },
  { code: '032', name: 'Union Bank' },
  { code: '215', name: 'Unity Bank' },
  { code: '035', name: 'Wema Bank' },
  { code: '057', name: 'Zenith Bank' },
] as const;
export const bankName = (code: string) => NIGERIAN_BANKS.find((b) => b.code === code)?.name ?? 'Bank';

/** NUBAN: 10 digits (States doc "Bank account: 10 digits, name must match the verified name"). */
export const isNuban = (n: string) => /^\d{10}$/.test(n);

/** Money-out rules (Rewards doc: "a delay on the first one"; States doc "arrives within [n] hours"). */
export const WITHDRAWAL_RULES = {
  /** The first withdrawal, or the first to a newly added account, waits this long before it is sent. */
  firstHoldHours: 24,
  arrivesWithinHours: 24,
  pinLength: 4,
  pinMaxTries: 5,
  pinLockMinutes: 30,
} as const;

/** A 4-digit PIN that is not trivially guessed. */
export function checkPin(pin: string): string | null {
  if (!new RegExp(`^\\d{${WITHDRAWAL_RULES.pinLength}}$`).test(pin)) return `Use ${WITHDRAWAL_RULES.pinLength} digits.`;
  if (/^(\d)\1+$/.test(pin)) return 'Avoid the same digit four times.';
  if ('0123456789'.includes(pin) || '9876543210'.includes(pin)) return 'Avoid digits in a row, like 1234.';
  return null;
}

/**
 * Rewards for rated responses (PRD "Ratings and rewards"; Rewards doc: split "between the
 * officers on it by the agency's rule"; "Bounties and rewards wait [n] days").
 * Paid from the platform rewards pool, once per incident, on its first rating.
 */
export interface RewardRule {
  /** Board "Reward for a 5-star response". */
  fiveStarKobo: number;
  /** A 4-star response earns this share of it; 3 stars or fewer earn nothing. */
  fourStarPct: number;
  /** equal: everyone the same. lead_first: the lead takes half, the rest share the other half. */
  split: 'equal' | 'lead_first';
}
export const REWARD_RULES = {
  holdDays: 7,
  /** PRD risk: "reward rules need audit and caps". */
  dailyCapPerOfficerKobo: 2_000_000, // ₦20,000
  maxFiveStarKobo: 2_500_000, // ₦25,000
  /** A reporter who rated this station's responses this often in 30 days earns them nothing more (rating rings). */
  repeatRaterLimit: 3,
} as const;
export const DEFAULT_REWARD_RULE: RewardRule = { fiveStarKobo: 500_000, fourStarPct: 50, split: 'lead_first' };

export function rewardFor(stars: number, rule: RewardRule): number {
  if (stars >= 5) return rule.fiveStarKobo;
  if (stars === 4) return Math.floor((rule.fiveStarKobo * rule.fourStarPct) / 100);
  return 0;
}

/** Splits a reward in whole kobo; any remainder goes to the lead (or the first officer). */
export function splitReward(totalKobo: number, officers: { id: string; lead: boolean }[], split: RewardRule['split']): { id: string; kobo: number }[] {
  if (!officers.length || totalKobo <= 0) return [];
  const leadIdx = Math.max(0, officers.findIndex((o) => o.lead));
  let shares: number[];
  if (split === 'lead_first' && officers.length > 1) {
    const leadPart = Math.floor(totalKobo / 2);
    const each = Math.floor((totalKobo - leadPart) / (officers.length - 1));
    shares = officers.map((_, i) => (i === leadIdx ? leadPart : each));
  } else {
    const each = Math.floor(totalKobo / officers.length);
    shares = officers.map(() => each);
  }
  shares[leadIdx]! += totalKobo - shares.reduce((a, b) => a + b, 0);
  return officers.map((o, i) => ({ id: o.id, kobo: shares[i]! }));
}

export function checkRewardRule(r: RewardRule): { field: keyof RewardRule; message: string } | null {
  if (!Number.isInteger(r.fiveStarKobo) || r.fiveStarKobo < 0 || r.fiveStarKobo > REWARD_RULES.maxFiveStarKobo) return { field: 'fiveStarKobo', message: `Enter up to ${formatNaira(REWARD_RULES.maxFiveStarKobo)} for a 5-star response.` };
  if (!Number.isInteger(r.fourStarPct) || r.fourStarPct < 0 || r.fourStarPct > 100) return { field: 'fourStarPct', message: 'Enter a share between 0% and 100%.' };
  return null;
}
