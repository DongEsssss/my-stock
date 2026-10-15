// 역할: 토스 API에 존재하지 않는 과거 구간(2000년~2022년 일봉 및 장기 분봉/시간봉)을
//       무료 Yahoo Finance v8 Chart API로 조회해 이어 붙입니다.
import {
  createCompatibleCandle,
  getCandleTimeSec,
  isKoreanSymbol,
} from './toss-candle-utils';
import {
  CandleItem,
  DEFAULT_TIMEOUT_MS,
  YEAR_2000_UNIX,
} from './toss-type';

/** Yahoo Finance v8 Chart API 응답 내부 구조 타입 */
interface YahooChartResponse {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
      };
    }>;
  };
}

/**
 * 종목 코드를 Yahoo Finance 조회용 심볼 후보 배열로 변환합니다.
 * - 국내 주식(6자리 숫자): 코스피(.KS)를 먼저 시도하고 없으면 코스닥(.KQ)으로 폴백합니다.
 * - 미국 주식: 점(.)을 하이픈(-)으로 변환합니다 (예: BRK.B -> BRK-B).
 */
function getYahooCandidateSymbols(rawSymbol: string): string[] {
  const cleanCode = rawSymbol.trim().toUpperCase().replace(/^A/, '');
  if (isKoreanSymbol(cleanCode)) {
    return [`${cleanCode}.KS`, `${cleanCode}.KQ`];
  }
  return [cleanCode.replace(/\./g, '-')];
}

/**
 * 단일 Yahoo Finance Chart API 쿼리를 호출하여 호환 캔들 배열로 변환합니다.
 */
async function requestSingleYahooChart(
  yahooSymbol: string,
  queryString: string,
  isKR: boolean
): Promise<CandleItem[]> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      yahooSymbol
    )}?${queryString}`;

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        Accept: 'application/json',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });

    if (!res.ok) return [];

    const data = (await res.json()) as YahooChartResponse;
    const result = data.chart?.result?.[0];
    const timestamps = result?.timestamp ?? [];
    const quote = result?.indicators?.quote?.[0] ?? {};

    if (!Array.isArray(timestamps) || timestamps.length === 0) {
      return [];
    }

    const candles: CandleItem[] = [];

    for (let i = 0; i < timestamps.length; i++) {
      const timeSec = Number(timestamps[i]);
      const openRaw = Number(quote.open?.[i] ?? 0);
      const highRaw = Number(quote.high?.[i] ?? 0);
      const lowRaw = Number(quote.low?.[i] ?? 0);
      const closeRaw = Number(quote.close?.[i] ?? 0);
      const volumeRaw = Number(quote.volume?.[i] ?? 0);

      // 결측치(null/0)가 없는 유효한 거래 캔들만 추출합니다.
      if (
        timeSec > 0 &&
        openRaw > 0 &&
        highRaw > 0 &&
        lowRaw > 0 &&
        closeRaw > 0
      ) {
        candles.push(
          createCompatibleCandle({
            timeSec,
            open: isKR ? Math.round(openRaw) : Number(openRaw.toFixed(2)),
            high: isKR ? Math.round(highRaw) : Number(highRaw.toFixed(2)),
            low: isKR ? Math.round(lowRaw) : Number(lowRaw.toFixed(2)),
            close: isKR ? Math.round(closeRaw) : Number(closeRaw.toFixed(2)),
            volume: Math.max(0, Math.round(volumeRaw)),
          })
        );
      }
    }

    return candles;
  } catch {
    return [];
  }
}

/**
 * 종목 코드와 주기에 맞춰 2000년 1월 1일부터 현재까지의 백필 캔들을 조회합니다.
 * - '1d'(24시간 일봉): 2000년~현재 전체 일봉 조회
 * - '1m'(분봉/시간봉): 2000년~2024년(일봉) + 최근 2년(60분봉) + 최근 60일(5분봉) + 최근 7일(1분봉)을 병렬 조회 후 시간순 연결
 */
export async function fetchYahooBackfillCandles(
  rawSymbol: string,
  targetInterval: string
): Promise<CandleItem[]> {
  const isKR = isKoreanSymbol(rawSymbol);
  const candidateSymbols = getYahooCandidateSymbols(rawSymbol);
  const nowSec = Math.floor(Date.now() / 1000);
  const dailyQueryFrom2000 = `period1=${YEAR_2000_UNIX}&period2=${nowSec}&interval=1d&includePrePost=false`;

  for (const yahooSym of candidateSymbols) {
    // 1) 일봉(24시간) 요청일 때: 2000년 1월 1일부터 오늘까지 전체 일봉 반환
    if (targetInterval === '1d') {
      const dailyItems = await requestSingleYahooChart(
        yahooSym,
        dailyQueryFrom2000,
        isKR
      );
      if (dailyItems.length > 0) {
        return dailyItems;
      }
      continue;
    }

    // 2) 분봉/시간봉 요청일 때: 구간별 최대 해상도 데이터를 병렬로 가져와 하나로 이어 붙임
    const [m1Items, m5Items, m60Items, d1Items] = await Promise.all([
      requestSingleYahooChart(
        yahooSym,
        'range=7d&interval=1m&includePrePost=false',
        isKR
      ),
      requestSingleYahooChart(
        yahooSym,
        'range=60d&interval=5m&includePrePost=false',
        isKR
      ),
      requestSingleYahooChart(
        yahooSym,
        'range=730d&interval=60m&includePrePost=false',
        isKR
      ),
      requestSingleYahooChart(yahooSym, dailyQueryFrom2000, isKR),
    ]);

    if (
      m1Items.length > 0 ||
      m5Items.length > 0 ||
      m60Items.length > 0 ||
      d1Items.length > 0
    ) {
      // 각 해상도 구간의 시작 시각을 구해 기간이 겹치지 않도록 시간순으로 이어 붙입니다.
      const oldestM1 =
        m1Items.length > 0 ? getCandleTimeSec(m1Items[0]) : Infinity;
      const oldestM5 =
        m5Items.length > 0 ? getCandleTimeSec(m5Items[0]) : oldestM1;
      const oldestM60 =
        m60Items.length > 0 ? getCandleTimeSec(m60Items[0]) : oldestM5;

      return [
        ...d1Items.filter((c) => getCandleTimeSec(c) < oldestM60 - 86400),
        ...m60Items.filter((c) => getCandleTimeSec(c) < oldestM5),
        ...m5Items.filter((c) => getCandleTimeSec(c) < oldestM1),
        ...m1Items,
      ];
    }
  }

  return [];
}