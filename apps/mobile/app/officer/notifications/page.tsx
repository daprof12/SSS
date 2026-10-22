import { AlertsCard } from '@/components/AlertsCard';
import { NotificationCentre } from '@/components/NotificationCentre';

export default function Page() {
  return <NotificationCentre back="/officer" top={<AlertsCard />} />;
}
