// Learn (Design Brief: "A swipe feed of short safety lessons keeps the app useful between
// emergencies"). Boards: Learn feed, For you, General, choose interests, filter, search,
// end of feed; Admin learn feed (Live, In review, Drafts, Removed; reviewed before live).
import { defineMachine } from './machine';

export interface LearnTopic {
  code: string;
  label: string;
  /** Icon name in the apps' icon set, and the tone used for its tile and feed gradient. */
  icon: string;
  tone: 'emergency' | 'warning' | 'success' | 'signal';
}

export const learnTopics: LearnTopic[] = [
  { code: 'fire_safety', label: 'Fire safety', icon: 'fire', tone: 'emergency' },
  { code: 'road_safety', label: 'Road safety', icon: 'road', tone: 'warning' },
  { code: 'first_aid', label: 'First aid', icon: 'plus', tone: 'success' },
  { code: 'crime_prevention', label: 'Crime prevention', icon: 'shield', tone: 'signal' },
  { code: 'scams_fraud', label: 'Scams and fraud', icon: 'flag', tone: 'warning' },
  { code: 'flood_disaster', label: 'Flood and disaster', icon: 'environment', tone: 'signal' },
  { code: 'child_safety', label: 'Child safety', icon: 'heart', tone: 'emergency' },
  { code: 'home_security', label: 'Home security', icon: 'lock', tone: 'signal' },
  { code: 'health_outbreaks', label: 'Health and outbreaks', icon: 'medical', tone: 'success' },
  { code: 'drugs_addiction', label: 'Drugs and addiction', icon: 'help', tone: 'warning' },
  { code: 'environment', label: 'Environment', icon: 'environment', tone: 'success' },
  { code: 'know_your_rights', label: 'Know your rights', icon: 'globe', tone: 'signal' },
];
export const learnTopic = (code: string) => learnTopics.find((t) => t.code === code);

export const learnLanguages = [
  { code: 'en', label: 'English' },
  { code: 'pcm', label: 'Pidgin' },
  { code: 'yo', label: 'Yoruba' },
  { code: 'ha', label: 'Hausa' },
  { code: 'ig', label: 'Igbo' },
] as const;
export type LearnLanguage = (typeof learnLanguages)[number]['code'];

export type LearnFormat = 'video' | 'article' | 'quiz';
export const LEARN_MIN_INTERESTS = 3;
/** Filter "Length": under 1 min, 1 to 3 min, over 3 min. */
export const lengthBand = (seconds: number) => (seconds < 60 ? 'short' : seconds <= 180 ? 'medium' : 'long');

export interface QuizQuestion {
  q: string;
  options: string[];
  /** Index of the right option. */
  answer: number;
  /** Shown after answering, right or wrong. */
  why: string;
}

/** A post is complete enough to send for review. Returns the first problem, if any. */
export function checkLearnPost(p: { title: string; caption: string; topic: string; format: LearnFormat; body?: string | null; quiz?: QuizQuestion[] | null; hasMedia: boolean }): { field: string; message: string } | null {
  if (p.title.trim().length < 5) return { field: 'title', message: 'Give it a title people understand.' };
  if (!learnTopic(p.topic)) return { field: 'topic', message: 'Choose a topic.' };
  if (p.caption.trim().length < 10) return { field: 'caption', message: 'Add a short tip, one or two lines.' };
  if (p.format === 'video' && !p.hasMedia) return { field: 'media', message: 'Upload the video before sending it for review.' };
  if (p.format === 'article' && (p.body ?? '').trim().length < 80) return { field: 'body', message: 'Write the article. A few short paragraphs is enough.' };
  if (p.format === 'quiz') {
    const qs = p.quiz ?? [];
    if (qs.length < 1) return { field: 'quiz', message: 'Add at least one question.' };
    for (const [i, q] of qs.entries()) {
      if (q.q.trim().length < 5 || q.options.filter((o) => o.trim()).length < 2 || q.answer < 0 || q.answer >= q.options.length) {
        return { field: 'quiz', message: `Question ${i + 1} needs the question, at least two answers and the right one marked.` };
      }
    }
  }
  return null;
}

/** Reviewed before they go live (board); a reviewer cannot approve their own post. */
export const learnPostMachine = defineMachine<
  'draft' | 'in_review' | 'live' | 'removed',
  'submit' | 'approve' | 'send_back' | 'remove' | 'restore',
  'platform_admin'
>({
  name: 'learnPost',
  initial: 'draft',
  terminal: [],
  transitions: [
    { event: 'submit', from: ['draft'], to: 'in_review', actors: ['platform_admin'] },
    { event: 'approve', from: ['in_review'], to: 'live', actors: ['platform_admin'] },
    { event: 'send_back', from: ['in_review'], to: 'draft', actors: ['platform_admin'] },
    { event: 'remove', from: ['live', 'in_review', 'draft'], to: 'removed', actors: ['platform_admin'] },
    { event: 'restore', from: ['removed'], to: 'draft', actors: ['platform_admin'] },
  ],
});

/**
 * "For you" ranking. Interests and what the person watched pull a post up; seen posts and
 * topics they marked Not interested push it down. Newer posts win ties.
 */
export function rankForYou(
  post: { topic: string; language: string; publishedAt: number; seen: boolean; liked: boolean },
  me: { interests: string[]; languages: string[]; watchedTopics: Record<string, number>; mutedTopics: string[]; now: number },
): { score: number; reason: string | null } {
  if (me.mutedTopics.includes(post.topic)) return { score: -Infinity, reason: null };
  let score = 0;
  let reason: string | null = null;
  const label = learnTopic(post.topic)?.label ?? post.topic;
  const watched = me.watchedTopics[post.topic] ?? 0;
  if (watched > 0) {
    score += 3 + Math.min(watched, 5);
    reason = `Shown because you watch ${label}`;
  }
  if (me.interests.includes(post.topic)) {
    score += 5;
    reason ??= `Because you picked ${label}`;
  }
  if (me.languages.length && !me.languages.includes(post.language)) score -= 6;
  if (post.seen) score -= 20;
  const days = (me.now - post.publishedAt) / 86_400_000;
  score += Math.max(0, 3 - days / 7); // fresh posts first for three weeks
  return { score, reason };
}
