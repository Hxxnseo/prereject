import type { Metadata } from 'next';
import './globals.css';
import { Analytics } from '@vercel/analytics/next';

export const metadata: Metadata = {
  title: 'prereject — 제출 전에 나를 반려시켜보는 AI 심사팀',
  description: '보내기 전에 AI 심사위원 팀이 당신을 먼저 떨어뜨려 봅니다. 반려 이유와 고칠 문구를 돌려줍니다.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
