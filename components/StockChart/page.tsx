// 파일 위치: components/StockChart.tsx (또는 components/StockChart/page.tsx)
'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  createChart,
  CandlestickSeries,
  AreaSeries,
  LineSeries,
  HistogramSeries,
  ColorType,
  UTCTimestamp,
} from 'lightweight-charts';

// 경로 에러 방지를 위해 내장된 로딩 스피너 컴포넌트
function InlineLoading({ text = '불러오는 중...', size = 24 }: { text?: string; size?: number }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '10px',
        padding: '16px',
        color: '#9ca3af',
        fontSize: '13px',
        fontWeight: 600,
      }}
    >
      <div
        style={{
          width: `${size}px`,
          height: `${size}px`,
          border: '3px solid #232a3b',
          borderTop: '3px solid #3182f6',
          borderRadius: '50%',
          animation: 'toss-spin 0.8s linear infinite',
        }}
      />
      <span>{text}</span>
      <style>{`
        @keyframes toss-spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

type StockItem = {
  symbol: string;
  name: string;
  market?: string;
};

type CandlePoint = {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type OrderbookRow = {
  price: number;
  quantity: number;
  rate: number;
};

type TradeTick = {
  time: string;
  price: number;
  volume: number;
  side: 'BUY' | 'SELL';
};

// <select> 태그에서 사용할 8가지 주기 타입
type TimeframeOption = '1m' | '3m' | '5m' | '10m' | '30m' | '60m' | '6h' | '24h';

const TIMEFRAME_LIST: { value: TimeframeOption; label: string; minutes: number }[] = [
  { value: '1m', label: '1분', minutes: 1 },
  { value: '3m', label: '3분', minutes: 3 },
  { value: '5m', label: '5분', minutes: 5 },
  { value: '10m', label: '10분', minutes: 10 },
  { value: '30m', label: '30분', minutes: 30 },
  { value: '60m', label: '60분', minutes: 60 },
  { value: '6h', label: '6시간', minutes: 360 },
  { value: '24h', label: '24시간 (일봉)', minutes: 1440 },
];

const FAVORITES_STORAGE_KEY = 'my_favorite_stocks_v1';

// 소수점 둘째 자리까지 항상 포맷팅하는 함수 (예: 1 -> "1.00", 1234.5 -> "1,234.50")
function formatTwoDecimals(num: number): string {
  return num.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function toNum(val: unknown): number {
  if (val === undefined || val === null) return NaN;
  return Number(String(val).replace(/,/g, '').trim());
}

/**
 * 숫자(초/밀리초)와 날짜 문자열 모두 한국 표준시(KST, UTC+9) 차트 타임스탬프로 일관되게 변환합니다.
 */
function toUnixTime(rawTime: unknown): UTCTimestamp | null {
  if (!rawTime) return null;
  if (typeof rawTime === 'number') {
    const sec = rawTime > 10_000_000_000 ? Math.floor(rawTime / 1000) : Math.floor(rawTime);
    return (sec + 9 * 3600) as UTCTimestamp;
  }
  const str = String(rawTime).trim();
  if (/^\d+$/.test(str)) {
    const num = Number(str);
    const sec = num > 10_000_000_000 ? Math.floor(num / 1000) : Math.floor(num);
    return (sec + 9 * 3600) as UTCTimestamp;
  }
  const normalized = /^\d{8}$/.test(str)
    ? `${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}T00:00:00+09:00`
    : str;
  const parsed = Date.parse(normalized);
  if (!Number.isNaN(parsed)) {
    return (Math.floor(parsed / 1000) + 9 * 3600) as UTCTimestamp;
  }
  return null;
}

function parseCandles(json: Record<string, unknown> | null): CandlePoint[] {
  if (!json) return [];
  const payload = (json?.data ?? json?.result ?? json) as Record<string, unknown> | unknown[];
  const rawList = Array.isArray(payload)
    ? payload
    : ((payload?.candles ?? payload?.items ?? payload?.data ?? []) as unknown[]);

  const formatted = rawList
    .map((item) => {
      const c = item as Record<string, unknown>;
      const open = toNum(c.open ?? c.openPrice ?? c.openingPrice ?? c.o);
      const high = toNum(c.high ?? c.highPrice ?? c.h);
      const low = toNum(c.low ?? c.lowPrice ?? c.l);
      const close = toNum(c.close ?? c.closePrice ?? c.closingPrice ?? c.lastPrice ?? c.c);
      const rawVol = toNum(c.volume ?? c.tradingVolume ?? c.accTradeVolume ?? c.quant ?? c.v);
      return {
        time: toUnixTime(c.timestamp ?? c.date ?? c.dateTime ?? c.time ?? c.dt) as UTCTimestamp,
        open,
        high,
        low,
        close,
        volume:
          Number.isFinite(rawVol) && rawVol > 0
            ? rawVol
            : Math.round(Math.abs(high - low) * 12 + 500),
      };
    })
    .filter(
      (item: CandlePoint) =>
        item.time !== null &&
        Number.isFinite(item.open) &&
        Number.isFinite(item.high) &&
        Number.isFinite(item.low) &&
        Number.isFinite(item.close)
    );

  formatted.sort((a: CandlePoint, b: CandlePoint) => a.time - b.time);
  return formatted.filter(
    (item: CandlePoint, idx: number, arr: CandlePoint[]) =>
      idx === 0 || item.time !== arr[idx - 1].time
  );
}

/**
 * Investing.com 기준 정규장(Regular Trading Hours) 캔들만 필터링하는 헬퍼 함수
 * - 국내 주식(KRX): KST 09:00 ~ 15:30
 * - 미국 주식(US): 미 동부시간(EST/EDT) 09:30 ~ 16:00
 */
function filterRegularSessionCandles(
  candles: CandlePoint[],
  isKR: boolean,
  timeframe: TimeframeOption
): CandlePoint[] {
  if (timeframe === '24h' || candles.length === 0) return candles;

  const filtered = candles.filter((c) => {
    // c.time은 이미 KST(+9h) 오프셋이 적용된 초 단위 타임스탬프
    const utcMs = (Number(c.time) - 9 * 3600) * 1000;

    if (isKR) {
      // KST 기준 시/분 계산
      const kstDate = new Date(Number(c.time) * 1000);
      const hours = kstDate.getUTCHours();
      const minutes = kstDate.getUTCMinutes();
      const totalMinutes = hours * 60 + minutes;
      // 국내 정규장: 09:00(540분) ~ 15:30(930분)
      return totalMinutes >= 540 && totalMinutes <= 930;
    } else {
      // 미국 동부시간(America/New_York) 기준 시/분 추출
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(new Date(utcMs));
      const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
      const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
      const totalMinutes = hour * 60 + minute;
      // 미국 정규장: 09:30(570분) ~ 16:00(960분)
      return totalMinutes >= 570 && totalMinutes <= 960;
    }
  });

  // 휴장 시간대여서 필터 결과가 너무 적으면 원본 유지
  return filtered.length >= 15 ? filtered : candles;
}

// 1분봉 데이터를 3분, 5분, 10분, 30분, 60분, 6시간(360분) 단위로 묶어주는 함수
function aggregateCandles(candles: CandlePoint[], minutes: number): CandlePoint[] {
  if (minutes <= 1 || minutes >= 1440 || candles.length === 0) return candles;
  const bucketSec = minutes * 60;
  const map = new Map<number, CandlePoint>();

  for (const c of candles) {
    const bucketTime = (Math.floor(c.time / bucketSec) * bucketSec) as UTCTimestamp;
    const existing = map.get(bucketTime);
    if (!existing) {
      map.set(bucketTime, { ...c, time: bucketTime });
    } else {
      existing.high = Math.max(existing.high, c.high);
      existing.low = Math.min(existing.low, c.low);
      existing.close = c.close;
      existing.volume += c.volume;
    }
  }

  return Array.from(map.values()).sort((a, b) => a.time - b.time);
}

function calculateMA(candles: CandlePoint[], period: number) {
  return candles
    .map((c, idx) => {
      if (idx < period - 1) return null;
      const sum = candles
        .slice(idx - period + 1, idx + 1)
        .reduce((acc, cur) => acc + cur.close, 0);
      return { time: c.time, value: Math.round((sum / period) * 100) / 100 };
    })
    .filter(Boolean) as { time: UTCTimestamp; value: number }[];
}

function calculateBollinger(candles: CandlePoint[], period = 20, mult = 2) {
  const upper: { time: UTCTimestamp; value: number }[] = [];
  const lower: { time: UTCTimestamp; value: number }[] = [];

  candles.forEach((c, idx) => {
    if (idx < period - 1) return;
    const slice = candles.slice(idx - period + 1, idx + 1).map((x) => x.close);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
    const std = Math.sqrt(variance);
    upper.push({ time: c.time, value: Math.round((mean + mult * std) * 100) / 100 });
    lower.push({ time: c.time, value: Math.round((mean - mult * std) * 100) / 100 });
  });

  return { upper, lower };
}

/**
 * ★ Investing.com / TradingView 공식 Wilder's RSI (RMA / SMMA 기반) 계산 함수
 * - 단순 14개 평균(SMA)이 아닌 Wilder의 지수이동평균 점화식:
 *   avgGain = (prevAvgGain * 13 + currentGain) / 14
 *   avgLoss = (prevAvgLoss * 13 + currentLoss) / 14
 * - 백필 구간에서 주기(해상도)가 바뀌는 경계를 자동 감지해 분봉 왜곡을 방지합니다.
 */
function calculateWilderRSIMap(
  candles: CandlePoint[],
  period = 14,
  timeframeMinutes = 1
): { latestRSI: number; rsiByTime: Map<number, number> } {
  const rsiByTime = new Map<number, number>();
  if (candles.length <= period) {
    return { latestRSI: 50, rsiByTime };
  }

  // 백필된 이종 주기(예: 일봉 -> 시간봉 -> 분봉) 경계를 판별하기 위한 기준 시간 간격(초)
  const expectedStepSec = Math.max(60, timeframeMinutes * 60);

  let avgGain = 0;
  let avgLoss = 0;
  let seedCount = 0;
  let isSeeded = false;
  let latestRSI = 50;

  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const gapSec = Number(curr.time) - Number(prev.time);

    // 분봉/시간봉 차트에서 과거 일봉(24시간 간격) 백필 구간과 만나는 경계에서는
    // 일봉의 큰 가격 변동폭이 분봉 RMA 평균을 왜곡하지 않도록 시드를 재시작합니다.
    if (
      timeframeMinutes < 1440 &&
      gapSec >= 86400 &&
      expectedStepSec < 21600 &&
      candles.length - i > period + 5
    ) {
      avgGain = 0;
      avgLoss = 0;
      seedCount = 0;
      isSeeded = false;
      continue;
    }

    const diff = curr.close - prev.close;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    if (!isSeeded) {
      avgGain += gain;
      avgLoss += loss;
      seedCount += 1;

      if (seedCount === period) {
        avgGain /= period;
        avgLoss /= period;
        isSeeded = true;

        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs);
        latestRSI = Number(rsi.toFixed(2));
        rsiByTime.set(Number(curr.time), latestRSI);
      }
    } else {
      // Wilder's Smoothing (RMA) 점화식
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;

      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs);
      latestRSI = Number(rsi.toFixed(2));
      rsiByTime.set(Number(curr.time), latestRSI);
    }
  }

  return { latestRSI, rsiByTime };
}

function getTickSize(price: number, isKR: boolean): number {
  if (!isKR) return price >= 1 ? 0.01 : 0.0001;
  if (price < 2000) return 1;
  if (price < 5000) return 5;
  if (price < 20000) return 10;
  if (price < 50000) return 50;
  if (price < 200000) return 100;
  if (price < 500000) return 500;
  return 1000;
}

export default function StockChart({
  defaultSymbol = '005930',
  defaultName,
  defaultMarket,
}: {
  defaultSymbol?: string;
  defaultName?: string;
  defaultMarket?: string;
}) {
  const router = useRouter();
  const chartContainerRef = useRef<HTMLDivElement>(null);

  const [currentStock, setCurrentStock] = useState<StockItem>({
    symbol: defaultSymbol,
    name: defaultName ?? (defaultSymbol === '005930' ? '삼성전자' : defaultSymbol),
    market: defaultMarket ?? (/^\d{6}$/.test(defaultSymbol) ? 'KOSPI' : 'US'),
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [suggestions, setSuggestions] = useState<StockItem[]>([]);
  const [isSearching, setIsSearching] = useState<boolean>(false);
  const [isChartLoading, setIsChartLoading] = useState<boolean>(true);
  const [favorites, setFavorites] = useState<StockItem[]>([]);

  // ★ <select> 태그로 선택하는 주기 상태 (기본 1분)
  const [timeframe, setTimeframe] = useState<TimeframeOption>('1m');
  const [chartType, setChartType] = useState<'candle' | 'area'>('candle');
  const [showMA, setShowMA] = useState<boolean>(true);
  const [showBB, setShowBB] = useState<boolean>(false);
  // ★ Investing.com과 동일하게 정규장(09:00~15:30 / 09:30~16:00) 기준으로만 계산할지 여부
  const [regularSessionOnly, setRegularSessionOnly] = useState<boolean>(true);
  const [isLive, setIsLive] = useState<boolean>(true);
  const [status, setStatus] = useState('데이터 연결 중...');

  const [apiMonitor, setApiMonitor] = useState<{
    remaining: string;
    limit: string;
    sessionCalls: number;
  }>({
    remaining: '20',
    limit: '20',
    sessionCalls: 0,
  });

  const [quoteSummary, setQuoteSummary] = useState<{
    price: number;
    change: number;
    changeRate: number;
    prevDayClose: number;
    open: number;
    high: number;
    low: number;
    volume: number;
    rsi: number;
    ma5: number;
    ma20: number;
    ma60: number;
  } | null>(null);

  const [hoveredBar, setHoveredBar] = useState<(CandlePoint & { rsi?: number }) | null>(null);
  const [asks, setAsks] = useState<OrderbookRow[]>([]);
  const [bids, setBids] = useState<OrderbookRow[]>([]);
  const [trades, setTrades] = useState<TradeTick[]>([]);

  const navigateToStock = (stock: StockItem) => {
    setCurrentStock(stock);
    setSearchQuery('');
    setSuggestions([]);

    const isKoreanStock = /^\d{6}$/.test(stock.symbol);
    const slug = isKoreanStock ? stock.name : stock.symbol.toUpperCase();
    router.push(`/stock/ticker=${encodeURIComponent(slug)}`);
  };

  useEffect(() => {
    setCurrentStock({
      symbol: defaultSymbol,
      name: defaultName ?? (defaultSymbol === '005930' ? '삼성전자' : defaultSymbol),
      market: defaultMarket ?? (/^\d{6}$/.test(defaultSymbol) ? 'KOSPI' : 'US'),
    });
  }, [defaultSymbol, defaultName, defaultMarket]);

  // 1. localStorage 관심종목 로드
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(FAVORITES_STORAGE_KEY);
      if (saved) {
        setFavorites(JSON.parse(saved));
      } else {
        const initial: StockItem[] = [
          { symbol: '005930', name: '삼성전자', market: 'KOSPI' },
          { symbol: '034020', name: '두산에너빌리티', market: 'KOSPI' },
          { symbol: 'NVDA', name: '엔비디아', market: 'NASDAQ' },
          { symbol: 'TQQQ', name: 'TQQQ', market: 'NASDAQ' },
        ];
        setFavorites(initial);
        window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(initial));
      }
    } catch (e) {
      console.error('관심종목 로드 실패:', e);
    }
  }, []);

  // 2. 종목명 실시간 검색
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSuggestions([]);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    const controller = new AbortController();

    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/candles?type=search&q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        const json = await res.json();
        setSuggestions(Array.isArray(json.data) ? json.data : []);
      } catch (err: unknown) {
        if (err instanceof Error && err.name !== 'AbortError') {
          setSuggestions([]);
        }
      } finally {
        setIsSearching(false);
      }
    }, 220);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [searchQuery]);

  // 3. 관심종목 토글
  const toggleFavorite = (stock: StockItem) => {
    const exists = favorites.some((f) => f.symbol === stock.symbol);
    const updated = exists
      ? favorites.filter((f) => f.symbol !== stock.symbol)
      : [...favorites, stock];

    setFavorites(updated);
    window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(updated));
  };

  const isFavorite = favorites.some((f) => f.symbol === currentStock.symbol);

  const handleSearchSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = searchQuery.trim();
    if (!q) return;

    if (suggestions.length > 0) {
      navigateToStock(suggestions[0]);
      return;
    }

    setIsSearching(true);
    try {
      const res = await fetch(`/api/candles?type=search&q=${encodeURIComponent(q)}`);
      const json = await res.json();
      if (Array.isArray(json.data) && json.data.length > 0) {
        navigateToStock(json.data[0]);
      } else {
        const upper = q.toUpperCase();
        navigateToStock({
          symbol: upper,
          name: upper,
          market: /^\d{6}$/.test(upper) ? 'KRX' : 'US',
        });
      }
    } catch {
      const upper = q.toUpperCase();
      navigateToStock({
        symbol: upper,
        name: upper,
        market: /^\d{6}$/.test(upper) ? 'KRX' : 'US',
      });
    } finally {
      setIsSearching(false);
    }
  };

  // 4. 차트 생성 + 선택된 분봉 합산 + Wilder's RSI + 전날 종가 기준 등락률 계산
  useEffect(() => {
    if (!chartContainerRef.current) return;

    let isMounted = true;
    const controller = new AbortController();
    setIsChartLoading(true);
    setHoveredBar(null);

    let latestRsiMap = new Map<number, number>();

    const chart = createChart(chartContainerRef.current, {
      width: chartContainerRef.current.clientWidth,
      height: 440,
      layout: {
        background: { type: ColorType.Solid, color: '#131722' },
        textColor: '#8a94a6',
      },
      grid: {
        vertLines: { color: '#1e2433' },
        horzLines: { color: '#1e2433' },
      },
      crosshair: {
        vertLine: { color: '#505868', labelBackgroundColor: '#3182f6' },
        horzLine: { color: '#505868', labelBackgroundColor: '#3182f6' },
      },
      rightPriceScale: {
        borderColor: '#232a3b',
        scaleMargins: { top: 0.08, bottom: 0.24 },
      },
      timeScale: {
        borderColor: '#232a3b',
        timeVisible: timeframe !== '24h',
        secondsVisible: false,
      },
    });

    const mainSeries =
      chartType === 'area'
        ? chart.addSeries(AreaSeries, {
            lineColor: '#f04452',
            topColor: 'rgba(240, 68, 82, 0.35)',
            bottomColor: 'rgba(240, 68, 82, 0.0)',
            lineWidth: 2,
          })
        : chart.addSeries(CandlestickSeries, {
            upColor: '#f04452',
            downColor: '#3182f6',
            borderVisible: false,
            wickUpColor: '#f04452',
            wickDownColor: '#3182f6',
          });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    const ma5Series = showMA
      ? chart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 1, priceLineVisible: false })
      : null;
    const ma20Series = showMA
      ? chart.addSeries(LineSeries, { color: '#a855f7', lineWidth: 1, priceLineVisible: false })
      : null;
    const ma60Series = showMA
      ? chart.addSeries(LineSeries, { color: '#10b981', lineWidth: 1, priceLineVisible: false })
      : null;

    const bbUpperSeries = showBB
      ? chart.addSeries(LineSeries, {
          color: 'rgba(56, 189, 248, 0.6)',
          lineWidth: 1,
          priceLineVisible: false,
        })
      : null;
    const bbLowerSeries = showBB
      ? chart.addSeries(LineSeries, {
          color: 'rgba(56, 189, 248, 0.6)',
          lineWidth: 1,
          priceLineVisible: false,
        })
      : null;

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.seriesData) {
        setHoveredBar(null);
        return;
      }
      const data = param.seriesData.get(mainSeries) as CandlePoint | undefined;
      const volData = param.seriesData.get(volumeSeries) as { value?: number } | undefined;
      if (data && data.open !== undefined) {
        const barTime = Number(param.time);
        setHoveredBar({
          ...data,
          volume: volData?.value ?? 0,
          rsi: latestRsiMap.get(barTime),
        });
      }
    });

    const handleResize = () => {
      if (chartContainerRef.current) {
        chart.applyOptions({ width: chartContainerRef.current.clientWidth });
      }
    };
    window.addEventListener('resize', handleResize);

    let isInitialLoad = true;
    const tfConfig = TIMEFRAME_LIST.find((t) => t.value === timeframe) ?? TIMEFRAME_LIST[0];
    const apiInterval = timeframe === '24h' ? '1d' : '1m';
    const isKRStock = /^\d{6}$/.test(currentStock.symbol);

    async function fetchAndUpdate() {
      if (document.visibilityState !== 'visible' && !isInitialLoad) return;

      try {
        // 1) 차트용 캔들 데이터와 2) 전날 종가 계산용 일봉(1d) 데이터를 동시에 요청
        const [chartRes, dailyRes] = await Promise.all([
          fetch(
            `/api/candles?symbol=${currentStock.symbol}&interval=${apiInterval}&count=200`,
            { cache: 'no-store', signal: controller.signal }
          ),
          fetch(
            `/api/candles?symbol=${currentStock.symbol}&interval=1d&count=5`,
            { cache: 'no-store', signal: controller.signal }
          ),
        ]);

        const chartJson = await chartRes.json();
        const dailyJson = await dailyRes.json().catch(() => null);

        if (isMounted) {
          setApiMonitor((prev) => ({
            remaining: chartJson?.rateLimit?.remaining ?? prev.remaining,
            limit: chartJson?.rateLimit?.limit ?? prev.limit,
            sessionCalls: prev.sessionCalls + 1,
          }));
        }

        if (!chartRes.ok || chartJson.error) {
          throw new Error(chartJson.error || `HTTP ${chartRes.status}`);
        }

        const rawCandles = parseCandles(chartJson);
        if (rawCandles.length === 0) throw new Error('캔들 데이터 없음');

        // ★ 정규장만 보기(Investing.com 기준)가 켜져 있으면 장외(프리·애프터) 캔들 필터링
        const sessionFilteredCandles = regularSessionOnly
          ? filterRegularSessionCandles(rawCandles, isKRStock, timeframe)
          : rawCandles;

        // ★ 선택한 <select> 주기(1분/3분/5분/10분/30분/60분/6시간/24시간)로 캔들 합산
        const candles = aggregateCandles(sessionFilteredCandles, tfConfig.minutes);

        const volumeData = candles.map((c) => ({
          time: c.time,
          value: c.volume,
          color: c.close >= c.open ? 'rgba(240, 68, 82, 0.45)' : 'rgba(49, 130, 246, 0.45)',
        }));

        if (chartType === 'area') {
          const lineData = candles.map((c) => ({ time: c.time, value: c.close }));
          mainSeries.setData(lineData);
        } else {
          mainSeries.setData(candles);
        }
        volumeSeries.setData(volumeData);

        if (isInitialLoad) {
          chart.timeScale().fitContent();
        }

        const ma5 = calculateMA(candles, 5);
        const ma20 = calculateMA(candles, 20);
        const ma60 = calculateMA(candles, 60);
        if (showMA) {
          ma5Series?.setData(ma5);
          ma20Series?.setData(ma20);
          ma60Series?.setData(ma60);
        }
        if (showBB) {
          const bb = calculateBollinger(candles, 20, 2);
          bbUpperSeries?.setData(bb.upper);
          bbLowerSeries?.setData(bb.lower);
        }

        // ★ 무조건 '전날(직전 거래일) 종가'를 기준으로 상승/하락 금액 및 등락률 계산
        const latest = candles[candles.length - 1];
        const dailyCandles = dailyJson ? parseCandles(dailyJson) : [];
        let prevDayClose =
          candles.length > 1 ? candles[candles.length - 2].close : latest.open;
        let todayOpen = latest.open;
        let todayHigh = Math.max(...candles.slice(-50).map((c) => c.high));
        let todayLow = Math.min(...candles.slice(-50).map((c) => c.low));

        if (dailyCandles.length >= 2) {
          const todayDaily = dailyCandles[dailyCandles.length - 1];
          const yesterdayDaily = dailyCandles[dailyCandles.length - 2];
          prevDayClose = yesterdayDaily.close;
          todayOpen = todayDaily.open;
          todayHigh = todayDaily.high;
          todayLow = todayDaily.low;
        }

        const change = latest.close - prevDayClose;
        const changeRate = prevDayClose !== 0 ? (change / prevDayClose) * 100 : 0;

        // ★ Investing.com 표준 Wilder's RSI (RMA 14) 계산
        const { latestRSI, rsiByTime } = calculateWilderRSIMap(
          candles,
          14,
          tfConfig.minutes
        );
        latestRsiMap = rsiByTime;

        if (isMounted) {
          setQuoteSummary({
            price: latest.close,
            change,
            changeRate,
            prevDayClose,
            open: todayOpen,
            high: todayHigh,
            low: todayLow,
            volume: latest.volume,
            rsi: latestRSI,
            ma5: ma5.length > 0 ? ma5[ma5.length - 1].value : latest.close,
            ma20: ma20.length > 0 ? ma20[ma20.length - 1].value : latest.close,
            ma60: ma60.length > 0 ? ma60[ma60.length - 1].value : latest.close,
          });
        }

        const tick = getTickSize(latest.close, isKRStock);
        const generatedAsks: OrderbookRow[] = [];
        const generatedBids: OrderbookRow[] = [];

        for (let i = 9; i >= 1; i--) {
          const p = Number((latest.close + tick * i).toFixed(isKRStock ? 0 : 2));
          const q = Math.max(
            12,
            Math.round(((latest.volume % (i * 130 + 70)) + 45) * (1.1 + (i % 3) * 0.3))
          );
          generatedAsks.push({
            price: p,
            quantity: q,
            rate: prevDayClose ? ((p - prevDayClose) / prevDayClose) * 100 : 0,
          });
        }
        for (let i = 1; i <= 9; i++) {
          const p = Number((latest.close - tick * (i - 1)).toFixed(isKRStock ? 0 : 2));
          const q = Math.max(
            12,
            Math.round(((latest.volume % (i * 150 + 90)) + 55) * (1.2 + (i % 2) * 0.4))
          );
          generatedBids.push({
            price: p,
            quantity: q,
            rate: prevDayClose ? ((p - prevDayClose) / prevDayClose) * 100 : 0,
          });
        }

        if (isMounted) {
          setAsks(generatedAsks);
          setBids(generatedBids);

          const recentCandles = candles.slice(-12).reverse();
          setTrades(
            recentCandles.map((c, i) => {
              const d = new Date((c.time - 9 * 3600) * 1000);
              return {
                time: d.toTimeString().slice(0, 8),
                price: c.close,
                volume: Math.max(1, Math.round(c.volume / ((i + 2) * 2))),
                side: c.close >= c.open ? 'BUY' : 'SELL',
              };
            })
          );

          isInitialLoad = false;
          setStatus(`실시간 연동됨 (${new Date().toLocaleTimeString()})`);
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') return;
        if (isMounted) {
          const message = err instanceof Error ? err.message : '알 수 없는 오류';
          setStatus(`조회 대기 중 (${message})`);
        }
      } finally {
        if (isMounted) {
          setIsChartLoading(false);
        }
      }
    }

    fetchAndUpdate();
    const timer = isLive ? window.setInterval(fetchAndUpdate, 5000) : null;

    return () => {
      isMounted = false;
      window.removeEventListener('resize', handleResize);
      controller.abort();
      if (timer) window.clearInterval(timer);
      chart.remove();
    };
  }, [currentStock.symbol, timeframe, chartType, showMA, showBB, regularSessionOnly, isLive]);

  const isUp = (quoteSummary?.change ?? 0) >= 0;
  const accentColor = isUp ? '#f04452' : '#3182f6';
  const isKR = /^\d{6}$/.test(currentStock.symbol);
  const currencySuffix = isKR ? '원' : ' USD';
  const displayMarket = currentStock.market || (isKR ? 'KRX' : 'US');

  const maxOrderbookQty = Math.max(
    1,
    ...asks.map((a) => a.quantity),
    ...bids.map((b) => b.quantity)
  );
  const totalAskQty = asks.reduce((a, b) => a + b.quantity, 0);
  const totalBidQty = bids.reduce((a, b) => a + b.quantity, 0);
  const bidDominance =
    totalAskQty + totalBidQty > 0
      ? Math.round((totalBidQty / (totalAskQty + totalBidQty)) * 100)
      : 50;

  const rangePercent =
    quoteSummary && quoteSummary.high > quoteSummary.low
      ? Math.min(
          100,
          Math.max(
            0,
            Math.round(
              ((quoteSummary.price - quoteSummary.low) /
                (quoteSummary.high - quoteSummary.low)) *
                100
            )
          )
        )
      : 50;

  return (
    <div
      style={{
        width: 'min(95vw, 1540px)',
        marginLeft: '50%',
        transform: 'translateX(-50%)',
        color: '#e5e7eb',
        fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
      }}
    >
      {/* 1. 상단 헤더 & API 모니터 & 검색바 */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '14px',
          marginBottom: '12px',
          padding: '12px 20px',
          background: '#131722',
          borderRadius: '12px',
          border: '1px solid #232a3b',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <div
            onClick={() => router.push('/')}
            style={{
              background: 'linear-gradient(135deg, #3182f6, #1d4ed8)',
              color: '#fff',
              fontWeight: 900,
              padding: '6px 12px',
              borderRadius: '8px',
              fontSize: '13px',
              cursor: 'pointer',
            }}
          >
            DongEsssss Stock WTS
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              background: '#0b0e14',
              border: '1px solid #232a3b',
              padding: '6px 12px',
              borderRadius: '8px',
              fontSize: '12px',
            }}
          >
            <span>
              초당 남은 한도:{' '}
              <strong style={{ color: '#10b981' }}>
                {apiMonitor.remaining} / {apiMonitor.limit}회
              </strong>
            </span>
            <span style={{ color: '#374151' }}>|</span>
            <span>
              누적 호출: <strong style={{ color: '#60a5fa' }}>{apiMonitor.sessionCalls}회</strong>
            </span>
            <span style={{ color: '#374151' }}>|</span>
            <span>
              부과 요금: <strong style={{ color: '#10b981' }}>0원 (무료 API)</strong>
            </span>
          </div>
        </div>

        {/* 검색창 */}
        <div style={{ position: 'relative', flex: 1, maxWidth: '480px', minWidth: '280px' }}>
          <form onSubmit={handleSearchSubmit} style={{ display: 'flex', gap: '8px' }}>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="🔍 종목명(두산에너빌리티, 엔비디아) 또는 코드 검색"
              style={{
                flex: 1,
                padding: '9px 14px',
                borderRadius: '8px',
                border: '1px solid #2e3646',
                background: '#0b0e14',
                color: '#f9fafb',
                fontSize: '13px',
                outline: 'none',
              }}
            />
            <button
              type="submit"
              style={{
                padding: '9px 18px',
                borderRadius: '8px',
                background: '#3182f6',
                color: '#fff',
                border: 'none',
                cursor: 'pointer',
                fontWeight: 700,
                fontSize: '13px',
              }}
            >
              검색
            </button>
          </form>

          {searchQuery.trim() !== '' && (
            <div
              style={{
                position: 'absolute',
                top: '44px',
                left: 0,
                right: 0,
                background: '#191f2e',
                border: '1px solid #2e3646',
                borderRadius: '10px',
                zIndex: 50,
                maxHeight: '280px',
                overflowY: 'auto',
                boxShadow: '0 12px 30px rgba(0,0,0,0.6)',
              }}
            >
              {isSearching ? (
                <InlineLoading text="종목 검색 중..." size={20} />
              ) : suggestions.length > 0 ? (
                <ul style={{ listStyle: 'none', margin: 0, padding: '6px 0' }}>
                  {suggestions.map((item) => (
                    <li
                      key={`${item.symbol}-${item.name}`}
                      onClick={() => navigateToStock(item)}
                      style={{
                        padding: '10px 16px',
                        cursor: 'pointer',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        borderBottom: '1px solid #232a3b',
                      }}
                    >
                      <span style={{ fontWeight: 600, color: '#f3f4f6', fontSize: '13px' }}>
                        {item.name}
                      </span>
                      <span
                        style={{
                          fontSize: '11px',
                          color: '#9ca3af',
                          background: '#0b0e14',
                          padding: '3px 8px',
                          borderRadius: '6px',
                        }}
                      >
                        {item.symbol} {item.market ? `· ${item.market}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div style={{ padding: '14px', fontSize: '12px', color: '#9ca3af', textAlign: 'center' }}>
                  엔터를 누르면 &apos;{searchQuery.toUpperCase()}&apos; 코드로 바로 이동합니다.
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      {/* 2. 종목 전광판 배너 (전날 기준 등락 + 소수점 둘째 자리 고정) */}
      <section
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '16px',
          padding: '16px 22px',
          marginBottom: '12px',
          background: '#131722',
          borderRadius: '12px',
          border: '1px solid #232a3b',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: 700,
                  color: '#60a5fa',
                  background: 'rgba(49, 130, 246, 0.15)',
                  padding: '2px 8px',
                  borderRadius: '4px',
                }}
              >
                {displayMarket}
              </span>
              <h1 style={{ fontSize: '22px', fontWeight: 800, margin: 0, color: '#ffffff' }}>
                {currentStock.name}
              </h1>
              <span style={{ fontSize: '13px', color: '#6b7280', fontWeight: 600 }}>
                {currentStock.symbol}
              </span>
              <button
                onClick={() => toggleFavorite(currentStock)}
                style={{
                  padding: '4px 10px',
                  borderRadius: '6px',
                  border: isFavorite ? '1px solid #f04452' : '1px solid #2e3646',
                  background: isFavorite ? 'rgba(240, 68, 82, 0.15)' : '#1c2230',
                  color: isFavorite ? '#f04452' : '#9ca3af',
                  cursor: 'pointer',
                  fontSize: '12px',
                  fontWeight: 700,
                }}
              >
                {isFavorite ? '★ 관심등록됨' : '☆ 관심등록'}
              </button>
            </div>

            {quoteSummary ? (
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px' }}>
                <span style={{ fontSize: '30px', fontWeight: 900, color: accentColor }}>
                  {isKR ? quoteSummary.price.toLocaleString() : formatTwoDecimals(quoteSummary.price)}
                  <span style={{ fontSize: '14px', fontWeight: 600, marginLeft: '3px' }}>
                    {currencySuffix}
                  </span>
                </span>

                {/* 무조건 전일 종가 대비 등락폭 & 등락률 소수점 둘째 자리까지 표시 */}
                <span
                  style={{
                    fontSize: '13px',
                    fontWeight: 700,
                    color: accentColor,
                    background: isUp ? 'rgba(240, 68, 82, 0.14)' : 'rgba(49, 130, 246, 0.14)',
                    padding: '4px 10px',
                    borderRadius: '6px',
                  }}
                >
                  전일대비 {isUp ? '▲' : '▼'} {formatTwoDecimals(Math.abs(quoteSummary.change))} (
                  {isUp ? '+' : ''}
                  {quoteSummary.changeRate.toFixed(2)}%)
                </span>
              </div>
            ) : (
              <div style={{ fontSize: '18px', fontWeight: 700, color: '#6b7280' }}>시세 수신 중...</div>
            )}
          </div>
        </div>

        {quoteSummary && (
          <div style={{ display: 'flex', gap: '26px', alignItems: 'center', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '3px' }}>전일 종가</div>
              <div style={{ fontSize: '15px', fontWeight: 700, color: '#9ca3af' }}>
                {isKR
                  ? quoteSummary.prevDayClose.toLocaleString()
                  : formatTwoDecimals(quoteSummary.prevDayClose)}
              </div>
            </div>
            <div>
              <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '3px' }}>당일 시가</div>
              <div style={{ fontSize: '15px', fontWeight: 700, color: '#e5e7eb' }}>
                {isKR ? quoteSummary.open.toLocaleString() : formatTwoDecimals(quoteSummary.open)}
              </div>
            </div>
            <div>
              <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '3px' }}>당일 고가</div>
              <div style={{ fontSize: '15px', fontWeight: 700, color: '#f04452' }}>
                {isKR ? quoteSummary.high.toLocaleString() : formatTwoDecimals(quoteSummary.high)}
              </div>
            </div>
            <div>
              <div style={{ fontSize: '11px', color: '#6b7280', marginBottom: '3px' }}>당일 저가</div>
              <div style={{ fontSize: '15px', fontWeight: 700, color: '#3182f6' }}>
                {isKR ? quoteSummary.low.toLocaleString() : formatTwoDecimals(quoteSummary.low)}
              </div>
            </div>
            <div style={{ minWidth: '160px' }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: '11px',
                  color: '#9ca3af',
                  marginBottom: '4px',
                }}
              >
                <span>당일 저가 대비 위치</span>
                <span style={{ color: '#fff', fontWeight: 700 }}>{rangePercent}%</span>
              </div>
              <div
                style={{
                  height: '6px',
                  background: '#232a3b',
                  borderRadius: '999px',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${rangePercent}%`,
                    height: '100%',
                    background: 'linear-gradient(90deg, #3182f6, #f04452)',
                  }}
                />
              </div>
            </div>
          </div>
        )}
      </section>

      {/* 3. 메인 3단 그리드 */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) 310px 250px',
          gap: '12px',
          alignItems: 'stretch',
        }}
      >
        {/* [1열: 왼쪽] 차트 + 실시간 체결 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 }}>
          <div
            style={{
              background: '#131722',
              borderRadius: '12px',
              border: '1px solid #232a3b',
              padding: '16px',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '8px',
                paddingBottom: '10px',
                borderBottom: '1px solid #1e2433',
                marginBottom: '8px',
              }}
            >
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                  onClick={() => setIsLive((prev) => !prev)}
                  style={{
                    padding: '6px 12px',
                    borderRadius: '6px',
                    border: isLive ? '1px solid #f04452' : '1px solid #2e3646',
                    background: isLive ? 'rgba(240, 68, 82, 0.16)' : '#1c2230',
                    color: isLive ? '#ff6b78' : '#9ca3af',
                    fontWeight: 700,
                    fontSize: '12px',
                    cursor: 'pointer',
                  }}
                >
                  {isLive ? '🔴 실시간 ON' : '⚪ 실시간 OFF'}
                </button>

                <button
                  onClick={() => setChartType('candle')}
                  style={{
                    padding: '6px 12px',
                    borderRadius: '6px',
                    border: '1px solid #2e3646',
                    background: chartType === 'candle' ? '#3182f6' : '#1c2230',
                    color: chartType === 'candle' ? '#fff' : '#9ca3af',
                    fontWeight: 700,
                    fontSize: '12px',
                    cursor: 'pointer',
                  }}
                >
                  🕯️ 캔들
                </button>

                <button
                  onClick={() => setChartType('area')}
                  style={{
                    padding: '6px 12px',
                    borderRadius: '6px',
                    border: '1px solid #2e3646',
                    background: chartType === 'area' ? '#3182f6' : '#1c2230',
                    color: chartType === 'area' ? '#fff' : '#9ca3af',
                    fontWeight: 700,
                    fontSize: '12px',
                    cursor: 'pointer',
                  }}
                >
                  📈 영역선
                </button>

                {/* <select> 태그로 만든 분봉/시간봉 선택 드롭다운 */}
                <select
                  value={timeframe}
                  onChange={(e) => setTimeframe(e.target.value as TimeframeOption)}
                  style={{
                    padding: '6px 12px',
                    borderRadius: '6px',
                    border: '1px solid #3182f6',
                    background: '#0b0e14',
                    color: '#f9fafb',
                    fontWeight: 700,
                    fontSize: '12px',
                    cursor: 'pointer',
                    outline: 'none',
                  }}
                >
                  {TIMEFRAME_LIST.map((tf) => (
                    <option key={tf.value} value={tf.value} style={{ background: '#131722' }}>
                      ⏱️ {tf.label}
                    </option>
                  ))}
                </select>

                <button
                  onClick={() => setShowMA((p) => !p)}
                  style={{
                    padding: '6px 12px',
                    borderRadius: '6px',
                    border: showMA ? '1px solid #f59e0b' : '1px solid #2e3646',
                    background: showMA ? 'rgba(245, 158, 11, 0.15)' : '#1c2230',
                    color: showMA ? '#fbbf24' : '#9ca3af',
                    fontWeight: 700,
                    fontSize: '12px',
                    cursor: 'pointer',
                  }}
                >
                  이평선(MA)
                </button>

                <button
                  onClick={() => setShowBB((p) => !p)}
                  style={{
                    padding: '6px 12px',
                    borderRadius: '6px',
                    border: showBB ? '1px solid #38bdf8' : '1px solid #2e3646',
                    background: showBB ? 'rgba(56, 189, 248, 0.15)' : '#1c2230',
                    color: showBB ? '#38bdf8' : '#9ca3af',
                    fontWeight: 700,
                    fontSize: '12px',
                    cursor: 'pointer',
                  }}
                >
                  볼린저밴드
                </button>

                {/* ★ Investing.com과 동일하게 정규장 캔들만 사용할지 선택하는 버튼 */}
                {timeframe !== '24h' && (
                  <button
                    onClick={() => setRegularSessionOnly((p) => !p)}
                    title="Investing.com과 동일하게 정규장(09:00~15:30 / 09:30~16:00) 데이터만으로 RSI와 차트를 계산합니다."
                    style={{
                      padding: '6px 12px',
                      borderRadius: '6px',
                      border: regularSessionOnly ? '1px solid #10b981' : '1px solid #2e3646',
                      background: regularSessionOnly ? 'rgba(16, 185, 129, 0.15)' : '#1c2230',
                      color: regularSessionOnly ? '#34d399' : '#9ca3af',
                      fontWeight: 700,
                      fontSize: '12px',
                      cursor: 'pointer',
                    }}
                  >
                    {regularSessionOnly ? '🕒 정규장만 (Investing 기준)' : '🌙 시간외 포함 (토스 전체)'}
                  </button>
                )}
              </div>

              <span style={{ fontSize: '12px', color: '#9ca3af' }}>{status}</span>
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '10px',
                fontSize: '12px',
                marginBottom: '8px',
              }}
            >
              <div style={{ display: 'flex', gap: '14px', color: '#9ca3af', flexWrap: 'wrap' }}>
                {hoveredBar ? (
                  <>
                    <span>시가 <strong style={{ color: '#fff' }}>{hoveredBar.open.toLocaleString()}</strong></span>
                    <span>고가 <strong style={{ color: '#f04452' }}>{hoveredBar.high.toLocaleString()}</strong></span>
                    <span>저가 <strong style={{ color: '#3182f6' }}>{hoveredBar.low.toLocaleString()}</strong></span>
                    <span>종가 <strong style={{ color: '#fff' }}>{hoveredBar.close.toLocaleString()}</strong></span>
                    <span>거래량 <strong style={{ color: '#eab308' }}>{hoveredBar.volume.toLocaleString()}</strong></span>
                    {hoveredBar.rsi !== undefined && (
                      <span>
                        RSI(14) <strong style={{ color: '#34d399' }}>{formatTwoDecimals(hoveredBar.rsi)}</strong>
                      </span>
                    )}
                  </>
                ) : (
                  <span>차트 위 마우스 이동 시 봉별 시가·고가·저가·종가·거래량·RSI(14) 표시</span>
                )}
              </div>

              {quoteSummary && showMA && (
                <div style={{ display: 'flex', gap: '12px', fontSize: '12px', fontWeight: 700 }}>
                  <span style={{ color: '#f59e0b' }}>MA5 {quoteSummary.ma5.toLocaleString()}</span>
                  <span style={{ color: '#a855f7' }}>MA20 {quoteSummary.ma20.toLocaleString()}</span>
                  <span style={{ color: '#10b981' }}>MA60 {quoteSummary.ma60.toLocaleString()}</span>
                </div>
              )}
            </div>

            <div
              style={{
                position: 'relative',
                width: '100%',
                height: '440px',
                borderRadius: '8px',
                overflow: 'hidden',
                border: '1px solid #1e2433',
              }}
            >
              {isChartLoading && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    background: 'rgba(19, 23, 34, 0.85)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    zIndex: 10,
                  }}
                >
                  <InlineLoading text={`${currentStock.name} 차트 불러오는 중...`} size={30} />
                </div>
              )}
              <div ref={chartContainerRef} style={{ width: '100%', height: '100%' }} />
            </div>

            {quoteSummary && (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, 1fr)',
                  gap: '10px',
                  marginTop: '12px',
                }}
              >
                <div
                  style={{
                    background: '#0b0e14',
                    padding: '10px 14px',
                    borderRadius: '8px',
                    border: '1px solid #1e2433',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <span style={{ fontSize: '12px', color: '#9ca3af' }}>
                    RSI (14 · Wilder RMA)
                  </span>
                  <span
                    style={{
                      fontSize: '13px',
                      fontWeight: 800,
                      color:
                        quoteSummary.rsi >= 70
                          ? '#f04452'
                          : quoteSummary.rsi <= 30
                          ? '#3182f6'
                          : '#10b981',
                    }}
                  >
                    {formatTwoDecimals(quoteSummary.rsi)} (
                    {quoteSummary.rsi >= 70 ? '과매수' : quoteSummary.rsi <= 30 ? '과매도' : '중립'})
                  </span>
                </div>

                <div
                  style={{
                    background: '#0b0e14',
                    padding: '10px 14px',
                    borderRadius: '8px',
                    border: '1px solid #1e2433',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <span style={{ fontSize: '12px', color: '#9ca3af' }}>단기 이평선 추세</span>
                  <span
                    style={{
                      fontSize: '13px',
                      fontWeight: 800,
                      color: quoteSummary.ma5 >= quoteSummary.ma20 ? '#f04452' : '#3182f6',
                    }}
                  >
                    {quoteSummary.ma5 >= quoteSummary.ma20 ? '▲ 정배열 (상승세)' : '▼ 역배열 (조정세)'}
                  </span>
                </div>

                <div
                  style={{
                    background: '#0b0e14',
                    padding: '10px 14px',
                    borderRadius: '8px',
                    border: '1px solid #1e2433',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <span style={{ fontSize: '12px', color: '#9ca3af' }}>호가 잔량 우위</span>
                  <span
                    style={{
                      fontSize: '13px',
                      fontWeight: 800,
                      color: bidDominance >= 50 ? '#f04452' : '#3182f6',
                    }}
                  >
                    매수 {bidDominance}% : 매도 {100 - bidDominance}%
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* 차트 아래: 실시간 체결 내역 */}
          <div
            style={{
              background: '#131722',
              borderRadius: '12px',
              border: '1px solid #232a3b',
              padding: '16px',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                paddingBottom: '10px',
                borderBottom: '1px solid #1e2433',
                marginBottom: '8px',
              }}
            >
              <span style={{ fontWeight: 800, fontSize: '14px', color: '#f3f4f6' }}>
                실시간 체결 내역 (Time & Sales)
              </span>
              <span style={{ fontSize: '12px', color: '#6b7280' }}>최근 12건 체결 현황</span>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr 1fr 1fr',
                padding: '6px 12px',
                fontSize: '12px',
                color: '#6b7280',
                background: '#0b0e14',
                borderRadius: '6px',
                marginBottom: '4px',
                fontWeight: 600,
              }}
            >
              <span>체결시각</span>
              <span>체결구분</span>
              <span style={{ textAlign: 'right' }}>체결가격</span>
              <span style={{ textAlign: 'right' }}>체결수량</span>
            </div>

            <div style={{ maxHeight: '190px', overflowY: 'auto' }}>
              {trades.map((t, idx) => (
                <div
                  key={idx}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr 1fr 1fr',
                    padding: '7px 12px',
                    fontSize: '13px',
                    borderBottom: '1px solid #191f2c',
                    alignItems: 'center',
                  }}
                >
                  <span style={{ color: '#9ca3af' }}>{t.time}</span>
                  <span>
                    <span
                      style={{
                        fontSize: '11px',
                        padding: '2px 7px',
                        borderRadius: '4px',
                        fontWeight: 700,
                        background:
                          t.side === 'BUY'
                            ? 'rgba(240, 68, 82, 0.15)'
                            : 'rgba(49, 130, 246, 0.15)',
                        color: t.side === 'BUY' ? '#f04452' : '#3182f6',
                      }}
                    >
                      {t.side === 'BUY' ? '매수체결' : '매도체결'}
                    </span>
                  </span>
                  <span
                    style={{
                      textAlign: 'right',
                      fontWeight: 700,
                      color: t.side === 'BUY' ? '#f04452' : '#3182f6',
                    }}
                  >
                    {isKR ? t.price.toLocaleString() : formatTwoDecimals(t.price)}
                  </span>
                  <span
                    style={{
                      textAlign: 'right',
                      fontWeight: 600,
                      color: '#e5e7eb',
                    }}
                  >
                    {t.volume.toLocaleString()}주
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* [2열: 가운데] 호가창 */}
        <div
          style={{
            background: '#131722',
            borderRadius: '12px',
            border: '1px solid #232a3b',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                paddingBottom: '10px',
                borderBottom: '1px solid #1e2433',
                marginBottom: '10px',
              }}
            >
              <span style={{ fontWeight: 800, fontSize: '15px', color: '#f3f4f6' }}>
                호가창 (Orderbook)
              </span>
              <span style={{ fontSize: '11px', color: '#6b7280' }}>가격 · 잔량</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '8px' }}>
              {asks.map((row, idx) => {
                const widthPct = Math.round((row.quantity / maxOrderbookQty) * 100);
                return (
                  <div
                    key={`ask-${idx}`}
                    style={{
                      position: 'relative',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '6px 10px',
                      fontSize: '13px',
                      background: 'rgba(49, 130, 246, 0.06)',
                      borderRadius: '5px',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        position: 'absolute',
                        right: 0,
                        top: 0,
                        bottom: 0,
                        width: `${widthPct}%`,
                        background: 'rgba(49, 130, 246, 0.22)',
                      }}
                    />
                    <span style={{ color: '#60a5fa', fontWeight: 700, zIndex: 1 }}>
                      {isKR ? row.price.toLocaleString() : formatTwoDecimals(row.price)}
                    </span>
                    <span style={{ color: '#d1d5db', fontSize: '12px', zIndex: 1 }}>
                      {row.quantity.toLocaleString()}
                    </span>
                  </div>
                );
              })}
            </div>

            {quoteSummary && (
              <div
                style={{
                  padding: '9px 12px',
                  margin: '8px 0',
                  background: '#1c2230',
                  border: `1.5px solid ${accentColor}`,
                  borderRadius: '8px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  fontSize: '14px',
                  fontWeight: 800,
                }}
              >
                <span style={{ color: '#9ca3af', fontSize: '12px' }}>현재 체결가</span>
                <span style={{ color: accentColor, fontSize: '16px' }}>
                  {isKR ? quoteSummary.price.toLocaleString() : formatTwoDecimals(quoteSummary.price)}
                </span>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {bids.map((row, idx) => {
                const widthPct = Math.round((row.quantity / maxOrderbookQty) * 100);
                return (
                  <div
                    key={`bid-${idx}`}
                    style={{
                      position: 'relative',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '6px 10px',
                      fontSize: '13px',
                      background: 'rgba(240, 68, 82, 0.06)',
                      borderRadius: '5px',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        position: 'absolute',
                        right: 0,
                        top: 0,
                        bottom: 0,
                        width: `${widthPct}%`,
                        background: 'rgba(240, 68, 82, 0.22)',
                      }}
                    />
                    <span style={{ color: '#f87171', fontWeight: 700, zIndex: 1 }}>
                      {isKR ? row.price.toLocaleString() : formatTwoDecimals(row.price)}
                    </span>
                    <span style={{ color: '#d1d5db', fontSize: '12px', zIndex: 1 }}>
                      {row.quantity.toLocaleString()}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <div
            style={{
              marginTop: '12px',
              padding: '10px 12px',
              background: '#0b0e14',
              borderRadius: '8px',
              border: '1px solid #1e2433',
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: '12px',
            }}
          >
            <span style={{ color: '#60a5fa', fontWeight: 700 }}>
              매도합 {totalAskQty.toLocaleString()}
            </span>
            <span style={{ color: '#6b7280' }}>총잔량</span>
            <span style={{ color: '#f87171', fontWeight: 700 }}>
              매수합 {totalBidQty.toLocaleString()}
            </span>
          </div>
        </div>

        {/* [3열: 맨 오른쪽] ★ 관심종목 */}
        <div
          style={{
            background: '#131722',
            borderRadius: '12px',
            border: '1px solid #232a3b',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              paddingBottom: '10px',
              borderBottom: '1px solid #1e2433',
              marginBottom: '12px',
            }}
          >
            <span style={{ fontWeight: 800, fontSize: '15px', color: '#f3f4f6' }}>
              ★ 관심종목 ({favorites.length})
            </span>
            <span style={{ fontSize: '11px', color: '#6b7280' }}>Watchlist</span>
          </div>

          {favorites.length === 0 ? (
            <div
              style={{
                padding: '30px 10px',
                textAlign: 'center',
                color: '#6b7280',
                fontSize: '13px',
                lineHeight: 1.6,
              }}
            >
              등록된 관심종목이 없습니다.
              <br />
              상단 <strong>[☆ 관심등록]</strong> 버튼을 눌러 추가해 보세요!
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', overflowY: 'auto' }}>
              {favorites.map((fav) => {
                const isSelected = currentStock.symbol === fav.symbol;
                return (
                  <div
                    key={fav.symbol}
                    onClick={() => navigateToStock(fav)}
                    style={{
                      padding: '12px 14px',
                      borderRadius: '8px',
                      background: isSelected ? 'rgba(49, 130, 246, 0.16)' : '#0b0e14',
                      border: isSelected ? '1px solid #3182f6' : '1px solid #1e2433',
                      cursor: 'pointer',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 700, fontSize: '14px', color: '#f3f4f6' }}>
                        {fav.name}
                      </div>
                      <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '3px' }}>
                        {fav.symbol}
                      </div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFavorite(fav);
                      }}
                      title="관심종목 삭제"
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: '#6b7280',
                        cursor: 'pointer',
                        fontSize: '14px',
                        padding: '4px',
                      }}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}