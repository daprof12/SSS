import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type Principal } from '../core/auth';
import { ZodPipe } from '../core/http';
import { HelpService } from './help.service';

const Send = z.object({ message: z.string().trim().min(1, 'Write a message.').max(4000), conversationId: z.string().uuid().optional() });
const Human = z.object({ reason: z.string().trim().max(300).optional() });
const Close = z.object({ rating: z.number().int().min(1).max(5).optional() });
const After = z.coerce.number().int().min(0).default(0);
const Reply = z.object({ body: z.string().trim().min(2, 'Write a reply.').max(4000) });
const Status = z.enum(['open', 'waiting_human', 'human', 'bot', 'closed', 'all']).default('open');

/** Floating help chat for everyone signed in: the assistant first, a person on request. */
@Controller('me/help/chat')
export class HelpChatController {
  constructor(@Inject(HelpService) private readonly help: HelpService) {}

  @Get()
  current(@CurrentUser() p: Principal) {
    return this.help.current(p);
  }

  @Post()
  send(@CurrentUser() p: Principal, @Body(new ZodPipe(Send)) b: z.infer<typeof Send>) {
    return this.help.send(p, b);
  }

  @Get(':id')
  poll(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Query('after', new ZodPipe(After)) after: number) {
    return this.help.poll(p, id, after);
  }

  @Post(':id/human')
  human(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Human)) b: z.infer<typeof Human>) {
    return this.help.askHuman(p, id, b.reason);
  }

  @Post(':id/close')
  close(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Close)) b: z.infer<typeof Close>) {
    return this.help.close(p, id, b.rating);
  }
}

/** The help team's live chats (Help inbox): read, reply, add a note, hand back to the assistant, close. */
@Controller('admin/support/chats')
export class AdminHelpChatController {
  constructor(@Inject(HelpService) private readonly help: HelpService) {}

  @Get()
  inbox(@CurrentUser() p: Principal, @Query('status', new ZodPipe(Status)) status: z.infer<typeof Status>) {
    return this.help.inbox(p, status);
  }

  @Get(':id')
  chat(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.help.chat(p, id);
  }

  @Post(':id/reply')
  reply(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Reply)) b: z.infer<typeof Reply>) {
    return this.help.staffMessage(p, id, b.body, 'reply');
  }

  @Post(':id/note')
  note(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Reply)) b: z.infer<typeof Reply>) {
    return this.help.staffMessage(p, id, b.body, 'note');
  }

  @Post(':id/release')
  release(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.help.staffState(p, id, 'bot');
  }

  @Post(':id/close')
  close(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.help.staffState(p, id, 'closed');
  }
}
