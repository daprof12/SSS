'use client';
// Agency "Statements": every statement on the agency's reports, across its stations.
import { WithAgency } from '@/components/Agency';
import { StatementsList } from '@/components/StatementsList';

export default function AgencyStatements() {
  return (
    <WithAgency>
      {(a) => (
        <>
          <div className="page-head">
            <div>
              <h1>Statements</h1>
              <p className="lede">Every statement on {a.name}&apos;s reports, from every station. Open a report to ask for one.</p>
            </div>
          </div>
          <StatementsList key={a.id} path={`/agencies/${a.id}/statements`} showStation />
        </>
      )}
    </WithAgency>
  );
}
