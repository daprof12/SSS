// Help chat assistant. Production uses Claude through the Anthropic SDK: a frozen, cached system
// prompt (rules + platform guide), tools for live platform facts, web search for current public
// information, and a tool to hand the conversation to a person. Development and tests use an
// offline stand-in that answers from the same guide and tools and is honest about being limited.
import Anthropic from '@anthropic-ai/sdk';
import { ASSISTANT_RULES, PLATFORM_GUIDE } from '../help/knowledge';

export interface HelpTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** Live facts the assistant may look up. Each call is scoped to the signed-in person by the caller. */
export interface HelpToolKit {
  searchAgencies(query: string): Promise<unknown>;
  searchLearn(query: string): Promise<unknown>;
  myReports(): Promise<unknown>;
  myOpenItems(): Promise<unknown>;
}

export interface AssistantReply {
  text: string;
  /** Set when the assistant handed the conversation to the help team. */
  handoff: string | null;
  sources: { title: string; url?: string }[];
  model: string;
  ms: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AssistantInput {
  history: HelpTurn[];
  user: { name: string; surface: 'citizen' | 'officer' | 'staff' };
  tools: HelpToolKit;
}

export interface AssistantAdapter {
  readonly name: string;
  reply(input: AssistantInput): Promise<AssistantReply>;
}

export const ASSISTANT = Symbol('ASSISTANT');

const MODEL = 'claude-opus-5-5';

const CUSTOM_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'search_agencies',
    description: 'Find agencies on the platform by name or by what they handle (for example "fire", "trafficking", "potholes"). Returns each agency with its kind, status and what it handles.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Words to search for' } }, required: ['query'], additionalProperties: false },
    strict: true,
  },
  {
    name: 'search_learn',
    description: 'Search the platform\'s Learn feed (safety articles, videos and quizzes written or approved by agencies). Use it for safety advice so you can point to an article.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Topic to search for' } }, required: ['query'], additionalProperties: false },
    strict: true,
  },
  {
    name: 'my_reports',
    description: "The signed-in person's own recent reports (emergencies, tips and public issues) with their status. Only their own; never anyone else's.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: 'my_open_items',
    description: "The signed-in person's open items: statements waiting for them, fines and appeals, and help tickets.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: 'request_human',
    description: 'Hand this conversation to a person on the help team. Use it when the person asks for a person, for missing or wrong money, appeals or complaints about an officer, safety worries you cannot settle, or anything you cannot help with.',
    input_schema: { type: 'object', properties: { reason: { type: 'string', description: 'One sentence for the help team: what the person needs' } }, required: ['reason'], additionalProperties: false },
    strict: true,
  },
];

export class AnthropicAssistantAdapter implements AssistantAdapter {
  readonly name = 'anthropic';
  private readonly client = new Anthropic();

  async reply(input: AssistantInput): Promise<AssistantReply> {
    const started = Date.now();
    const system: Anthropic.Beta.BetaTextBlockParam[] = [
      // Frozen and cached: the same bytes on every request.
      { type: 'text', text: `${ASSISTANT_RULES}\n\n${PLATFORM_GUIDE}`, cache_control: { type: 'ephemeral' } },
      // Varies by person: after the cache breakpoint.
      { type: 'text', text: `You are talking to ${input.user.name}, who uses the ${input.user.surface === 'officer' ? 'officer app' : input.user.surface === 'staff' ? 'staff dashboard' : 'citizen app'}.` },
    ];
    const tools: Anthropic.Beta.BetaToolUnion[] = [...CUSTOM_TOOLS, { type: 'web_search_20260209', name: 'web_search', max_uses: 3 }];
    const messages: Anthropic.Beta.BetaMessageParam[] = input.history.map((t) => ({ role: t.role, content: t.text }));
    let handoff: string | null = null;
    const sources: { title: string; url?: string }[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let model = MODEL;

    for (let turn = 0; turn < 6; turn++) {
      const response = await this.client.beta.messages.create({
        model: MODEL,
        max_tokens: 4096,
        // Chat: short answers, low effort. Thinking stays adaptive (always on for this model).
        output_config: { effort: 'low' },
        // A policy decline is re-run on Anthropic's recommended fallback model instead of failing.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system,
        tools,
        messages,
      });
      model = response.model;
      inputTokens += response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0);
      outputTokens += response.usage.output_tokens;
      for (const block of response.content) {
        if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
          for (const r of block.content) if (r.type === 'web_search_result') sources.push({ title: r.title, url: r.url });
        }
      }

      if (response.stop_reason === 'refusal') {
        return { text: 'I cannot help with that here. I have passed your message to a person on the help team.', handoff: 'Assistant declined the request', sources, model, ms: Date.now() - started, inputTokens, outputTokens };
      }
      if (response.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: response.content });
        continue;
      }
      const calls = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (response.stop_reason !== 'tool_use' || !calls.length) {
        const text = response.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('')
          .trim();
        return { text: text || (handoff ? 'I have passed this to a person on the help team. They will reply here.' : 'Sorry, I could not answer that.'), handoff, sources: dedupe(sources), model, ms: Date.now() - started, inputTokens, outputTokens };
      }
      messages.push({ role: 'assistant', content: response.content });
      // All results go back in one user message, so parallel calls keep working.
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const call of calls) {
        try {
          const args = (call.input ?? {}) as { query?: string; reason?: string };
          let out: unknown;
          if (call.name === 'search_agencies') out = await input.tools.searchAgencies(String(args.query ?? ''));
          else if (call.name === 'search_learn') out = await input.tools.searchLearn(String(args.query ?? ''));
          else if (call.name === 'my_reports') out = await input.tools.myReports();
          else if (call.name === 'my_open_items') out = await input.tools.myOpenItems();
          else if (call.name === 'request_human') {
            handoff = String(args.reason ?? 'The person asked for a person');
            out = { ok: true, note: 'Handed to the help team. Tell the person a person will reply in this chat.' };
          } else out = { error: 'Unknown tool' };
          results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(out) });
        } catch (e) {
          results.push({ type: 'tool_result', tool_use_id: call.id, content: `Lookup failed: ${(e as Error).message}`, is_error: true });
        }
      }
      messages.push({ role: 'user', content: results });
    }
    return { text: 'This is taking longer than it should. I have passed it to a person on the help team.', handoff: handoff ?? 'Assistant could not finish', sources: dedupe(sources), model, ms: Date.now() - started, inputTokens, outputTokens };
  }
}

