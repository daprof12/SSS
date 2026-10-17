import { AppFrame } from '@/components/AppFrame';

export default function CitizenLayout({ children }: { children: React.ReactNode }) {
  return <AppFrame surface="citizen">{children}</AppFrame>;
}
