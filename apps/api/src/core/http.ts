import { BadRequestException, HttpException, Inject, type PipeTransform, Catch, type ArgumentsHost, type ExceptionFilter, Logger } from '@nestjs/common';
import { Audit } from './audit';
import type { ZodSchema } from 'zod';

/** Validates a body or query with zod and returns field errors in the States doc shape. */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}
  transform(value: unknown): T {
    const r = this.schema.safeParse(value);
    if (r.success) return r.data;
    throw new BadRequestException({
      code: 'validation_failed',
      message: 'Check the highlighted fields.',
      fields: r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }
}

/** Domain error with a stable code; never leaks internals to citizens. */
export class AppError extends HttpException {
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super({ code, message, ...extra }, status);
  }
}

@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('Error');
  constructor(@Inject(Audit) private readonly audit: Audit) {}

  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (err instanceof HttpException) {
      const body = err.getResponse();
      // Audit log "Refused attempts": a signed-in person was refused permission.
      const req = host.switchToHttp().getRequest();
      if (err.getStatus() === 403 && req?.principal?.userId) {
        const role = req.principal.roles?.[0]?.role ?? null;
        void this.audit
          .write({ actorId: req.principal.userId, actorRole: role, action: 'access.refused', entity: 'route', entityId: `${req.method} ${req.route?.path ?? req.path}`, ip: req.ip?.replace(/^::ffff:/, ''), payload: { code: (body as { code?: string })?.code ?? 'forbidden', userAgent: String(req.headers?.['user-agent'] ?? '').slice(0, 200) } })
          .catch((e) => this.log.warn(`audit refused: ${e}`));
      }
      return res.status(err.getStatus()).json(typeof body === 'string' ? { code: 'error', message: body } : body);
    }
    const supportCode = Math.random().toString(36).slice(2, 10).toUpperCase();
    this.log.error(`[${supportCode}] ${(err as Error)?.stack ?? err}`);
    // States doc: say what failed, offer retry, codes only in small text for support.
    return res.status(500).json({ code: 'internal', message: 'Something went wrong. Try again.', supportCode });
  }
}
