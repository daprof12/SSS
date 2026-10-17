import { IssuesList } from '@/components/reports/Issues';

export default function Page() {
  return <IssuesList base="/issues" back="/profile" />;
}
