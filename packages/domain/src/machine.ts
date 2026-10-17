// A tiny declarative state machine. Every process in the platform (incident,
// report delivery, subscription, withdrawal, tip, invite, install job) is a
// table of transitions so the API, the apps and the docs share one source.

export interface Transition<S extends string, E extends string, A extends string> {
  event: E;
  from: readonly S[];
  to: S;
  /** Who may fire this event. 'system' covers timers, routing and webhooks. */
  actors: readonly A[];
}

export interface MachineDef<S extends string, E extends string, A extends string> {
  name: string;
  initial: S;
  terminal: readonly S[];
  transitions: readonly Transition<S, E, A>[];
}

export type TransitionResult<S extends string> =
  | { ok: true; from: S; to: S }
  | { ok: false; code: 'terminal_state' | 'invalid_transition' | 'actor_not_allowed'; message: string };

export function defineMachine<S extends string, E extends string, A extends string>(
  def: MachineDef<S, E, A>,
): MachineDef<S, E, A> {
  const seen = new Set<string>();
  for (const t of def.transitions) {
    for (const f of t.from) {
      const key = `${t.event}:${f}`;
      if (seen.has(key)) throw new Error(`${def.name}: event "${t.event}" defined twice from "${f}"`);
      seen.add(key);
      if (def.terminal.includes(f)) throw new Error(`${def.name}: "${t.event}" leaves terminal state "${f}"`);
    }
  }
  return def;
}

export function applyEvent<S extends string, E extends string, A extends string>(
  def: MachineDef<S, E, A>,
  state: S,
  event: E,
  actor: A,
): TransitionResult<S> {
  if (def.terminal.includes(state)) {
    return { ok: false, code: 'terminal_state', message: `${def.name} is already ${state}` };
  }
  const t = def.transitions.find((x) => x.event === event && x.from.includes(state));
  if (!t) {
    return { ok: false, code: 'invalid_transition', message: `${event} is not allowed when ${def.name} is ${state}` };
  }
  if (!t.actors.includes(actor)) {
    return { ok: false, code: 'actor_not_allowed', message: `${actor} cannot ${event}` };
  }
  return { ok: true, from: state, to: t.to };
}

/** Events an actor can fire from a state — drives which buttons a screen shows. */
export function availableEvents<S extends string, E extends string, A extends string>(
  def: MachineDef<S, E, A>,
  state: S,
  actor: A,
): E[] {
  return def.transitions.filter((t) => t.from.includes(state) && t.actors.includes(actor)).map((t) => t.event);
}

export function reachableStates<S extends string, E extends string, A extends string>(def: MachineDef<S, E, A>): Set<S> {
  const out = new Set<S>([def.initial]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of def.transitions) {
      if (!out.has(t.to) && t.from.some((f) => out.has(f))) {
        out.add(t.to);
        grew = true;
      }
    }
  }
  return out;
}
