'use client';
// An agency's Learn feed: posts in the topics it handles, reviewed by the platform team before live.
import { AgencySwitcher, WithAgency } from '@/components/Agency';
import { LearnEditor } from '@/components/LearnEditor';

export default function AgencyLearn() {
  return (
    <WithAgency>
      {(a) => (
        <>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <AgencySwitcher />
          </div>
          <LearnEditor key={a.id} base={`/agencies/${a.id}/learn`} agency={a.name} />
        </>
      )}
    </WithAgency>
  );
}
