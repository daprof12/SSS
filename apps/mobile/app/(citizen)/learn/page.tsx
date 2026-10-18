import { Suspense } from 'react';
import { Learn } from '@/components/learn/Learn';

export default function Page() {
  return (
    <Suspense>
      <Learn />
    </Suspense>
  );
}
