'use client';

import { useState } from 'react';
import type { ReviewResult } from '@/lib/prompts';

const SAMPLE_CRITERIA = '예: YC 지원서 / 정부지원사업 사업계획서 / 채용 자기소개서 / 피치덱';

export default function Home() {
  const [submission, setSubmission] = useState('');
  const [criteria, setCriteria] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ReviewResult | null>(null);

  async function run() {
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const res = await fetch('/api/review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ submission, criteria }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '요청 실패');
      setResult(data.result as ReviewResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : '알 수 없는 오류');
    } finally {
      setLoading(false);
    }
  }

  const standingClass =
    result?.verdict.competitiveStanding === '상위권'
      ? '상위권'
      : result?.verdict.competitiveStanding === '경계선'
        ? '경계선'
        : '컷위험';

  return (
    <div className="wrap">
      <div className="hero">
        <h1>제출 전에, 나를 먼저 떨어뜨려본다</h1>
        <p>
          <span className="accent">prereject</span> — AI 심사위원 팀이 당신 제출물을 <b>반려</b>시켜 봅니다.
        </p>
        <p>통과를 확인하는 게 아니라, <b>떨어질 이유를 미리 찾는</b> 도구입니다.</p>
      </div>

      <div className="card">
        <label>이 제출물이 가는 곳 / 평가기준 (선택)</label>
        <textarea rows={2} placeholder={SAMPLE_CRITERIA} value={criteria} onChange={(e) => setCriteria(e.target.value)} />

        <label>제출물 원문</label>
        <textarea
          rows={10}
          placeholder="지원서·사업계획서·자소서·피치 텍스트를 붙여넣으세요."
          value={submission}
          onChange={(e) => setSubmission(e.target.value)}
        />

        <button className="go" onClick={run} disabled={loading || submission.trim().length < 20}>
          {loading ? '심사위원 소집 중…' : '나를 떨어뜨려봐'}
        </button>
        {error && <div className="err">⚠ {error}</div>}
      </div>

      {result && (
        <div className="card">
          <div className="section-title">종합 판정</div>
          <div className="verdict">
            <span className="bigscore">{result.verdict.improvementScore}</span>
            <span className="muted">/ 100 (개선용 점수)</span>
            <span className={`badge ${standingClass}`}>{result.verdict.competitiveStanding}</span>
          </div>
          <div className="note">{result.verdict.honestNote}</div>

          <div className="section-title">지금 당장 고칠 것</div>
          <ol className="fixes">
            {(result.topFixes ?? []).map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ol>

          <div className="section-title">항목별 채점 (절대점수 · 경쟁 컷)</div>
          {(result.criteria ?? []).map((c, i) => (
            <div className="crit" key={i}>
              <div className="row">
                <span className="name">{c.name}</span>
                <span>
                  <span className="muted">{c.score}/100</span>{' '}
                  <span className={`tier ${c.tier}`}>{c.tier}</span>
                </span>
              </div>
              <div className="gap">1등이라면: {c.gapToWinner}</div>
            </div>
          ))}

          <div className="section-title">탈락사유 헌터 ({(result.rejections ?? []).length})</div>
          {(result.rejections ?? []).length === 0 && <div className="muted">치명 반려요인 없음.</div>}
          {(result.rejections ?? []).map((r, i) => (
            <div className="rej" key={i}>
              <div className="head">
                <span className="code">{r.code}</span>
                <span>{r.label}</span>
                <span className="sev">{r.severity}</span>
              </div>
              <div className="ev">“{r.evidence}”</div>
              <div className="fix">
                <b>고치기:</b> {r.fix}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="foot">
        내부 점수는 개선 엔진이지 당락 예측기가 아닙니다 · 오픈소스 (MIT)
      </div>
    </div>
  );
}
