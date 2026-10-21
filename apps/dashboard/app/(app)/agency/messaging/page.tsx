'use client';
// Board "Agency messaging CRM": the agency's staff, and citizens living in its stations' areas.
import { WithAgency } from '@/components/Agency';
import { CrmBoard } from '@/components/Crm';

export default function AgencyMessaging() {
  return <WithAgency>{(a) => <CrmBoard key={a.id} apiBase={`/agencies/${a.id}/crm`} detailBase="/agency/messaging" agencyName={a.name} />}</WithAgency>;
}
