import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt, buildUserPrompt, type ReviewResult } from '@/lib/prompts';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** ```json 펜스나 잡텍스트가 섞여도 JSON 객체만 뽑아낸다 */
function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : raw).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('응답에서 JSON을 찾지 못했습니다');
  return JSON.parse(candidate.slice(start, end + 1));
}

export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: 'ANTHROPIC_API_KEY 미설정 — .env.local 에 키를 넣고 다시 실행하세요.' },
      { status: 500 },
    );
  }

  let submission = '';
  let criteria = '';
  try {
    const body = await req.json();
    submission = String(body?.submission ?? '');
    criteria = String(body?.criteria ?? '');
  } catch {
    return Response.json({ error: '요청 본문 파싱 실패' }, { status: 400 });
  }

  if (submission.trim().length < 20) {
    return Response.json({ error: '제출물이 너무 짧습니다 (20자 이상).' }, { status: 400 });
  }

  const client = new Anthropic({ apiKey });
  const model = process.env.PREREJECT_MODEL || 'claude-sonnet-5';

  try {
    const msg = await client.messages.create({
      model,
      max_tokens: 4096,
      system: buildSystemPrompt(),
      messages: [{ role: 'user', content: buildUserPrompt(submission, criteria) }],
    });

    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    const result = extractJson(text) as ReviewResult;
    return Response.json({ result, model });
  } catch (err) {
    const message = err instanceof Error ? err.message : '알 수 없는 오류';
    return Response.json({ error: `심사 실패: ${message}` }, { status: 502 });
  }
}
