import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { can, CurrentUser, hasRole, type Principal } from '../core/auth';
import { Db } from '../core/db';
import { AppError, ZodPipe } from '../core/http';

const Body_ = z.object({ body: z.string().trim().min(1, 'Write a message.').max(2000) });

/**
 * Messages on a report between the citizen who reported it and the people responding: the officers on it,
 * and its station and agency staff. Both sides can start the conversation. The other side is notified.
 */
@Controller('incidents/:id/messages')
export class IncidentMessagesController {
  constructor(@Inject(Db) private readonly db: Db) {}

  private async who(p: Principal, id: string) {
    const i = (await this.db.query(`select i.id, i.reporter_id, i.station_id, i.agency_id from incidents i where i.id = $1`, [id])).rows[0];
    if (!i) throw new AppError(404, 'not_found', 'This report could not be found.');
    const reporter = i.reporter_id === p.userId || !!(await this.db.query(`select 1 from incident_reports where incident_id = $1 and reporter_id = $2`, [id, p.userId])).rowCount;
    const officer = !!(await this.db.query(`select 1 from incident_units where incident_id = $1 and officer_id = $2 and state in ('accepted', 'en_route', 'on_scene', 'closing')`, [id, p.userId])).rowCount;
    const staff =
      (i.station_id && (hasRole(p, 'head', i.station_id) || hasRole(p, 'dispatcher', i.station_id))) || (i.agency_id && hasRole(p, 'agency_admin', i.agency_id)) || can(p, 'platform.live');
    if (!reporter && !officer && !staff) throw new AppError(404, 'not_found', 'This report could not be found.');
    return { incident: i, side: (reporter ? 'citizen' : 'responder') as 'citizen' | 'responder' };
  }

  @Get()
  async list(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    const { side } = await this.who(p, id);
    const rows = (
      await this.db.query(
        `select m.id, m.body, m.side, m.created_at, m.sender_id, u.display_name as name from incident_messages m join users u on u.id = m.sender_id where m.incident_id = $1 order by m.id limit 200`,
        [id],
      )
    ).rows;
    return {
      you: side,
      messages: rows.map((m) => ({ id: Number(m.id), body: m.body, side: m.side, mine: m.sender_id === p.userId, name: m.side === 'citizen' ? 'Reporter' : m.name, at: m.created_at })),
    };
  }

  @Post()
  async send(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Body_)) b: z.infer<typeof Body_>) {
    const { incident, side } = await this.who(p, id);
    const m = (await this.db.query(`insert into incident_messages (incident_id, sender_id, side, body) values ($1, $2, $3, $4) returning id, created_at`, [id, p.userId, side, b.body])).rows[0];
    // Tell the other side: the reporter, or the officers on the report.
    if (side === 'responder') {
      await this.db.query(
        `insert into notifications (user_id, type, grp, channel, title, body, deep_link) values ($1, 'report_message', 'reports', 'in_app', 'A message about your report', $2, $3)`,
        [incident.reporter_id, b.body.slice(0, 140), `/reports/${id}`],
      );
    } else {
      await this.db.query(
        `insert into notifications (user_id, type, grp, channel, title, body, deep_link)
         select distinct x.officer_id, 'report_message', 'dispatch', 'in_app', 'The reporter sent a message', $2, $3 from incident_units x where x.incident_id = $1 and x.officer_id is not null and x.state in ('accepted', 'en_route', 'on_scene')`,
        [id, b.body.slice(0, 140), `/officer/incidents/${id}`],
      );
    }
    return { id: Number(m.id), at: m.created_at };
  }
}
