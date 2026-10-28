import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type Principal } from '../core/auth';
import { ZodPipe } from '../core/http';
import { COMMANDS, FLEET_TYPES, FleetService } from './fleet.service';

const CommandBody = z.object({ command: z.enum(COMMANDS), incidentId: z.string().uuid().optional() });
const Access = z.object({ enabled: z.boolean() });
const Register = z.object({
  type: z.enum(FLEET_TYPES),
  serial: z.string().trim().min(3).max(60),
  name: z.string().trim().max(80).optional(),
  agencyId: z.string().uuid(),
  stationId: z.string().uuid().optional(),
  officerId: z.string().uuid().optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  dockedOn: z.string().uuid().optional(),
});

/** Control centre for agencies with device access, and the platform admin side that grants it. */
@Controller()
export class FleetController {
  constructor(@Inject(FleetService) private readonly fleet: FleetService) {}

  @Get('control')
  overview(@CurrentUser() p: Principal) {
    return this.fleet.overview(p);
  }

  @Get('control/incidents/:id')
  scene(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.fleet.scene(p, id);
  }

  @Post('control/devices/:id/commands')
  command(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(CommandBody)) b: z.infer<typeof CommandBody>) {
    return this.fleet.command(p, id, b.command, b.incidentId);
  }

  @Get('admin/fleet')
  adminFleet(@CurrentUser() p: Principal) {
    return this.fleet.fleet(p);
  }

  @Post('admin/agencies/:id/device-access')
  access(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Access)) b: z.infer<typeof Access>) {
    return this.fleet.setAccess(p, id, b.enabled);
  }

  @Post('admin/fleet/devices')
  register(@CurrentUser() p: Principal, @Body(new ZodPipe(Register)) b: z.infer<typeof Register>) {
    return this.fleet.register(p, b);
  }
}
