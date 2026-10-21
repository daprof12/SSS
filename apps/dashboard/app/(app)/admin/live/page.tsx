'use client';
// Board "Admin live incident map": every open report across all agencies, by type and place.
import { LiveReports } from '@/components/LiveReports';

export default function LiveMap() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Live incident map</h1>
          <p className="lede">Every open emergency, report tip and public issue, across all agencies. Refreshes every 5 seconds.</p>
        </div>
      </div>
      <LiveReports path="/admin/live" kinds={['emergency', 'tip', 'issue']} />
    </>
  );
}
