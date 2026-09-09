'use client';

import { useRef, useState } from 'react';
import type { ReviewResult } from '@/lib/prompts';
import { extractFile, acceptAttr, describeSupport, ExtractError, type ExtractedDoc } from '@/lib/extract';

const SAMPLE_CRITERIA = '예: YC 지원서 / 정부지원사업 사업계획서 / 채용 자기소개서 / 피치덱';

/** 서버 상한 40000 에서 평가기준·구조표 몫을 뺀 값. 넘으면 쪽 경계에서 자르고 사용자에게 알린다. */
const REVIEW_CHAR_BUDGET = 34000;

/** Vercel Analytics 커스텀 이벤트. 스크립트 미로드 시 조용히 통과한다. */
function track(name: string, data?: Record<string, string | number | boolean>) {
  try {
    (window as unknown as { va?: (e: string, p: unknown) => void }).va?.('event', { name, data });
  } catch {
    /* 측정 실패가 기능을 막지 않는다 */
  }
}

/** 예산에 맞춰 쪽/슬라이드 경계에서 자른다. 문장 중간에서 자르면 그 장이 통째로 오독된다. */
function fitToBudget(doc: ExtractedDoc): { text: string; usedUnits: number; totalUnits: number } {
  const filled = doc.units.filter((u) => u.text.length > 0);
  const kept: string[] = [];
  let used = 0;
  for (const u of filled) {
    const chunk = `[${u.label}]\n${u.text}`;
    if (used + chunk.length > REVIEW_CHAR_BUDGET) break;
    kept.push(chunk);
    used += chunk.length + 2;
  }
  return { text: kept.join('\n\n'), usedUnits: kept.length, totalUnits: filled.length };
}

