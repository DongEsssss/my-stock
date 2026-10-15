export default function Loading({
  text = '불러오는 중...',
  size = 24,
}: {
  text?: string;
  size?: number;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '10px',
        padding: '16px',
        color: '#555',
        fontSize: '14px',
        fontWeight: 500,
      }}
    >
      <div
        style={{
          width: `${size}px`,
          height: `${size}px`,
          border: '3px solid #e5e8eb',
          borderTop: '3px solid #3182f6', // 토스 블루 포인트 색상
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