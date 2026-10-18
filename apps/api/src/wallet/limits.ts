import { naira, type WalletLimits } from '@erp/domain';

// Placeholders until pricing is settled — held as config, not code (PRD).
export const WALLET_LIMITS: WalletLimits = {
  minFund: naira(100),
  maxFundPerTxn: naira(500_000),
  minWithdraw: naira(1_000),
  dailyWithdrawLimit: naira(200_000),
};
