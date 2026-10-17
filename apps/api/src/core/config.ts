export interface AppConfig {
  env: 'development' | 'test' | 'production';
  databaseUrl: string;
  jwtSecret: Uint8Array;
  /** Dev-only token issuing and payment simulation. Never on in production. */
  devTools: boolean;
  /** Shared secret the mock Paystack signs webhooks with (Paystack uses the secret key). */
  paystackSecret: string;
  /** Pepper for OTP hashes; a database leak alone cannot reveal codes. */
  otpSecret: string;
  cancelWindowMs: number;
  publicBaseUrl: string;
}

export const CONFIG = Symbol('CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const mode = (env.NODE_ENV ?? 'development') as AppConfig['env'];
  const secret = env.JWT_SECRET ?? (mode === 'production' ? '' : 'local-dev-secret-change-me-32-bytes-min');
  if (secret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  const devTools = mode !== 'production' && env.DEV_TOOLS !== '0';
  if (mode === 'production' && env.DEV_TOOLS === '1') throw new Error('DEV_TOOLS cannot be enabled in production');
  if (mode === 'production' && (env.OTP_SECRET ?? '').length < 32) throw new Error('OTP_SECRET must be at least 32 characters');
  return {
    env: mode,
    databaseUrl: env.DATABASE_URL ?? 'postgres://erp:erp_local_only@localhost:54329/erp',
    jwtSecret: new TextEncoder().encode(secret),
    devTools,
    paystackSecret: env.PAYSTACK_SECRET ?? (mode === 'production' ? '' : 'sk_test_mock'),
    otpSecret: env.OTP_SECRET ?? (mode === 'production' ? '' : 'local-otp-pepper-change-me'),
    cancelWindowMs: Number(env.CANCEL_WINDOW_MS ?? 5000),
    publicBaseUrl: env.PUBLIC_BASE_URL ?? 'http://localhost:4000',
  };
}
