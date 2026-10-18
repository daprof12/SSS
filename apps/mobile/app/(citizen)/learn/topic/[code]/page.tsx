'use client';
import { use, useEffect, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { LearnRow, type LearnItem } from '@/components/learn/shared';
import { api } from '@/lib/client';

/** Every live lesson in one topic, newest first. */
export default function Topic({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const [topic, setTopic] = useState<{ label: string; icon: string; tone: string } | null>(null);
  const [items, setItems] = useState<LearnItem[] | null>(null);
  useEffect(() => {
    api<{ topics: { code: string; label: string; icon: string; tone: string }[] }>('/learn/topics')
      .then((r) => setTopic(r.topics.find((t) => t.code === code) ?? null))
      .catch(() => {});
    api<{ items: LearnItem[] }>(`/learn/browse?topics=${code}&sort=newest`)
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  }, [code]);
  return (
    <main className="app">
      <Header title={topic?.label ?? 'Topic'} back="/learn?tab=general" />
      {topic && (
        <div className="topic-hero">
          <span className={`topic-icon tone-${topic.tone}`} aria-hidden>
            <Icon name={topic.icon} />
          </span>
          <span className="muted">{items ? `${items.length} ${items.length === 1 ? 'lesson' : 'lessons'}` : ''}</span>
        </div>
      )}
      {!items ? (
        [0, 1, 2].map((i) => <div key={i} className="skeleton" />)
      ) : !items.length ? (
        <div className="card empty">
          <strong>No lessons here yet.</strong>New lessons land every week.
        </div>
      ) : (
        <div className="learn-list">
          {items.map((it) => (
            <LearnRow key={it.id} it={it} />
          ))}
        </div>
      )}
    </main>
  );
}
