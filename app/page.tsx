import Link from 'next/link';
import StockChart from '../components/StockChart/page';

export default function HomePage() {
  return (
    <main     style={{
        minHeight: '100vh',
        background: '#0b0e14',
        padding: '24px',
      }}>
      {/* 상단 페이지 이동 네비게이션 예시 */}
      {/* <nav style={{ display: 'flex', gap: '16px', marginBottom: '24px', borderBottom: '1px solid #eee', paddingBottom: '12px' }}>
        <Link href="/" style={{ fontWeight: 'bold' }}>홈 (차트)</Link>
        <Link href="/about">다른 페이지 예시</Link>
      </nav>

      <h1 style={{ fontSize: '24px', fontWeight: 'bold', marginBottom: '16px' }}>
        내 주식 대시보드
      </h1> */}

      {/* 분리한 차트 컴포넌트 불러오기 */}
      <StockChart defaultSymbol="" />
    </main>
  );
}