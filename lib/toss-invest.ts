// 역할: 분리된 인증, 검색, 백필, 유틸리티 모듈을 하나로 조합하여 캔들 데이터를 조회하고,
//       기존 route.ts 등 외부 파일과의 하위 호환성을 위해 모든 함수와 타입을 re-export 합니다.
import {
  getLastRateLimit,
  getTossAccessToken,
  updateRateLimitFromHeaders,
} from './toss-auth';
import {
  extractCandleArray,
  extractNextCursor,
  mergeBackfillAndTossCandles,
} from './toss-candle-utils';
import { searchStocksByQuery } from './stock-search';
import {
  CandleItem,
  DEFAULT_TIMEOUT_MS,
  FetchCandlesParams,
  RateLimitInfo,
  StockInfoItem,
  TOSS_BASE_URL,
  TossCandleResultObject,
} from './toss-type';
import { fetchYahooBackfillCandles } from './yahoo-backfill';

// 기존에 '@/lib/toss-invest'에서 import하던 코드들이 깨지지 않도록 그대로 Re-export 합니다.
export type { CandleItem, FetchCandlesParams, RateLimitInfo, StockInfoItem };
export { getLastRateLimit, getTossAccessToken, searchStocksByQuery };

/**
 * 토스증권 Open API의 `/api/v1/candles` 엔드포인트를 단건 호출하는 내부 헬퍼 함수입니다.
 */
async function requestTossCandlesPage(params: {
  token: string;
  symbol: string;
  interval: string;
  beforeCursor?: string;
}): Promise<Response> {
  const { token, symbol, interval, beforeCursor } = params;

  const query = new URLSearchParams({
    symbol,
    interval,
    count: '200', // 토스 API 1회 최대 허용치인 200개 요청
    ...(beforeCursor ? { before: beforeCursor } : {}),
  });

  const response = await fetch(
    `${TOSS_BASE_URL}/api/v1/candles?${query.toString()}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    }
  );

  // 응답 헤더에서 남은 초당 호출 가능 횟수(Rate Limit) 기록
  updateRateLimitFromHeaders(response.headers);

  return response;
}

/**
 * 메인 차트용 캔들 데이터 조회 함수
 * 1) 전일 종가 계산용 소량 요청(count <= 10)이 아닐 경우, 2000년~현재 과거 백필을 병렬로 시작합니다.
 * 2) 토스증권 Open API에서 최신 실시간 캔들을 페이지네이션(nextBefore)으로 가져옵니다.
 * 3) 과거 백필 캔들과 토스 실시간 캔들을 시간순으로 중복 없이 합쳐 반환합니다.
 */
export async function fetchCandles(params: FetchCandlesParams) {
  const interval = params.interval ?? '1m';
  const requestedCount = Number(params.count ?? '200');

  // 전일대비 등락률 계산용 소량 조회(예: count=5)일 때는 무거운 과거 백필을 생략해 속도를 높입니다.
  const shouldBackfillHistory = !params.before && requestedCount > 10;

  // 1. Yahoo Finance 과거 데이터 백필을 비동기로 먼저 출발시킵니다 (병렬 처리).
  const backfillPromise = shouldBackfillHistory
    ? fetchYahooBackfillCandles(params.symbol, interval)
    : Promise.resolve<CandleItem[]>([]);

  let allTossCandles: CandleItem[] = [];
  let firstResult: TossCandleResultObject | CandleItem[] | null = null;

  // 2. 토스증권 Open API에서 최신 캔들 데이터 조회
  try {
    let token = await getTossAccessToken(false);
    let res = await requestTossCandlesPage({
      token,
      symbol: params.symbol,
      interval,
      beforeCursor: params.before,
    });

    // 토큰 만료(401) 시 즉시 새 토큰을 강제 재발급받아 1회 재시도합니다.
    if (res.status === 401) {
      token = await getTossAccessToken(true);
      res = await requestTossCandlesPage({
        token,
        symbol: params.symbol,
        interval,
        beforeCursor: params.before,
      });
    }

    const json = (await res.json()) as {
      result?: TossCandleResultObject | CandleItem[];
      error?: { message?: string };
    };

    if (!res.ok) {
      throw new Error(json?.error?.message || `캔들 조회 실패 (${res.status})`);
    }

    firstResult = json.result ?? null;
    allTossCandles = [...extractCandleArray(firstResult)];

    // 휴장일 등에 1분봉('1m')이 비어 있으면 일봉('1d')으로 폴백합니다.
    if (allTossCandles.length === 0 && interval === '1m') {
      const fallbackRes = await requestTossCandlesPage({
        token,
        symbol: params.symbol,
        interval: '1d',
      });
      if (fallbackRes.ok) {
        const fallbackJson = (await fallbackRes.json()) as {
          result?: TossCandleResultObject | CandleItem[];
        };
        allTossCandles = [...extractCandleArray(fallbackJson.result)];
      }
    }

    // 최신 구간은 토스 API의 커서(nextBefore)를 따라 추가 페이지를 이어 붙입니다.
    if (allTossCandles.length > 0 && shouldBackfillHistory) {
      let nextCursor = extractNextCursor(firstResult, allTossCandles);
      const maxAdditionalPages = interval === '1m' ? 5 : 3;

      for (let page = 0; page < maxAdditionalPages; page++) {
        if (!nextCursor) break;

        try {
          const moreRes = await requestTossCandlesPage({
            token,
            symbol: params.symbol,
            interval,
            beforeCursor: nextCursor,
          });
          if (!moreRes.ok) break;

          const moreJson = (await moreRes.json()) as {
            result?: TossCandleResultObject | CandleItem[];
          };
          const moreResult = moreJson.result;
          const moreList = extractCandleArray(moreResult);
          if (moreList.length === 0) break;

          allTossCandles.push(...moreList);

          const newCursor = extractNextCursor(moreResult, moreList);
          if (!newCursor || newCursor === nextCursor) break;
          nextCursor = newCursor;
        } catch {
          break;
        }
      }
    }
  } catch (err) {
    console.warn('[Toss Candle Fetch Warning]:', err);
  }

  // 전일 종가 계산용 소량 조회일 경우 백필 없이 토스 결과만 즉시 반환합니다.
  if (!shouldBackfillHistory) {
    return allTossCandles.length > 0 ? allTossCandles : firstResult;
  }

  // 3. 2000년~현재 백필 데이터와 토스 최신 캔들을 병합하여 반환합니다.
  const backfillCandles = await backfillPromise;
  const mergedCandles = mergeBackfillAndTossCandles(
    backfillCandles,
    allTossCandles,
    interval
  );

  return mergedCandles.length > 0 ? mergedCandles : firstResult;
}