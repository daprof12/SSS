import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type Principal } from '../core/auth';
import { ZodPipe } from '../core/http';
import { OfficerWorkService } from './work.service';

const Filter = z.enum(['all', 'mine', 'team', 'month']).default('all');
const FieldReport = z.object({
  type: z.enum(['fire', 'robbery', 'kidnapping', 'riot', 'violence', 'medical', 'accident', 'other']),
  description: z.string().max(2000),
  postcode: z.string().trim().min(3).max(12).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  incidentId: z.string().uuid().optional(),
  clientRef: z.string().min(8).max(80),
});

@Controller('me/officer')
export class OfficerWorkController {
  constructor(@Inject(OfficerWorkService) private readonly work: OfficerWorkService) {}

  @Get('history')
  history(@CurrentUser() p: Principal, @Query('filter', new ZodPipe(Filter)) f: z.infer<typeof Filter>) {
    return this.work.history(p, f);
  }

  @Get('history/:id')
  detail(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.work.historyDetail(p, id);
  }

  @Get('team')
  team(@CurrentUser() p: Principal) {
    return this.work.team(p);
  }

  @Get('profile')
  profile(@CurrentUser() p: Principal) {
    return this.work.profile(p);
  }

  @Get('shifts')
  shifts(@CurrentUser() p: Principal) {
    return this.work.shifts(p);
  }

  @Get('field-reports/linkable')
  linkable(@CurrentUser() p: Principal) {
    return this.work.linkable(p);
  }

  @Get('field-reports')
  reports(@CurrentUser() p: Principal) {
    return this.work.myReports(p);
  }

  @Post('field-reports')
  file(@CurrentUser() p: Principal, @Body(new ZodPipe(FieldReport)) b: z.infer<typeof FieldReport>) {
    return this.work.fileReport(p, b);
  }
}
