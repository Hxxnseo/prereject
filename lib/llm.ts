// prereject — LLM 프로바이더 추상화
//
// 환경변수에 있는 키를 자동 감지한다 (Anthropic 우선, 없으면 OpenAI).
// 오픈소스로 풀 때 빌더가 아무 키나 꽂아도 돌아가게 하는 게 목적.

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

export type Provider = 'anthropic' | 'openai';

/** 현재 사용 가능한 프로바이더 (키 존재 기준). 둘 다 있으면 Anthropic 우선. */
export function activeProvider(): Provider | null {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return null;
}

/** 심사 1회 실행 → 모델의 원문 텍스트 반환. 프로바이더별 차이(truncation 등)를 여기서 흡수. */
export async function runReview(
  system: string,
  user: string,
): Promise<{ text: string; model: string; provider: Provider }> {
  const provider = activeProvider();
  if (!provider) throw new Error('NO_KEY');

  if (provider === 'anthropic') {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
    const model = process.env.PREREJECT_MODEL || 'claude-sonnet-5';
    const msg = await client.messages.create({
      model,
      max_tokens: 8192,
      system,
      messages: [{ role: 'user', content: user }],
    });
    if (msg.stop_reason === 'max_tokens') throw new Error('TRUNCATED');
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    return { text, model, provider };
  }

  // openai — response_format json_object로 유효 JSON 강제 (system 프롬프트에 "JSON" 포함 필요, 이미 있음)
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  const model = process.env.PREREJECT_MODEL || 'gpt-5.6-sol';
  const res = await client.chat.completions.create({
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  const choice = res.choices[0];
  if (choice?.finish_reason === 'length') throw new Error('TRUNCATED');
  const text = choice?.message?.content ?? '';
  return { text, model, provider };
}
