import { WalletView } from '@/components/WalletView';

// Officers have no Fund button: they pay nothing (UX Gap Analysis §9).
export default function Page() {
  return (
    <WalletView
      base="/officer/wallet"
      back={false}
      canFund={false}
      tabs={[
        ['all', 'All'],
        ['rewards', 'Rewards'],
        ['bounties', 'Bounties'],
        ['withdrawals', 'Withdrawals'],
      ]}
    />
  );
}
