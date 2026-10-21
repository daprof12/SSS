'use client';
// Board "Admin campaign results".
import { useParams } from 'next/navigation';
import { CampaignResults } from '@/components/CampaignResults';

export default function AdminCampaign() {
  const { id } = useParams<{ id: string }>();
  return <CampaignResults id={id} apiBase="/admin/crm" backHref="/admin/crm" />;
}
