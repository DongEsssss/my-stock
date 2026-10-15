// 역할: 토스증권 Open API OAuth2 액세스 토큰 발급/캐싱 및 Rate Limit 헤더를 추적합니다.
import {
  DEFAULT_TIMEOUT_MS,
  RateLimitInfo,
  TOSS_BASE_URL,
} from './toss-type';

/**
 * Next.js 개발 서버의 Hot Reload(HMR) 시에도
 * 토큰 캐시와 호출 한도 정보가 초기화되지 않도록 globalThis에 보관합니다.
 */
const globalForToss = globalThis as unknown as {
  tossTokenCache?: { accessToken: string; expiresAt: number };
  lastRateLimit?: RateLimitInfo;
};

/**
 * 가장 최근 토스 API 응답 헤더에서 읽은 Rate Limit(초당 호출 한도) 정보를 반환합니다.
 */
export function getLastRateLimit(): RateLimitInfo {
  return (
    globalForToss.lastRateLimit ?? {
      limit: '20',
      remaining: '20',
      reset: '1',
    }
  );
}

/**
 * 토스 API HTTP 응답 헤더에서 X-RateLimit-* 값을 추출해 전역 상태를 갱신합니다.
 */
export function updateRateLimitFromHeaders(headers: Headers): void {
  globalForToss.lastRateLimit = {
    limit: headers.get('X-RateLimit-Limit') ?? '20',
    remaining: headers.get('X-RateLimit-Remaining') ?? '19',
    reset: headers.get('X-RateLimit-Reset') ?? '1',
  };
}

/**
 * 토스증권 Open API OAuth2 Client Credentials 토큰을 발급받거나 캐시된 토큰을 반환합니다.
 * @param forceRefresh true일 경우 만료 여부와 무관하게 새 토큰을 강제 재발급합니다 (401 에러 복구용).
 */
export async function getTossAccessToken(forceRefresh = false): Promise<string> {
  const now = Date.now();

  // 만료 60초 전까지는 메모리에 캐시된 토큰을 재사용하여 불필요한 API 호출을 줄입니다.
  if (
    !forceRefresh &&
    globalForToss.tossTokenCache &&
    globalForToss.tossTokenCache.expiresAt - 60_000 > now
  ) {
    return globalForToss.tossTokenCache.accessToken;
  }

  const clientId = process.env.TOSS_CLIENT_ID;
  const clientSecret = process.env.TOSS_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      '.env.local 파일에 TOSS_CLIENT_ID 또는 TOSS_CLIENT_SECRET이 설정되지 않았습니다.'
    );
  }

  const res = await fetch(`${TOSS_BASE_URL}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
    cache: 'no-store',
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`토큰 발급 실패 (${res.status}): ${errText}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    expires_in?: number;
  };

  // 기본 유효기간(86400초 = 24시간) 동안 메모리에 토큰 캐싱
  globalForToss.tossTokenCache = {
    accessToken: data.access_token,
    expiresAt: now + (data.expires_in ?? 86400) * 1000,
  };

  return data.access_token;
}