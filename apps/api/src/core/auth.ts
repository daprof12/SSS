// Bearer-token auth. Tokens are HS256 JWTs for now; production swaps the
// verifier for the OIDC provider (TRD: Keycloak) without touching guards.
import {
  createParamDecorator,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  ForbiddenException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { jwtVerify, SignJWT } from 'jose';
import { mfaRequired, type Role } from '@erp/domain';
import { CONFIG, type AppConfig } from './config';

export interface RoleGrant {
  role: Role;
  scopeType: string;
  scopeId: string | null;
}

export interface Principal {
  userId: string;
  sessionId: string;
  roles: RoleGrant[];
  mfa: boolean;
}

export const PUBLIC = 'erp:public';
export const Public = () => SetMetadata(PUBLIC, true);

@Injectable()
export class TokenService {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  async sign(p: Principal, ttlSeconds = 15 * 60): Promise<string> {
    return new SignJWT({ roles: p.roles, mfa: p.mfa, sid: p.sessionId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(p.userId)
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .setIssuer('erp-api')
      .sign(this.config.jwtSecret);
  }

  async verify(token: string): Promise<Principal> {
    const { payload } = await jwtVerify(token, this.config.jwtSecret, { issuer: 'erp-api', algorithms: ['HS256'] });
    return {
      userId: String(payload.sub),
      sessionId: String(payload.sid),
      roles: (payload.roles as RoleGrant[]) ?? [],
      mfa: Boolean(payload.mfa),
    };
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    // EventSource cannot set headers, so streams may pass the token as a query param.
    const token = header?.startsWith('Bearer ') ? header.slice(7) : typeof req.query?.access_token === 'string' ? req.query.access_token : undefined;
    if (!token) throw new UnauthorizedException('Sign in to continue.');
    let principal: Principal;
    try {
      principal = await this.tokens.verify(token);
    } catch {
      throw new UnauthorizedException('Your session has ended. Sign in again.');
    }
    // Staff must pass two-step login (Public Issues doc §5).
    if (!principal.mfa && principal.roles.some((r) => mfaRequired.has(r.role))) {
      throw new ForbiddenException({ code: 'mfa_required', message: 'Turn on two-step login to continue.' });
    }
    req.principal = principal;
    return true;
  }
}

export const CurrentUser = createParamDecorator((_d: unknown, ctx: ExecutionContext): Principal => {
  return ctx.switchToHttp().getRequest().principal;
});

export function hasRole(p: Principal, role: Role, scopeId?: string | null): boolean {
  return p.roles.some((r) => r.role === role && (scopeId === undefined || r.scopeId === scopeId));
}
