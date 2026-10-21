'use client';
// Agency campaign results.
import { useParams } from 'next/navigation';
import { WithAgency } from '@/components/Agency';
import { CampaignResults } from '@/components/CampaignResults';

export default function AgencyCampaign() {
  const { id } = useParams<{ id: string }>();
  return <WithAgency>{(a) => <CampaignResults id={id} apiBase={`/agencies/${a.id}/crm`} backHref="/agency/messaging" />}</WithAgency>;
}
