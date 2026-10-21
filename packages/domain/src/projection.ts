// Role-filtered incident views — Report Tracking and Data Flow §A5/A6.
// The server builds one of these per viewer, so a client never receives a
// field it is not allowed to show. Add a field here before exposing it anywhere.
import { incidentStates, sharesLiveLocation, type IncidentState } from './incident';

export interface LatLng {
  lat: number;
  lng: number;
}

export interface TimelineEntry {
  at: string;
  kind: string;
  label: string;
  /** Shown to reporters, joiners and contacts only when true. */
  public: boolean;
  /** Who did it, for staff views: "System", an officer's name, or "[Name], station". */
  by?: string;
}

/** Full server-side record. Never serialised directly. */
export interface IncidentRecord {
  id: string;
  type: string;
  state: IncidentState;
  agencyId: string;
  stationId?: string;
  reporter: { userId: string; name: string; phone: string; trustScore: number; trustBand: 'high' | 'normal' | 'low' };
  joinerUserIds: string[];
  reportCount: number;
  building: { postcode: string; address: string; areaLabel: string; location: LatLng };
  reporterGps?: LatLng;
  assignedOfficerIds: string[];
  officer?: { id: string; name: string; photoUrl?: string; badgeNo: string; stationName: string; rating: number; location?: LatLng };
  etaMinutes?: number;
  brief?: { summary: string; confidence: 'low' | 'medium' | 'high'; fields: Record<string, unknown> };
  clipIds: string[];
  timeline: TimelineEntry[];
  notes: Array<{ by: string; text: string; at: string }>;
  rating?: { stars: number; comment?: string };
  /** Set when this incident was merged; reporters follow the target instead. */
  mergedInto?: string;
  createdAt: string;
  updatedAt: string;
}

export type Viewer =
  | { kind: 'reporter'; userId: string }
  | { kind: 'joiner'; userId: string }
  | { kind: 'contact'; reporterOptedInLocation: boolean }
  | { kind: 'officer'; userId: string }
  | { kind: 'station'; stationId: string }
  | { kind: 'agency'; agencyId: string }
  | { kind: 'platform_admin' };

export class ForbiddenView extends Error {
  constructor(message = 'Not allowed to view this incident') {
    super(message);
  }
}

const publicTimeline = (r: IncidentRecord) => r.timeline.filter((t) => t.public).map(({ by: _by, ...t }) => t);

/** Contacts see 4 states only (A4). */
function contactState(s: IncidentState): 'finding_team' | 'on_the_way' | 'arrived' | 'closed' {
  if (s === 'accepted' || s === 'en_route') return 'on_the_way';
  if (s === 'on_scene' || s === 'closing') return 'arrived';
  if (s === 'resolved' || s === 'unfounded' || s === 'cancelled') return 'closed';
  return 'finding_team';
}

export function projectIncident(r: IncidentRecord, v: Viewer) {
  const sharing = sharesLiveLocation(r.state);
  const officerCard = r.officer && {
    name: r.officer.name,
    photoUrl: r.officer.photoUrl,
    badgeNo: r.officer.badgeNo,
    stationName: r.officer.stationName,
    rating: r.officer.rating,
  };
  const base = { id: r.id, type: r.type, state: r.state, reportCount: r.reportCount, updatedAt: r.updatedAt };

  switch (v.kind) {
    case 'reporter': {
      if (v.userId !== r.reporter.userId) throw new ForbiddenView();
      return {
        ...base,
        view: 'reporter' as const,
        // Their own building, with coordinates for the live map.
        building: { postcode: r.building.postcode, address: r.building.address, location: r.building.location },
        officer: officerCard,
        officerLocation: sharing ? r.officer?.location : undefined,
        etaMinutes: sharing ? r.etaMinutes : undefined,
        timeline: publicTimeline(r),
        myRating: r.rating,
        mergedInto: r.mergedInto,
      };
    }
    case 'joiner': {
      if (!r.joinerUserIds.includes(v.userId)) throw new ForbiddenView();
      return {
        ...base,
        view: 'joiner' as const,
        // Joiners never learn who reported or the exact building (TRD duplicates).
        area: r.building.areaLabel,
        officer: officerCard,
        officerLocation: sharing ? r.officer?.location : undefined,
        etaMinutes: sharing ? r.etaMinutes : undefined,
        timeline: publicTimeline(r),
      };
    }
    case 'contact':
      return {
        id: r.id,
        view: 'contact' as const,
        reporterFirstName: r.reporter.name.split(' ')[0],
        status: contactState(r.state),
        etaMinutes: sharing ? r.etaMinutes : undefined,
        // Decided 2026-10-17: contacts see the area only, never the building.
        area: r.building.areaLabel,
        reporterLocation: v.reporterOptedInLocation && sharing ? r.reporterGps : undefined,
        updatedAt: r.updatedAt,
      };
    case 'officer': {
      if (!r.assignedOfficerIds.includes(v.userId)) throw new ForbiddenView();
      return {
        ...base,
        view: 'officer' as const,
        reporter: { label: 'Verified citizen', trustBand: r.reporter.trustBand, contact: 'masked_call' as const },
        building: r.building,
        reporterGps: sharing ? r.reporterGps : undefined,
        brief: r.brief && { ...r.brief, advisory: true as const },
        clipIds: r.clipIds,
        team: officerCard,
        timeline: r.timeline,
        notes: r.notes,
        rating: r.rating && { stars: r.rating.stars, comment: r.rating.comment },
      };
    }
    case 'station': {
      if (v.stationId !== r.stationId) throw new ForbiddenView();
      return {
        ...base,
        view: 'station' as const,
        reporter: { name: r.reporter.name, trustBand: r.reporter.trustBand, contact: 'masked_call' as const },
        building: r.building,
        reporterGps: sharing ? r.reporterGps : undefined,
        brief: r.brief && { ...r.brief, advisory: true as const, editable: true as const },
        clipIds: r.clipIds,
        officer: r.officer,
        assignedOfficerIds: r.assignedOfficerIds,
        etaMinutes: r.etaMinutes,
        timeline: r.timeline,
        notes: r.notes,
        rating: r.rating,
      };
    }
    case 'agency': {
      if (v.agencyId !== r.agencyId) throw new ForbiddenView();
      return {
        ...base,
        view: 'agency' as const,
        building: r.building,
        stationId: r.stationId,
        officer: officerCard,
        officerLocation: r.officer?.location,
        timeline: r.timeline,
        rating: r.rating && { stars: r.rating.stars },
      };
    }
    case 'platform_admin':
      return {
        ...base,
        view: 'platform_admin' as const,
        // Phone stays masked; revealing it is a separate audited call.
        reporter: { userId: r.reporter.userId, name: r.reporter.name, trustScore: r.reporter.trustScore, phone: 'masked' as const },
        building: r.building,
        stationId: r.stationId,
        officer: r.officer,
        brief: r.brief,
        clipCount: r.clipIds.length,
        timeline: r.timeline,
        notes: r.notes,
        rating: r.rating,
      };
  }
}

export type IncidentView = ReturnType<typeof projectIncident>;
export { incidentStates };
