import { buildSystemPrompt, buildUserPrompt, type ReviewResult } from '@/lib/prompts';
import { runReview, activeProvider } from '@/lib/llm';
import { checkLimit, clientIp } from '@/lib/ratelimit';

export const runtime = 'nodejs';
export const maxDuration = 120; // 실측 42~44초. 60초는 마진이 얇아 모델 부하 시 타임아웃 위험.

/** 입력 상한 — 비용 폭탄/타임아웃 방어 (#1). 제출물+평가기준+구조 합산 문자 수.
 *  🔴 12000 → 40000 (2026-09-02): 첨부파일을 받기 시작하면서 12000자로는 피치덱 한 벌도
 *  안 들어간다. 클라이언트가 쪽 경계에서 먼저 자르지만(사용자에게 고지됨), 그건 우회 가능하므로
 *  서버에도 하드 상한을 남긴다. 지연은 출력이 지배하므로 입력 증가분의 비용은 작다(실측). */
const MAX_INPUT_CHARS = 40000;

/** ```json 펜스 우선 → 일반 펜스 → 원문 순으로 balanced object 추출 (#4 보강) */
function extractJson(raw: string): unknown {
  const jsonFence = raw.match(/```json\s*([\s\S]*?)```/i);
  const anyFence = raw.match(/```\s*([\s\S]*?)```/);
  const candidate = (jsonFence?.[1] ?? anyFence?.[1] ?? raw).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('NO_JSON');
  return JSON.parse(candidate.slice(start, end + 1));
}

/** 모델 JSON이 UI가 기대하는 형태인지 런타임 검증 (#3). 캐스팅만으로는 UI가 .map에서 터진다. */
function validateReviewResult(obj: unknown): ReviewResult {
  const r = obj as Record<string, unknown>;
  const ok =
    r &&
    typeof r === 'object' &&
    Array.isArray(r.criteria) &&
    Array.isArray(r.rejections) &&
    Array.isArray(r.topFixes) &&
    r.verdict &&
    typeof r.verdict === 'object';
  if (!ok) throw new Error('BAD_SHAPE');
  return r as unknown as ReviewResult;
}

/** 내부 오류를 사용자 친화 메시지로 매핑 (#5). 원문은 서버 로그에만. */
function userFacingError(err: unknown): { message: string; status: number } {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw === 'NO_KEY')
    return { message: '서버에 API 키가 설정되지 않았습니다 (관리자: ANTHROPIC_API_KEY 또는 OPENAI_API_KEY).', status: 503 };
  const status = (err as { status?: number })?.status;
  if (status === 401) return { message: 'API 키가 유효하지 않습니다. 설정을 확인하세요.', status: 502 };
  if (status === 429) return { message: '요청이 많습니다. 잠시 후 다시 시도하세요.', status: 429 };
  if (status === 404) return { message: '설정된 모델을 찾을 수 없습니다. PREREJECT_MODEL을 확인하세요.', status: 502 };
  if (raw === 'NO_JSON' || raw === 'BAD_SHAPE' || raw === 'TRUNCATED')
    return { message: '심사 결과를 읽지 못했습니다. 제출물을 조금 줄여 다시 시도해 주세요.', status: 502 };
  return { message: '심사 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.', status: 502 };
}

export async function POST(req: Request) {
  // 비용 상한이 먼저다 — 키 확인보다 앞에 둔다 (없는 키로도 요청은 계속 들어온다).
  const limit = checkLimit(clientIp(req));
  if (!limit.ok) {
    const message =
      limit.reason === 'ip'
        ? '무료 심사는 시간당 3회까지입니다. 잠시 후 다시 시도해 주세요.'
        : '오늘 무료 심사 한도가 찼습니다. 내일 다시 시도해 주세요.';
    return Response.json({ error: message }, { status: 429, headers: { 'retry-after': String(limit.retryAfterSec) } });
  }

  if (!activeProvider()) {
    return Response.json(
      { error: '서버에 API 키가 설정되지 않았습니다 (관리자: ANTHROPIC_API_KEY 또는 OPENAI_API_KEY).' },
      { status: 503 },
    );
  }

  let submission = '';
  let criteria = '';
  let structure = '';
  try {
    const body = await req.json();
    submission = String(body?.submission ?? '');
    criteria = String(body?.criteria ?? '');
    structure = String(body?.structure ?? '').slice(0, 4000); // 구조 표는 짧다. 길면 잘라 신뢰하지 않는다.
  } catch {
    return Response.json({ error: '요청 형식이 올바르지 않습니다.' }, { status: 400 });
  }

  if (submission.trim().length < 20) {
    return Response.json({ error: '제출물이 너무 짧습니다 (20자 이상).' }, { status: 400 });
  }
  if (submission.length + criteria.length + structure.length > MAX_INPUT_CHARS) {
    return Response.json(
      { error: `입력이 너무 깁니다 (합산 ${MAX_INPUT_CHARS}자 이하). 핵심 부분만 넣어 주세요.` },
      { status: 413 },
    );
  }

  try {
    const { text, model, provider } = await runReview(
      buildSystemPrompt(),
      buildUserPrompt(submission, criteria, structure),
    );
    const result = validateReviewResult(extractJson(text)); // (#3)
    return Response.json({ result, model, provider });
  } catch (err) {
    console.error('[prereject] review 실패:', err); // 원문은 로그에만 (#5)
    const { message, status } = userFacingError(err);
    return Response.json({ error: message }, { status });
  }
}
