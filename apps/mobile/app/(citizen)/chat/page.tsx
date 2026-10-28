'use client';
// Help chat as a page of its own, opened from the message icon in the header (like notifications).
import { HelpChat } from '@erp/web-ui/HelpChat';
import { Header } from '@/components/AppFrame';

export default function Chat() {
  return (
    <main className="app chat-page">
      <Header title="Help chat" back />
      <HelpChat page />
    </main>
  );
}
