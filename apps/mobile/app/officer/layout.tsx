import { AppFrame } from '@/components/AppFrame';

export default function OfficerLayout({ children }: { children: React.ReactNode }) {
  return <AppFrame surface="officer">{children}</AppFrame>;
}
