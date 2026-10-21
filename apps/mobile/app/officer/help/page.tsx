'use client';
// Help for officers: the short answers needed on shift, and who to call.
import { openHelpChat } from '@erp/web-ui/HelpChat';
import { Header } from '@/components/AppFrame';

const QA: [string, string][] = [
  ['I did not get an offer in time', 'Offers wait 25 seconds, then go to the next officer. Stay on duty with location on, and keep the app open or in the background.'],
  ['The address is wrong', 'Check the reporter’s notes and photos on the incident, then file a field report with the right building. Protected calling to the reporter is coming.'],
  ['I need more officers', 'Open the incident and tap Reinforce. Your station head and nearby units are alerted.'],
  ['I am in danger', 'Press and hold the panic button on the incident screen. Your station and nearby units get your live location.'],
  ['A citizen rated me unfairly', 'Ratings with abuse or threats are removed. Ask your station head to review it from the station dashboard.'],
  ['Rewards and bank account', 'Rewards from ratings and donations land in your wallet. Your bank account must be in your verified name to withdraw.'],
];

export default function Help() {
  return (
    <main className="app">
      <Header title="Help" back="/officer/profile" />
      <button className="btn primary" type="button" style={{ width: '100%', margin: '0 0 12px' }} onClick={openHelpChat}>
        Chat with us now
      </button>
      <div className="list">
        {QA.map(([q, a]) => (
          <details key={q} className="help-item">
            <summary>{q}</summary>
            <p>{a}</p>
          </details>
        ))}
      </div>
      <p className="section-label">Contact</p>
      <div className="list">
        <a className="row" href="tel:112">
          <span className="grow">
            <strong>Emergency, 112</strong>
            <span className="sub">If the app is not working and someone is in danger</span>
          </span>
        </a>
        <a className="row" href="mailto:support@erp.ng?subject=Officer%20app%20help">
          <span className="grow">
            <strong>Platform support</strong>
            <span className="sub">App problems, sign-in, wallet</span>
          </span>
        </a>
      </div>
    </main>
  );
}
