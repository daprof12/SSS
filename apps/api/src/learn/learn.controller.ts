import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type Principal } from '../core/auth';
import { ZodPipe } from '../core/http';
import { LearnService } from './learn.service';

const Browse = z.object({
  q: z.string().max(80).optional(),
  format: z.enum(['all', 'video', 'article', 'quiz']).optional(),
  topics: z.string().max(400).optional(), // comma separated
  languages: z.string().max(40).optional(),
  length: z.enum(['short', 'medium', 'long']).optional(),
  from: z.string().max(40).optional(),
  sort: z.enum(['best', 'newest', 'most_viewed']).optional(),
  saved: z.enum(['1', '0', 'true', 'false']).optional(),
});
const csv = (v?: string) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
const Interests = z.object({ topics: z.array(z.string()).max(20), languages: z.array(z.string()).max(5) });
const React = z.object({
  liked: z.boolean().optional(),
  saved: z.boolean().optional(),
  notInterested: z.boolean().optional(),
  seen: z.boolean().optional(),
  watchedS: z.number().int().min(0).max(3600).optional(),
  completed: z.boolean().optional(),
});
const Quiz = z.object({ answers: z.array(z.number().int().min(0).max(9)).max(20) });
const Question = z.object({ q: z.string().max(300), options: z.array(z.string().max(160)).min(2).max(6), answer: z.number().int().min(0), why: z.string().max(400).default('') });
const PostBody = z.object({
  title: z.string().trim().min(1, 'Give it a title people understand.').max(140),
  caption: z.string().max(300).default(''),
  topic: z.string(),
  format: z.enum(['video', 'article', 'quiz']),
  language: z.string().default('en'),
  body: z.string().max(8000).nullable().optional(),
  quiz: z.array(Question).max(10).nullable().optional(),
  durationS: z.number().int().min(1).max(3600).nullable().optional(),
  sourceAgencyId: z.string().uuid().nullable().optional(),
  audienceState: z.string().max(4).nullable().optional(),
});
const ActBody = z.object({ event: z.enum(['submit', 'approve', 'send_back', 'remove', 'restore']), note: z.string().max(500).optional() });
const StateQ = z.enum(['draft', 'in_review', 'live', 'removed']).default('live');

@Controller()
export class LearnController {
  constructor(@Inject(LearnService) private readonly learn: LearnService) {}

  @Get('learn/topics')
  topics() {
    return this.learn.topics();
  }

  @Get('learn/feed')
  feed(@CurrentUser() p: Principal, @Query('offset') offset?: string) {
    return this.learn.forYou(p, Math.max(0, Number(offset) || 0));
  }

  @Get('learn/browse')
  browse(@CurrentUser() p: Principal, @Query(new ZodPipe(Browse)) q: z.infer<typeof Browse>) {
    return this.learn.browse(p, { ...q, topics: csv(q.topics), languages: csv(q.languages), saved: q.saved === '1' || q.saved === 'true' });
  }

  @Get('learn/suggest')
  suggest(@Query('q') q = '') {
    return this.learn.suggest(q);
  }

  @Get('learn/posts/:id')
  post(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.learn.post(p, id);
  }

  @Post('learn/posts/:id/react')
  react(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(React)) b: z.infer<typeof React>) {
    return this.learn.react(p, id, b);
  }

  @Post('learn/posts/:id/quiz')
  quiz(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(Quiz)) b: z.infer<typeof Quiz>) {
    return this.learn.answerQuiz(p, id, b.answers);
  }

  @Get('me/learn/interests')
  interests(@CurrentUser() p: Principal) {
    return this.learn.interests(p);
  }

  @Put('me/learn/interests')
  setInterests(@CurrentUser() p: Principal, @Body(new ZodPipe(Interests)) b: z.infer<typeof Interests>) {
    return this.learn.setInterests(p, b);
  }

  // ---------- platform team (Admin learn feed)
  @Get('admin/learn/posts')
  adminList(@CurrentUser() p: Principal, @Query('state', new ZodPipe(StateQ)) state: z.infer<typeof StateQ>) {
    return this.learn.adminList(p, state);
  }

  @Get('admin/learn/sources')
  sources(@CurrentUser() p: Principal) {
    return this.learn.sources(p);
  }

  @Post('admin/learn/posts')
  create(@CurrentUser() p: Principal, @Body(new ZodPipe(PostBody)) b: z.infer<typeof PostBody>) {
    return this.learn.create(p, b);
  }

  @Patch('admin/learn/posts/:id')
  update(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(PostBody)) b: z.infer<typeof PostBody>) {
    return this.learn.update(p, id, b);
  }

  @Post('admin/learn/posts/:id/actions')
  act(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ActBody)) b: z.infer<typeof ActBody>) {
    return this.learn.act(p, id, b.event, b.note);
  }

  // ---------- agencies (their own posts, in their topics; the platform team reviews)
  @Get('agencies/:agencyId/learn/posts')
  agencyList(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string, @Query('state', new ZodPipe(StateQ)) state: z.infer<typeof StateQ>) {
    return this.learn.adminList(p, state, a);
  }

  @Get('agencies/:agencyId/learn/sources')
  agencySources(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string) {
    return this.learn.sources(p, a);
  }

  @Post('agencies/:agencyId/learn/posts')
  agencyCreate(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string, @Body(new ZodPipe(PostBody)) b: z.infer<typeof PostBody>) {
    return this.learn.create(p, b, a);
  }

  @Patch('agencies/:agencyId/learn/posts/:id')
  agencyUpdate(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(PostBody)) b: z.infer<typeof PostBody>) {
    return this.learn.update(p, id, b, a);
  }

  @Post('agencies/:agencyId/learn/posts/:id/actions')
  agencyAct(@CurrentUser() p: Principal, @Param('agencyId', ParseUUIDPipe) a: string, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ActBody)) b: z.infer<typeof ActBody>) {
    return this.learn.act(p, id, b.event, b.note, a);
  }
}
