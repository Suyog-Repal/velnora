/**
 * Backend base-URL resolution for the mobile app. Pure (no React Native imports) so it is unit-tested in Node.
 *
 *  - Production / release builds: set `EXPO_PUBLIC_API_URL=https://<your-backend>` before building. It is inlined into
 *    the JavaScript bundle at build time, so it must NOT contain secrets, and changing it requires a new build.
 *  - Development: leave it unset and the Expo dev-server host (port 8000) is used, or set your own LAN address.
 *  - A release build with no URL has cloud sync disabled (empty base URL): the app still works fully offline and
 *    queued changes stay pending. It never silently talks to localhost.
 */
export const DEFAULT_API_PORT = 8000;

export type ApiUrlSource = 'env' | 'dev-server' | 'localhost' | 'unset';

export interface ApiUrlResolution {
  /** Base URL without a trailing slash; '' means "not configured" (cloud calls fail as an ordinary connection error). */
  url: string;
  source: ApiUrlSource;
  /** Human-readable configuration problem for logs, or null when the configuration is fine. */
  problem: string | null;
}

export function resolveApiUrl(input: { envUrl?: string | null; hostUri?: string | null; isDev: boolean; port?: number }): ApiUrlResolution {
  const port = input.port ?? DEFAULT_API_PORT;
  const env = (input.envUrl ?? '').trim().replace(/\/+$/, '');

  if (env) {
    if (!/^https?:\/\/[^\s/]+/i.test(env)) {
      return { url: '', source: 'env', problem: 'EXPO_PUBLIC_API_URL must start with http:// or https://' };
    }
    if (!input.isDev && /^http:\/\//i.test(env)) {
      return { url: env, source: 'env', problem: 'EXPO_PUBLIC_API_URL uses http://; Android release builds block cleartext traffic, so use https:// for production' };
    }
    return { url: env, source: 'env', problem: null };
  }

  if (input.isDev) {
    const host = input.hostUri?.split(':')[0];
    return host
      ? { url: `http://${host}:${port}`, source: 'dev-server', problem: null }
      : { url: `http://localhost:${port}`, source: 'localhost', problem: null };
  }
  return { url: '', source: 'unset', problem: 'EXPO_PUBLIC_API_URL is not set for this build, so sign-in, account creation and cloud sync are unavailable. Set it to your deployed backend URL and rebuild.' };
}
