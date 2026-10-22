// "Date range" on the dashboards' data pages: from and to are calendar days in Lagos time, both
// included. Either can be left out.
import { z } from 'zod';
import { AppError } from './http';

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-01.')
  .optional();
/** The two fields, to add to a list's own query schema. */
export const DateFields = { from: day, to: day };
export const DateRangeQuery = z
  .object(DateFields)
  .refine((r) => !r.from || !r.to || r.from <= r.to, { message: 'The start date must be on or before the end date.', path: ['from'] });
export type DateRange = z.infer<typeof DateRangeQuery>;

/** A SQL condition on a timestamp column, appending its values to `args`. */
export function dateWhere(r: DateRange | undefined, args: unknown[], column: string): string {
  if (r?.from && r?.to && r.from > r.to) {
    throw new AppError(400, 'validation_failed', 'The start date must be on or before the end date.', { fields: [{ field: 'from', message: 'The start date must be on or before the end date.' }] });
  }
  const parts: string[] = [];
  if (r?.from) {
    args.push(r.from);
    parts.push(`${column} >= ($${args.length}::date::timestamp at time zone 'Africa/Lagos')`);
  }
  if (r?.to) {
    args.push(r.to);
    parts.push(`${column} < (($${args.length}::date + 1)::timestamp at time zone 'Africa/Lagos')`);
  }
  return parts.length ? parts.join(' and ') : 'true';
}
