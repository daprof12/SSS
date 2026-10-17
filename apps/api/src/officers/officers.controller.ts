import { Body, Controller, Get, HttpCode, Inject, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type Principal } from '../core/auth';
import { ZodPipe } from '../core/http';
import { OfficersService } from './officers.service';

const Point = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const DutyBody = z.object({ onDuty: z.boolean(), location: Point.optional() });

@Controller('me/officer')
export class OfficersController {
  constructor(@Inject(OfficersService) private readonly officers: OfficersService) {}

  @Get('home')
  home(@CurrentUser() p: Principal) {
    return this.officers.home(p);
  }

  @Patch('duty')
  duty(@CurrentUser() p: Principal, @Body(new ZodPipe(DutyBody)) b: z.infer<typeof DutyBody>) {
    return this.officers.setDuty(p, b.onDuty, b.location);
  }

  @Post('location')
  @HttpCode(200)
  location(@CurrentUser() p: Principal, @Body(new ZodPipe(Point)) b: z.infer<typeof Point>) {
    return this.officers.updateLocation(p, b.lat, b.lng);
  }
}
