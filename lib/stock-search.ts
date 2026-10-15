// 역할: 네이버 금융 자동완성 API를 이용해 한글 종목명(예: 삼성전자)이나 영문 티커(예: TSLA)를 실시간으로 검색합니다.
import { StockInfoItem } from './toss-type';

/** 네이버 자동완성 API 응답 구조 타입 */
interface NaverAutoCompleteItem {
  code?: string;
  name?: string;
  typeName?: string;
  typeCode?: string;
}

interface NaverAutoCompleteResponse {
  items?: NaverAutoCompleteItem[];
}

/**
 * 사용자가 입력한 검색어(한글 상표명 또는 영문 티커)로 종목 목록을 검색합니다.
 */
export async function searchStocksByQuery(
  query: string
): Promise<StockInfoItem[]> {
  const q = query.trim();
  if (!q) return [];

  try {
    const res = await fetch(
      `https://ac.stock.naver.com/ac?q=${encodeURIComponent(
        q
      )}&q_enc=utf-8&target=stock`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Referer: 'https://finance.naver.com',
        },
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      }
    );

    if (res.ok) {
      const data = (await res.json()) as NaverAutoCompleteResponse;
      const items = Array.isArray(data.items) ? data.items : [];

      const results: StockInfoItem[] = items
        .map((item) => {
          const rawCode = String(item.code ?? '').trim();
          // 국내 6자리 코드는 그대로 유지하고, 해외 종목의 '.O', '.K' 등 거래소 접미사는 제거합니다.
          const symbol = /^\d{6}$/.test(rawCode)
            ? rawCode
            : rawCode.split('.')[0];

          return {
            symbol,
            name: String(item.name ?? symbol),
            market: String(item.typeName ?? item.typeCode ?? ''),
          };
        })
        .filter((item) => item.symbol.length > 0);

      if (results.length > 0) {
        return results.slice(0, 15);
      }
    }
  } catch (e) {
    console.error('종목명 검색 중 오류:', e);
  }

  // 검색 결과가 없거나 네트워크 오류 시 입력값을 대문자 티커로 폴백 반환합니다.
  return [{ symbol: q.toUpperCase(), name: q.toUpperCase(), market: '' }];
}