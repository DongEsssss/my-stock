// 역할: 캔들 배열 추출, 타임스탬프 변환, 규격 통일, 과거+실시간 캔들 병합을 담당합니다.
import { CandleItem, TossCandleResultObject } from './toss-type';

/**
 * 종목 코드가 국내 주식(6자리 숫자)인지 판별합니다.
 */
export function isKoreanSymbol(rawSymbol: string): boolean {
  const cleanCode = rawSymbol.trim().toUpperCase().replace(/^A/, '');
  return /^\d{6}$/.test(cleanCode);
}

/**
 * 토스 API 응답의 result 필드가 배열이거나 객체({ candles, items, data })일 때
 * 일관되게 캔들 배열(CandleItem[])만 추출합니다.
 */
export function extractCandleArray(
  result: CandleItem[] | TossCandleResultObject | null | undefined
): CandleItem[] {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  return result.candles ?? result.items ?? result.data ?? [];
}

/**
 * 다양한 형태의 캔들 시간 필드(밀리초, 초, ISO 날짜 문자열 등)를
 * 초(seconds) 단위 Unix Timestamp로 일관되게 변환합니다.
 */
export function getCandleTimeSec(item: CandleItem | null | undefined): number {
  if (!item) return 0;

  const raw =
    item.timestamp ??
    item.time ??
    item.dateTime ??
    item.dt ??
    item.date ??
    item.startTime;

  if (typeof raw === 'number') {
    // 10^12보다 크면 밀리초(ms) 단위이므로 1000으로 나누어 초(s) 단위로 맞춥니다.
    return raw > 1e12 ? Math.floor(raw / 1000) : Math.floor(raw);
  }

  if (typeof raw === 'string' && raw.trim()) {
    const num = Number(raw);
    if (!Number.isNaN(num) && num > 0) {
      return num > 1e12 ? Math.floor(num / 1000) : Math.floor(num);
    }
    const parsedMs = Date.parse(raw);
    if (!Number.isNaN(parsedMs)) {
      return Math.floor(parsedMs / 1000);
    }
  }

  return 0;
}

/**
 * 토스 API 응답에서 다음 과거 페이지 조회를 위한 커서(nextBefore) 값을 추출합니다.
 */
export function extractNextCursor(
  resultObj: TossCandleResultObject | CandleItem[] | null | undefined,
  currentList: CandleItem[]
): string | undefined {
  if (resultObj && !Array.isArray(resultObj)) {
    const cursor = resultObj.nextBefore ?? resultObj.nextCursor;
    if (cursor !== undefined && cursor !== null) {
      return String(cursor);
    }
  }

  const lastCandle = currentList[currentList.length - 1];
  const fallbackCursor = lastCandle?.timestamp ?? lastCandle?.dateTime;
  return fallbackCursor !== undefined ? String(fallbackCursor) : undefined;
}

/**
 * 시세 데이터를 토스 API 및 프론트엔드 차트 컴포넌트 양쪽 모두와 100% 호환되는
 * 표준 CandleItem 객체로 생성합니다.
 */
export function createCompatibleCandle(params: {
  timeSec: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}): CandleItem {
  const { timeSec, open, high, low, close, volume } = params;
  const isoString = new Date(timeSec * 1000).toISOString();

  return {
    timestamp: timeSec * 1000,
    time: timeSec,
    dateTime: isoString,
    dt: isoString,
    open,
    high,
    low,
    close,
    volume,
    openPrice: open,
    highPrice: high,
    lowPrice: low,
    closePrice: close,
    accTradeVolume: volume,
  };
}

/**
 * 토스 API의 최신 캔들 배열과 Yahoo Finance의 과거 백필 캔들 배열을
 * 날짜/시간 중복 없이 하나로 병합합니다.
 */
export function mergeBackfillAndTossCandles(
  backfillCandles: CandleItem[],
  tossCandles: CandleItem[],
  interval: string
): CandleItem[] {
  if (backfillCandles.length === 0) return tossCandles;
  if (tossCandles.length === 0) return backfillCandles;

  // 토스 실시간 데이터 중 가장 오래된 캔들의 시각(초)을 찾습니다.
  let oldestTossSec = Infinity;
  for (const candle of tossCandles) {
    const t = getCandleTimeSec(candle);
    if (t > 0 && t < oldestTossSec) {
      oldestTossSec = t;
    }
  }

  // 일봉('1d')은 날짜 중복 방지를 위해 86400초(하루), 분봉은 60초(1분) 여유를 두고 이전 데이터만 필터링합니다.
  const duplicateBufferSec = interval === '1d' ? 86400 : 60;

  const olderBackfill = backfillCandles.filter((candle) => {
    const t = getCandleTimeSec(candle);
    return t > 0 && t < oldestTossSec - duplicateBufferSec;
  });

  return [...olderBackfill, ...tossCandles];
}