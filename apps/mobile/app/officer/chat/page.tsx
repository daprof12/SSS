'use client';
// Help chat for officers as a page of its own, opened from the message icon in the header.
import { HelpChat } from '@erp/web-ui/HelpChat';
import { Header, OFFICER_QUESTIONS } from '@/components/AppFrame';

export default function Chat() {
  return (
    <main className="app chat-page">
      <Header title="Help chat" back />
      <HelpChat page suggestions={OFFICER_QUESTIONS} />
    </main>
  );
}
