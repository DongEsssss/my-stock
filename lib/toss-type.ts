// 역할: 토스증권 API 및 백필 모듈에서 공통으로 사용하는 타입과 상수를 정의합니다.

/** 토스증권 Open API 기본 도메인 */
export const TOSS_BASE_URL = 'https://openapi.tossinvest.com';

/** 2000년 1월 1일 00:00:00 UTC (초 단위 Unix Timestamp) */
export const YEAR_2000_UNIX = 946684800;

/** 기본 네트워크 요청 타임아웃 (밀리초) */
export const DEFAULT_TIMEOUT_MS = 7000;

/** 종목 검색 결과 아이템 타입 */
export type StockInfoItem = {
  symbol: string; // 종목 코드 (예: '005930', 'TSLA')
  name: string;   // 종목 한글/영문명 (예: '삼성전자', '테슬라')
  market: string; // 소속 시장 (예: 'KOSPI', 'NASDAQ')
};

/** 토스 API 초당 호출 제한(Rate Limit) 상태 타입 */
export type RateLimitInfo = {
  limit: string;     // 초당 최대 허용 횟수 (기본 20)
  remaining: string; // 현재 초에 남은 호출 가능 횟수
  reset: string;     // 한도 초기화까지 남은 시간(초)
};

/** fetchCandles 함수 요청 파라미터 타입 */
export type FetchCandlesParams = {
  symbol: string;
  interval?: string; // '1m' | '1d'
  count?: string;    // 요청 개수 문자열 (예: '200', '5')
  before?: string;   // 과거 페이지네이션 커서
};

/**
 * 토스 API 원본 응답 또는 프론트엔드 차트 컴포넌트에서
 * 공통으로 읽을 수 있는 호환 캔들 객체 타입
 */
export interface CandleItem {
  timestamp?: number | string;
  time?: number | string;
  dateTime?: string;
  dt?: string;
  date?: string;
  startTime?: number | string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  openPrice?: number;
  highPrice?: number;
  lowPrice?: number;
  closePrice?: number;
  accTradeVolume?: number;
  [key: string]: unknown;
}

/** 토스 캔들 API의 result 객체 구조 */
export interface TossCandleResultObject {
  candles?: CandleItem[];
  items?: CandleItem[];
  data?: CandleItem[];
  nextBefore?: string | number;
  nextCursor?: string | number;
  [key: string]: unknown;
}