export default function Home() {
  const [submission, setSubmission] = useState('');
  const [criteria, setCriteria] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ReviewResult | null>(null);

  const [doc, setDoc] = useState<ExtractedDoc | null>(null);
  const [parsing, setParsing] = useState('');   // 진행 중 문구 (빈 문자열 = 대기 아님)
  const [dragging, setDragging] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const fitted = doc ? fitToBudget(doc) : null;
  const truncated = !!fitted && fitted.usedUnits < fitted.totalUnits;
  const payload = [fitted?.text ?? '', submission.trim()].filter(Boolean).join('\n\n');
  const canRun = payload.trim().length >= 20 && !parsing;

  async function takeFile(file: File) {
    // 한글 문서는 조판 엔진(WASM)을 처음 한 번 내려받는다. 말없이 몇 초 멈추면 고장으로 읽힌다.
    const hancom = /\.hwpx?$/i.test(file.name);
    setParsing(hancom ? '한글 문서 엔진 불러오는 중… (처음 한 번만, 몇 초 걸립니다)' : '파일 읽는 중…');
    setError('');
    setDoc(null);
    setShowPreview(false);
    try {
      const extracted = await extractFile(file);
      if (extracted.totalChars < 20 && !extracted.warning) {
        throw new ExtractError('파일에서 읽어낼 본문이 거의 없습니다. 내용이 있는 파일인지 확인해 주세요.');
      }
      setDoc(extracted);
      track('prereject_file_attached', { kind: extracted.kind, units: extracted.units.length, chars: extracted.totalChars });
    } catch (e) {
      // ExtractError 메시지는 사용자에게 그대로 보여줄 수 있게 쓰여 있다. 그 외는 일반 문구.
      setError(
        e instanceof ExtractError
          ? e.message
          : '파일을 읽지 못했습니다. 다른 형식으로 저장한 뒤 다시 시도해 주세요.',
      );
      track('prereject_file_failed', { name: file.name.split('.').pop() ?? '?' });
    } finally {
      setParsing('');
    }
  }

  async function run() {
    setLoading(true);
    setError('');
    setResult(null);
    track('prereject_review_start', { chars: payload.length, source: doc ? doc.kind : 'paste' });
    try {
      const res = await fetch('/api/review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ submission: payload, criteria, structure: doc?.structure ?? '' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '요청 실패');
      setResult(data.result as ReviewResult);
      track('prereject_review_done', { chars: payload.length, source: doc ? doc.kind : 'paste' });
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

        <label>제출물</label>

        <div
          className={`drop${dragging ? ' on' : ''}${parsing ? ' busy' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files?.[0];
            if (f) void takeFile(f);
          }}
          onClick={() => fileInput.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.current?.click(); }}
        >
          <input
            ref={fileInput}
            type="file"
            accept={acceptAttr()}
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void takeFile(f);
              e.target.value = ''; // 같은 파일 재선택도 동작하게
            }}
          />
          {parsing ? (
            <span className="drop-main">{parsing}</span>
          ) : (
            <>
              <span className="drop-main">피치덱·사업계획서 파일을 여기 끌어다 놓으세요</span>
              <span className="drop-sub">{describeSupport()} · 장표와 쪽 구분을 그대로 살려서 심사합니다</span>
              <span className="drop-sub">파일은 브라우저 안에서만 열립니다. 서버로 올라가지 않습니다.</span>
            </>
          )}
        </div>

        {doc && (
          <div className="filecard">
            <div className="filerow">
              <span className="filename">{doc.fileName}</span>
              <button className="linkbtn" type="button" onClick={() => { setDoc(null); setShowPreview(false); }}>
                제거
              </button>
            </div>
            <div className="filemeta">{doc.structure.split('\n')[0]} · 본문 {doc.totalChars.toLocaleString()}자</div>
            {doc.warning && <div className="warn">⚠ {doc.warning}</div>}
            {truncated && (
              <div className="warn">
                ⚠ 분량이 많아 앞에서부터 {fitted!.usedUnits}개까지만 심사합니다 (전체 {fitted!.totalUnits}개).
                뒷부분을 보려면 파일을 나눠서 올려 주세요.
              </div>
            )}
            <button className="linkbtn" type="button" onClick={() => setShowPreview((v) => !v)}>
              {showPreview ? '읽어낸 내용 접기' : '읽어낸 내용 확인'}
            </button>
            {showPreview && <pre className="preview">{doc.text.slice(0, 4000)}{doc.text.length > 4000 ? '\n…' : ''}</pre>}
          </div>
        )}

        <textarea
          rows={doc ? 4 : 10}
          placeholder={doc ? '덧붙일 설명이 있으면 여기에 (선택)' : '또는 여기에 직접 붙여넣으세요 — 지원서·사업계획서·자소서·피치 텍스트.'}
          value={submission}
          onChange={(e) => setSubmission(e.target.value)}
        />

        <button className="go" onClick={run} disabled={loading || !canRun}>
          {loading ? '심사위원 소집 중… (1분쯤 걸립니다)' : '나를 떨어뜨려봐'}
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
                {r.location && <span className="loc">{r.location}</span>}
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

      {/* 자동 진단이 못 보는 곳이 있다 — 사람이 읽는 쪽으로 넘기는 자리. */}
      {result && (
        <div className="deepdive">
          <div className="deepdive-head">더 깊게 보려면</div>
          <p>
            이 화면은 자동으로 낸 결과입니다.
            서류 전체와 공고문을 사람이 직접 대조해서
            반려 사유와 고쳐 쓸 문구까지 정리하는 건 따로 합니다.
          </p>
          <a
            className="deepdive-go"
            href="https://kmong.com/@Aithor"
            target="_blank"
            rel="noopener"
            onClick={() => track('prereject_deepdive_click')}
          >
            사람이 직접 보는 진단 &rsaquo;
          </a>
        </div>
      )}

      {result && (
        <div className="handoff">
          <div className="handoff-head">심사는 여기까지 자동입니다</div>
          <p>
            지원사업이든 공모전이든 붙고 나면 결국 만들어야 합니다.
            웹툴·랜딩·MVP를 3~5일에 만듭니다.
          </p>
          <div className="handoff-acts">
            <a
              className="handoff-go"
              href="https://ai-thor-studio-web.vercel.app/build.html?from=prereject"
              target="_blank"
              rel="noopener"
              onClick={() => track('prereject_handoff_click')}
            >
              만든 것들 보기 &rsaquo;
            </a>
            {/* 문의를 메일 클라이언트로 미루지 않는다 — 한 번 눌러 바로 대화창이 열리게. */}
            <a
              className="handoff-dm"
              href="https://ig.me/m/hyunmakes"
              target="_blank"
              rel="noopener"
              onClick={() => track('prereject_dm_click')}
            >
              바로 물어보기 (인스타 DM) &rsaquo;
            </a>
          </div>
        </div>
      )}

      <div className="foot">
        내부 점수는 개선 엔진이지 당락 예측기가 아닙니다 · 오픈소스 (MIT)
      </div>
    </div>
  );
}
