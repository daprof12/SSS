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
  'platform_finance',
  'platform_support',
  'platform_ops',
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
  'platform_finance',
  'platform_support',
  'platform_ops',
  'technician',
]);

/**
 * Role-based access for the dashboards. Each permission lists the roles that hold it; platform
 * roles hold it platform-wide, agency roles for their agency, station roles for their station.
 * The API enforces these; the dashboard hides what a role cannot open.
 */
export const PERMISSIONS = {
  // Platform
  'platform.overview': ['platform_admin', 'platform_finance', 'platform_support', 'platform_ops'],
  'platform.live': ['platform_admin', 'platform_support', 'platform_ops'],
  'platform.devices': ['platform_admin', 'platform_ops'],
  'platform.devices.live_view': ['platform_admin'],
  'platform.users': ['platform_admin', 'platform_support'],
  'platform.kyc': ['platform_admin', 'platform_support'],
  'platform.money': ['platform_admin', 'platform_finance'],
  'platform.fines': ['platform_admin', 'platform_finance', 'platform_support'],
  'platform.support': ['platform_admin', 'platform_support'],
  'platform.learn': ['platform_admin', 'platform_support'],
  'platform.crm': ['platform_admin', 'platform_support'],
  'platform.agencies': ['platform_admin'],
  'platform.audit': ['platform_admin'],
  'platform.ai': ['platform_admin'],
  'platform.settings': ['platform_admin'],
  'platform.team': ['platform_admin'],
  // Agency
  'agency.view': ['agency_admin', 'agency_finance'],
  'agency.operations': ['agency_admin'],
  'agency.money': ['agency_admin', 'agency_finance'],
  'agency.team': ['agency_admin'],
  // Station
  'station.operations': ['head', 'dispatcher'],
  'station.manage': ['head'],
} as const satisfies Record<string, readonly Role[]>;
export type Permission = keyof typeof PERMISSIONS;

export const ROLE_LABEL: Record<Role, string> = {
  citizen: 'Citizen',
  owner: 'Home owner',
  officer: 'Officer',
  head: 'Station head',
  dispatcher: 'Dispatcher',
  agency_admin: 'Agency admin',
  agency_finance: 'Agency finance',
  platform_admin: 'Platform admin',
  platform_finance: 'Platform finance',
  platform_support: 'Platform support',
  platform_ops: 'Platform operations',
  technician: 'Technician',
};

/** What each staff role is for, shown when inviting a team member. */
export const ROLE_SCOPE_NOTE: Partial<Record<Role, string>> = {
  platform_admin: 'Everything, including agencies, AI, audit and settings',
  platform_finance: 'Subscriptions, donations, payouts and fines',
  platform_support: 'Users, KYC, help inbox, fines appeals, Learn and messaging',
  platform_ops: 'Live map, coverage, devices, inventory and installs',
  agency_admin: 'Everything for the agency, including payouts',
  agency_finance: 'Billing, payouts and bounty pool only',
  head: 'One station: officers, reports, roster, equipment',
  dispatcher: 'Live reports at one station: reassign and escalate',
};

/** Does a set of role grants hold a permission (optionally for one agency or station)? */
export function holds(grants: ReadonlyArray<{ role: string; scopeId: string | null }>, perm: Permission, scopeId?: string | null): boolean {
  const allowed = PERMISSIONS[perm] as readonly string[];
  return grants.some((g) => allowed.includes(g.role) && (perm.startsWith('platform.') || scopeId == null || g.scopeId === scopeId));
}
