import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type Principal } from '../core/auth';
import { ZodPipe } from '../core/http';
import { HomeService } from './home.service';

const Invite = z.object({ phone: z.string().trim().min(1, 'Enter a phone number.'), viewLive: z.boolean(), alerts: z.boolean(), report: z.boolean() });
const Answer = z.object({ accept: z.boolean() });
const Settings = z.object({ recordingDays: z.number().int().optional(), shareWithResponders: z.enum(['emergency_only', 'never']).optional() });
const Report = z.object({ deviceId: z.string().uuid(), problem: z.string(), description: z.string().max(1000), bestTime: z.string().max(120).optional() });
const Time = z.object({ bestTime: z.string().max(120) });
const Confirm = z.object({ fixed: z.boolean() });
const AdminAct = z.object({ action: z.enum(['confirm_fault', 'book', 'fixed']), scheduledAt: z.string().optional(), window: z.string().max(40).optional(), technicianId: z.string().uuid().optional() });

@Controller('me')
export class HomeController {
  constructor(@Inject(HomeService) private readonly home: HomeService) {}

  @Get('home')
  overview(@CurrentUser() p: Principal) {
    return this.home.overview(p);
  }

  @Get('home/household')
  household(@CurrentUser() p: Principal) {
    return this.home.household(p);
  }

  @Post('home/invites')
  invite(@CurrentUser() p: Principal, @Body(new ZodPipe(Invite)) b: z.infer<typeof Invite>) {
    return this.home.invite(p, b);
  }

  @Delete('home/invites/:id')
  revoke(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.home.revokeInvite(p, id);
  }

  @Post('home/invites/:id/answer')
  @HttpCode(200)
  answer(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Answer)) b: z.infer<typeof Answer>) {
    return this.home.answer(p, id, b.accept);
  }

  @Delete('home/members/:userId')
  remove(@CurrentUser() p: Principal, @Param('userId', ParseUUIDPipe) userId: string) {
    return this.home.removeMember(p, userId);
  }

  @Get('devices/:id')
  device(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.home.deviceView(p, id);
  }

  @Patch('devices/:id/settings')
  settings(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Settings)) b: z.infer<typeof Settings>) {
    return this.home.settings(p, id, b);
  }

  @Post('devices/:id/clips')
  clip(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.home.saveClip(p, id);
  }

  @Post('devices/:id/boost')
  boost(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.home.boost(p, id);
  }

  @Post('repairs')
  report(@CurrentUser() p: Principal, @Body(new ZodPipe(Report)) b: z.infer<typeof Report>) {
    return this.home.report(p, b);
  }

  @Get('repairs/:id')
  repair(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.home.repair(p, id);
  }

  @Post('repairs/:id/time')
  @HttpCode(200)
  time(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Time)) b: z.infer<typeof Time>) {
    return this.home.changeTime(p, id, b.bestTime);
  }

  @Post('repairs/:id/confirm')
  @HttpCode(200)
  confirm(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Confirm)) b: z.infer<typeof Confirm>) {
    return this.home.confirm(p, id, b.fixed);
  }
}

@Controller('admin/repairs')
export class AdminRepairsController {
  constructor(@Inject(HomeService) private readonly home: HomeService) {}

  @Get()
  list(@CurrentUser() p: Principal) {
    return this.home.adminList(p);
  }

  @Post(':id')
  @HttpCode(200)
  act(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(AdminAct)) b: z.infer<typeof AdminAct>) {
    return this.home.adminAct(p, id, b);
  }
}
