'use client';
// Board "Admin messaging CRM".
import { CrmBoard } from '@/components/Crm';

export default function Crm() {
  return <CrmBoard apiBase="/admin/crm" detailBase="/admin/crm" />;
}
