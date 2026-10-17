// Seven roles (PRD six + technician, decided 2026-10-17). Scopes follow
// user_roles(scope_type, scope_id) in the Backend Schema.
export const roles = [
  'citizen',
  'owner',
  'officer',
  'head',
  'dispatcher',
  'agency_admin',
  'agency_finance',
  'platform_admin',
  'technician',
] as const;
export type Role = (typeof roles)[number];

export type ScopeType = 'platform' | 'agency' | 'station' | 'property' | 'self';

/** Staff roles must have two-step login on (Public Issues doc §5). */
export const mfaRequired: ReadonlySet<Role> = new Set([
  'officer',
  'head',
  'dispatcher',
  'agency_admin',
  'agency_finance',
  'platform_admin',
  'technician',
]);
