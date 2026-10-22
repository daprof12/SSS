import { Body, Controller, Delete, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Public, type Principal } from '../core/auth';
import { ZodPipe } from '../core/http';
import { PushService } from './push.service';

const Subscription = z.object({
  endpoint: z.string().url().max(1000).refine((u) => u.startsWith('https://'), 'Push endpoints use https.'),
  keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }),
  label: z.string().max(80).optional(),
});
const Unsubscribe = z.object({ endpoint: z.string().max(1000) });

@Controller()
export class PushController {
  constructor(@Inject(PushService) private readonly push: PushService) {}

  /** The public key the app subscribes with. */
  @Public()
  @Get('push/key')
  key() {
    return this.push.publicKey();
  }

  @Get('me/push')
  status(@CurrentUser() p: Principal) {
    return this.push.status(p.userId);
  }

  @Post('me/push')
  @HttpCode(200)
  subscribe(@CurrentUser() p: Principal, @Body(new ZodPipe(Subscription)) b: z.infer<typeof Subscription>) {
    return this.push.subscribe(p.userId, b);
  }

  @Delete('me/push')
  unsubscribe(@CurrentUser() p: Principal, @Body(new ZodPipe(Unsubscribe)) b: z.infer<typeof Unsubscribe>) {
    return this.push.unsubscribe(p.userId, b.endpoint);
  }

  @Post('me/push/test')
  @HttpCode(200)
  test(@CurrentUser() p: Principal) {
    return this.push.test(p.userId);
  }
}
