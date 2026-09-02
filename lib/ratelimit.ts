// prereject — 요청 제한
//
// 왜 필요한가: /api/review 한 번이 LLM 호출 한 번이다. 공개 배포 상태에서
// 제한이 없으면 루프 한 번에 API 요금이 그대로 나간다. 결제 게이트가 붙기
// 전까지 이 파일이 유일한 비용 상한이다.
//
// 한계(명시): 서버리스 인스턴스별 메모리라 인스턴스가 늘면 상한도 배수로 늘고,
// 콜드 스타트마다 초기화된다. 정확한 전역 제한이 아니라 **폭주 차단**이 목적이다.
// 정확한 제한이 필요해지면 Vercel KV / Upstash로 옮긴다.

type Bucket = { hits: number[]; };

const WINDOW_MS = 60 * 60 * 1000;      // 1시간
const PER_IP_PER_HOUR = 3;             // IP당 시간당 3회
const INSTANCE_DAILY_CAP = 100;        // 인스턴스당 하루 100회 (비용 상한)
// 🔴 300 → 100 (2026-09-02): 기본 모델을 gpt-4o에서 gpt-5.6-sol로 올리면서 건당 비용이 뛰었다.
// 트래픽이 이 상한에 실제로 닿으면 그건 좋은 신호이므로, 그때 결제 게이트를 붙이고 올린다.

const buckets = new Map<string, Bucket>();
let dayStamp = 0;
let dayCount = 0;

function todayIndex(now: number): number {
  return Math.floor(now / (24 * 60 * 60 * 1000));
}

export type LimitVerdict =
  | { ok: true }
  | { ok: false; reason: 'ip' | 'global'; retryAfterSec: number };

export function checkLimit(ip: string, now = Date.now()): LimitVerdict {
  const today = todayIndex(now);
  if (today !== dayStamp) {
    dayStamp = today;
    dayCount = 0;
  }
  if (dayCount >= INSTANCE_DAILY_CAP) {
    const nextDay = (today + 1) * 24 * 60 * 60 * 1000;
    return { ok: false, reason: 'global', retryAfterSec: Math.ceil((nextDay - now) / 1000) };
  }

  const bucket = buckets.get(ip) ?? { hits: [] };
  bucket.hits = bucket.hits.filter((t) => now - t < WINDOW_MS);
  if (bucket.hits.length >= PER_IP_PER_HOUR) {
    const oldest = bucket.hits[0];
    buckets.set(ip, bucket);
    return { ok: false, reason: 'ip', retryAfterSec: Math.ceil((oldest + WINDOW_MS - now) / 1000) };
  }

  bucket.hits.push(now);
  buckets.set(ip, bucket);
  dayCount += 1;

  // 맵이 무한히 자라지 않게 — 만료된 버킷을 가끔 청소한다.
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (v.hits.every((t) => now - t >= WINDOW_MS)) buckets.delete(k);
    }
  }
  return { ok: true };
}

/** 프록시 뒤에서의 클라이언트 IP. Vercel은 x-forwarded-for 첫 항목이 실제 클라이언트다. */
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}