const dedupe = (xs: { title: string; url?: string }[]) => xs.filter((x, i) => xs.findIndex((y) => (y.url ?? y.title) === (x.url ?? x.title)) === i).slice(0, 5);

/**
 * Offline stand-in for development and tests (no model is called). It looks things up with the same
 * tools, answers from the platform guide, and hands to a person whenever it cannot help.
 */
export class MockAssistantAdapter implements AssistantAdapter {
  readonly name = 'mock';

  async reply(input: AssistantInput): Promise<AssistantReply> {
    const started = Date.now();
    const q = [...input.history].reverse().find((t) => t.role === 'user')?.text ?? '';
    const s = q.toLowerCase();
    const done = (text: string, extra: Partial<AssistantReply> = {}): AssistantReply => ({ text, handoff: null, sources: [], model: 'offline-assistant', ms: Date.now() - started, inputTokens: 0, outputTokens: 0, ...extra });
    const danger = /\b(help me|attack|attacked|kidnap|robbery|robbers|fire|bleeding|dying|gun|shoot|rape|accident|danger)\b/.test(s);
    const prefix = danger ? 'If you or someone is in danger now, press SOS in the app or call 112. ' : '';
    const wantsPerson = /\b(talk|speak|chat) (to|with) (a |an )?(real )?(person|human|agent|someone|somebody|staff)\b|\b(real person|human agent|customer care|support staff)\b/.test(s);
    const moneyProblem = /\b(missing|refund|not (arrived|received)|complain|complaint)\b/.test(s);
    if (wantsPerson || moneyProblem) {
      return done(`${prefix}I have passed this to a person on the help team. They will reply here, usually within one working day.`, { handoff: q.slice(0, 300) || 'The person asked for a person' });
    }
    if (/\bmy (report|reports|case|sos)\b|status of my/.test(s)) {
      const r = (await input.tools.myReports()) as { label: string; status: string }[];
      return done(r.length ? `${prefix}Your recent reports: ${r.slice(0, 5).map((x) => `${x.label}, ${x.status}`).join('; ')}.` : `${prefix}You have no reports yet.`);
    }
    if (/\b(statement|fine|ticket)s?\b/.test(s) && /\bmy\b/.test(s)) {
      const o = (await input.tools.myOpenItems()) as { statements: unknown[]; fines: unknown[]; tickets: unknown[] };
      return done(`${prefix}You have ${o.statements.length} statement${o.statements.length === 1 ? '' : 's'} waiting, ${o.fines.length} open fine${o.fines.length === 1 ? '' : 's'} and ${o.tickets.length} open help ticket${o.tickets.length === 1 ? '' : 's'}.`);
    }
    if (/\b(agency|agencies|who handles|police|fire service|naptip|ndlea|nafdac|efcc|frsc|ambulance)\b/.test(s)) {
      const words = s.replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !['agency', 'agencies', 'which', 'handles', 'what', 'does', 'there', 'about'].includes(w));
      const a = (await input.tools.searchAgencies(words.join(' ') || s)) as { name: string; kind: string; handles: string }[];
      if (a.length) return done(`${prefix}On the platform: ${a.slice(0, 4).map((x) => `${x.name} (${x.handles})`).join('; ')}.`, { sources: a.slice(0, 4).map((x) => ({ title: x.name })) });
    }
    const guide = this.fromGuide(s);
    if (guide) return done(`${prefix}${guide}`);
    const learn = (await input.tools.searchLearn(s)) as { title: string; href: string }[];
    if (learn.length) return done(`${prefix}This may help: ${learn.slice(0, 3).map((l) => l.title).join('; ')}. Open them in Learn.`, { sources: learn.slice(0, 3).map((l) => ({ title: l.title, url: l.href })) });
    return done(`${prefix}I could not find an answer to that. Ask me another way, or ask for a person and the help team will reply here.`);
  }

  /** The guide section whose words best match the question. */
  private fromGuide(s: string): string | null {
    const words = new Set(s.split(/[^a-z]+/).filter((w) => w.length > 3));
    let best: { score: number; text: string } | null = null;
    for (const section of PLATFORM_GUIDE.split(/\n## /).slice(1)) {
      const [title, ...lines] = section.split('\n');
      const body = lines.join(' ').toLowerCase();
      let score = 0;
      for (const w of words) if (body.includes(w) || title!.toLowerCase().includes(w)) score++;
      if (score >= 2 && (!best || score > best.score)) best = { score, text: lines.map((l) => l.replace(/^- /, '')).filter(Boolean).slice(0, 3).join(' ') };
    }
    return best?.text ?? null;
  }
}
