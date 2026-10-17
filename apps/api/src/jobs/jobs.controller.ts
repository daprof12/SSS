import { Controller, Inject, Post } from '@nestjs/common';
import { Audit } from '../core/audit';
import { CurrentUser, hasRole, type Principal } from '../core/auth';
import { CONFIG, type AppConfig } from '../core/config';
import { AppError } from '../core/http';
import { JobsService } from './jobs.service';

@Controller('admin/jobs')
export class JobsController {
  constructor(
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(Audit) private readonly audit: Audit,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** Runs the scheduled rules now. Platform admins only (any signed-in user in local dev). */
  @Post('run')
  async run(@CurrentUser() p: Principal) {
    if (!hasRole(p, 'platform_admin') && !this.config.devTools) throw new AppError(403, 'forbidden', 'Only platform admins can do this.');
    const result = await this.jobs.runAll();
    await this.audit.write({ actorId: p.userId, action: 'jobs.run', entity: 'jobs', payload: result });
    return result;
  }
}
