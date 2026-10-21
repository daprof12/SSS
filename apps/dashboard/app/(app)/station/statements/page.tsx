'use client';
// Station "Statements": every statement on the station's reports. Ask for one from any report.
import { StatementsList } from '@/components/StatementsList';

export default function StationStatements() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Statements</h1>
          <p className="lede">From complainants, victims, witnesses, suspects and officers on your reports. Open a report to ask for one.</p>
        </div>
      </div>
      <StatementsList path="/me/station/statements" />
    </>
  );
}
