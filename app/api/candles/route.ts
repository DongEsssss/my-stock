import { NextRequest, NextResponse } from 'next/server';
import {
  fetchCandles,
  getLastRateLimit,
  searchStocksByQuery,
} from '@/lib/toss-invest';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const type = searchParams.get('type') ?? 'candles';

  try {
    // 1. 종목 이름/코드 검색 요청 (/api/candles?type=search&q=두산에너빌리티)
    if (type === 'search') {
      const q = searchParams.get('q') ?? '';
      const stocks = await searchStocksByQuery(q);
      return NextResponse.json({ data: stocks });
    }

    // 2. 차트 캔들 조회 요청 (/api/candles?symbol=034020&interval=1m)
    const symbol = searchParams.get('symbol') ?? '005930';
    const interval = searchParams.get('interval') ?? '1m';
    const count = searchParams.get('count') ?? '100';
    const before = searchParams.get('before') ?? undefined;

    const result = await fetchCandles({ symbol, interval, count, before });
    const rateLimit = getLastRateLimit();

    // 캔들 데이터와 함께 현재 남은 호출 한도(rateLimit)를 브라우저로 전달
    return NextResponse.json({ data: result, rateLimit });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message ?? '데이터 조회 중 오류가 발생했습니다.' },
      { status: 500 }
    );
  }
}