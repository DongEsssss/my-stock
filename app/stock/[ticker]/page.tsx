// 파일 위치: app/stock/[ticker]/page.tsx
import { Suspense } from 'react';
import StockChart from '@/components/StockChart/page';
import Loading from '@/components/Loading/page';
import { searchStocksByQuery } from '@/lib/toss-invest';

// 실제 URL의 종목명/티커를 읽어 차트를 띄우는 내부 컴포넌트
async function StockDetailContent({
  params,
}: {
  params: Promise<{ ticker: string }>;
}) {
  const { ticker } = await params;

  // URL 한글 디코딩 후 앞의 'ticker=' 제거
  const decoded = decodeURIComponent(ticker);
  const cleanValue = decoded.replace(/^ticker=/i, '').trim();

  let resolvedSymbol = cleanValue.toUpperCase();
  let resolvedName = cleanValue;
  let resolvedMarket = /^[A-Za-z._-]+$/.test(cleanValue) ? '' : 'KRX';

  // 한글 종목명(국장)인 경우 서버에서 6자리 종목코드 조회
  const matched = await searchStocksByQuery(cleanValue);
  if (matched.length > 0) {
    const exact =
      matched.find(
        (m) =>
          m.name.toLowerCase() === cleanValue.toLowerCase() ||
          m.symbol.toLowerCase() === cleanValue.toLowerCase()
      ) ?? matched[0];

    resolvedSymbol = exact.symbol;
    resolvedName = exact.name;
    resolvedMarket = exact.market || (/^\d{6}$/.test(exact.symbol) ? 'KRX' : 'US');
  }

  return (
    <StockChart
      defaultSymbol={resolvedSymbol}
      defaultName={resolvedName}
      defaultMarket={resolvedMarket}
    />
  );
}

// 바깥 페이지: <Suspense>로 감싸서 이동 중일 때 <Loading /> 스피너 표시
export default function StockDetailPage({
  params,
}: {
  params: Promise<{ ticker: string }>;
}) {
  return (
    <main
      style={{
        minHeight: '100vh',
        background: '#0b0e14',
        padding: '24px',
      }}
    >
      <Suspense
        fallback={
          <div style={{ paddingTop: '120px' }}>
            <Loading text="종목 페이지 불러오는 중..." size={36} />
          </div>
        }
      >
        <StockDetailContent params={params} />
      </Suspense>
    </main>
  );
}