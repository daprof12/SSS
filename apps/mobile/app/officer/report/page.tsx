import Link from 'next/link';
import { Header } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';

/** Officer "Report" (Rewards doc): a tip that can earn a bounty, a public issue, or a field report. */
export default function OfficerReport() {
  return (
    <main className="app">
      <Header title="Report" back={false} />
      <div className="list">
        <Link href="/officer/tips/new" className="row">
          <span className="icon">
            <Icon name="tip" />
          </span>
          <span className="grow">
            <strong>Report a tip</strong>
            <span className="sub">Crime or hazard for another agency. Tips on your own agency's cases earn no bounty.</span>
          </span>
          <Icon name="chevron" size={18} />
        </Link>
        <Link href="/officer/issues/new" className="row">
          <span className="icon">
            <Icon name="road" />
          </span>
          <span className="grow">
            <strong>Report a public issue</strong>
            <span className="sub">Bad road, broken light, waste seen on patrol</span>
          </span>
          <Icon name="chevron" size={18} />
        </Link>
        <div className="row soon" aria-disabled="true">
          <span className="icon">
            <Icon name="flag" />
          </span>
          <span className="grow">
            <strong>Incident report from the field</strong>
            <span className="sub">Coming next</span>
          </span>
          <span className="chip neutral">Soon</span>
        </div>
      </div>
      <p className="section-label">Yours</p>
      <div className="list">
        <Link href="/officer/tips" className="row">
          <span className="grow">
            <strong>My tips and bounties</strong>
          </span>
          <Icon name="chevron" size={18} />
        </Link>
        <Link href="/officer/issues" className="row">
          <span className="grow">
            <strong>My public issues</strong>
          </span>
          <Icon name="chevron" size={18} />
        </Link>
      </div>
    </main>
  );
}
