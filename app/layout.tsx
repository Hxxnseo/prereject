import type { Metadata } from 'next';
import './globals.css';
import { Analytics } from '@vercel/analytics/next';

const SITE = 'https://prereject.vercel.app';
const TITLE = 'prereject — 제출 전에 나를 반려시켜보는 AI 심사팀';
const DESC =
  '지원사업·공모전 제출 전에 AI 심사위원 팀이 먼저 떨어뜨려 봅니다. 반려 사유와 몇 쪽이 문제인지, 그대로 붙여넣을 수정 문구까지 돌려줍니다. PDF·PPTX·DOCX·한글 파일 지원.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: TITLE,
  description: DESC,
  alternates: { canonical: '/' },
  keywords: ['지원사업', '공모전', '사업계획서', '피치덱', '반려사유', 'IR', '자기소개서', 'AI 심사'],
  openGraph: {
    type: 'website',
    locale: 'ko_KR',
    url: SITE,
    siteName: 'prereject',
    title: TITLE,
    description: DESC,
    images: [{ url: '/og.png', width: 1200, height: 630, alt: '제출 전에, 나를 먼저 떨어뜨려본다' }],
  },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESC, images: ['/og.png'] },
  robots: { index: true, follow: true },
};

// 검색엔진이 "무료 웹 도구"로 읽게 한다. 카톡/디스콰이엇 공유 시 카드는 openGraph 쪽이 담당.
const LD = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'prereject',
  applicationCategory: 'BusinessApplication',
  operatingSystem: 'Web',
  url: SITE,
  description: DESC,
  inLanguage: 'ko',
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'KRW' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        {children}
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(LD) }} />
        <Analytics />
      </body>
    </html>
  );
}
