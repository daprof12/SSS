'use client';
// An agency's live map: only the reports routed to it, and only the kinds it handles (a fire service
// sees emergencies; an anti-trafficking agency also sees tips; a roads agency sees public issues).
import { AgencySwitcher, WithAgency } from '@/components/Agency';
import { LiveReports } from '@/components/LiveReports';

export default function AgencyLive() {
  return (
    <WithAgency>
      {(a) => (
        <>
          <div className="page-head">
            <div>
              <h1>Live map</h1>
              <p className="lede">Open reports routed to {a.name}, with your units on duty.</p>
            </div>
            <AgencySwitcher />
          </div>
          <LiveReports key={a.id} path={`/agencies/${a.id}/live`} kinds={['emergency', ...(a.handles.tips ? (['tip'] as const) : []), ...(a.handles.issues ? (['issue'] as const) : [])]} />
        </>
      )}
    </WithAgency>
  );
}
