import { WalletView } from '@/components/WalletView';

export default function Page() {
  return (
    <WalletView
      base="/wallet"
      back="/profile"
      canFund
      tabs={[
        ['all', 'All'],
        ['money_in', 'Money in'],
        ['money_out', 'Money out'],
      ]}
    />
  );
}
