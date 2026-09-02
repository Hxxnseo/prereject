// 첨부파일 → 구조 보존 텍스트 추출 (전부 브라우저 안에서 수행)
//
// 🔴 설계 원칙 두 가지
// 1) 파일은 서버로 보내지 않는다. 사업계획서·피치덱은 민감 문서다. 브라우저에서 텍스트만
//    뽑아 그 텍스트만 전송한다. 부수 효과로 Vercel 바디 상한(4.5MB)과도 무관해진다.
// 2) 장표/쪽 경계를 지운 평문은 피치덱 심사를 무력화한다. "7쪽에 글이 너무 많다",
//    "재무가 마지막 장에 한 줄" 같은 지적은 경계가 살아 있어야만 가능하다.
//    그래서 units[]로 쪼개고 [N쪽]/[슬라이드 N] 마커를 붙여 조립한다.

export type DocKind = 'pdf' | 'pptx' | 'docx' | 'hwp' | 'hwpx' | 'text';

export interface DocUnit {
  label: string; // "3쪽" · "슬라이드 3" · "슬라이드 3 · 발표자 노트"
  text: string;
}

export interface ExtractedDoc {
  kind: DocKind;
  fileName: string;
  units: DocUnit[];
  /** 마커 포함 조립본 — 그대로 모델에 넘어간다 */
  text: string;
  totalChars: number;
  /** 결정론적으로 계산한 구조 요약. 모델이 분량 편중을 판정하는 근거가 된다 */
  structure: string;
  /** 사용자에게 정직하게 알려야 하는 사항 (이미지 전용 PDF 등) */
  warning?: string;
}

export class ExtractError extends Error {}

/** XML 문자열에서 지정한 localName 태그를 네임스페이스 무관하게 수집 */
function tagsOf(xml: string, localName: string): Element[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new ExtractError('XML_PARSE');
  return Array.from(doc.getElementsByTagName('*')).filter((el) => el.localName === localName);
}

/** 파일명 끝 숫자 기준 정렬 (slide2 < slide10 — 사전순은 틀린다) */
function byTrailingNumber(a: string, b: string): number {
  const n = (s: string) => Number(s.match(/(\d+)\D*$/)?.[1] ?? 0);
  return n(a) - n(b);
}

function squash(s: string): string {
  return s.replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// ─────────────────────────── PDF ───────────────────────────

async function fromPdf(file: File): Promise<Pick<ExtractedDoc, 'units' | 'warning'>> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // 워커는 public/ 에 복사해 둔 파일을 쓴다 (prebuild 스크립트). 번들러 마법에 의존하지 않는다.
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

  const buf = await file.arrayBuffer();
  const task = pdfjs.getDocument({ data: buf });
  const pdf = await task.promise;
  const units: DocUnit[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // items 를 y 좌표 변화로 줄바꿈 복원 — 한 줄로 뭉치면 표·불릿 구조가 사라진다.
    let text = '';
    let lastY: number | null = null;
    for (const item of content.items as Array<{ str?: string; transform?: number[]; hasEOL?: boolean }>) {
      if (typeof item.str !== 'string') continue;
      const y = item.transform?.[5] ?? null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 3) text += '\n';
      text += item.str;
      if (item.hasEOL) text += '\n';
      if (y !== null) lastY = y;
    }
    units.push({ label: `${i}쪽`, text: squash(text) });
  }
  await task.destroy(); // 문서가 아니라 loadingTask 가 워커를 쥐고 있다

  const chars = units.reduce((n, u) => n + u.text.length, 0);
  const warning =
    chars < units.length * 30
      ? '이 PDF는 글자 대신 이미지로 저장돼 있어 본문을 거의 읽지 못했습니다. 원본(PPT·Word·HWP)에서 다시 내보내거나 텍스트를 직접 붙여넣어 주세요.'
      : undefined;
  return { units, warning };
}

// ─────────────────────────── PPTX ───────────────────────────

async function fromPptx(file: File): Promise<Pick<ExtractedDoc, 'units'>> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());

  const slidePaths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort(byTrailingNumber);
  if (!slidePaths.length) throw new ExtractError('NO_SLIDES');

  const units: DocUnit[] = [];
  for (let i = 0; i < slidePaths.length; i++) {
    const n = i + 1;
    const xml = await zip.file(slidePaths[i])!.async('string');
    // <a:p> 단락 단위로 줄을 만든다 — 불릿 구조가 심사 대상이다.
    const lines = tagsOf(xml, 'p')
      .map((p) =>
        Array.from(p.getElementsByTagName('*'))
          .filter((el) => el.localName === 't')
          .map((t) => t.textContent ?? '')
          .join(''),
      )
      .map((s) => s.trim())
      .filter(Boolean);
    units.push({ label: `슬라이드 ${n}`, text: squash(lines.join('\n')) });

    // 발표자 노트는 번호가 아니라 rels 로 연결된다. 번호로 짐작하면 다른 장 노트가 붙는다.
    const relsFile = zip.file(`ppt/slides/_rels/${slidePaths[i].split('/').pop()}.rels`);
    if (!relsFile) continue;
    const relsXml = await relsFile.async('string');
    const notesTarget = tagsOf(relsXml, 'Relationship')
      .map((r) => r.getAttribute('Target') ?? '')
      .find((t) => t.includes('notesSlide'));
    if (!notesTarget) continue;
    const notesPath = `ppt/${notesTarget.replace(/^\.\.\//, '')}`;
    const notesFile = zip.file(notesPath);
    if (!notesFile) continue;
    const notesXml = await notesFile.async('string');
    const notes = squash(
      tagsOf(notesXml, 't')
        .map((t) => t.textContent ?? '')
        .join(' '),
    );
    // 슬라이드 번호만 적힌 노트 플레이스홀더는 버린다.
    if (notes && notes.replace(/\d/g, '').trim().length > 3) {
      units.push({ label: `슬라이드 ${n} · 발표자 노트`, text: notes });
    }
  }
  return { units };
}

// ─────────────────────────── DOCX ───────────────────────────

async function fromDocx(file: File): Promise<Pick<ExtractedDoc, 'units'>> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const entry = zip.file('word/document.xml');
  if (!entry) throw new ExtractError('NO_DOCUMENT');
  const xml = await entry.async('string');

  // docx 에는 확정된 쪽 경계가 없다(레이아웃 시점에 정해진다). Word 가 기록해 둔
  // 렌더 시점 페이지 구분만 신뢰하고, 없으면 쪽을 지어내지 않고 한 덩어리로 둔다.
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const paras = Array.from(doc.getElementsByTagName('*')).filter((el) => el.localName === 'p');

  const pages: string[][] = [[]];
  for (const p of paras) {
    const kids = Array.from(p.getElementsByTagName('*'));
    const broke = kids.some(
      (el) =>
        el.localName === 'lastRenderedPageBreak' ||
        (el.localName === 'br' && (el.getAttribute('w:type') ?? el.getAttribute('type')) === 'page'),
    );
    if (broke) pages.push([]);
    const line = kids
      .filter((el) => el.localName === 't')
      .map((t) => t.textContent ?? '')
      .join('')
      .trim();
    if (line) pages[pages.length - 1].push(line);
  }

  const filled = pages.filter((p) => p.length);
  if (filled.length <= 1) return { units: [{ label: '본문', text: squash(filled[0]?.join('\n') ?? '') }] };
  return { units: filled.map((lines, i) => ({ label: `${i + 1}쪽`, text: squash(lines.join('\n')) })) };
}

// ─────────────────────── 한글 (.hwp / .hwpx) ───────────────────────

// rhwp(Rust/WASM, MIT)를 쓴다. 손으로 짠 파서로는 **쪽 경계를 낼 수 없기 때문**이다 —
// 한글 문서의 페이지는 저장된 값이 아니라 조판 시점에 정해진다. rhwp 는 실제로 조판해서
// pageCount()/getPageText() 를 주므로 PDF 와 같은 [N쪽] 마커를 붙일 수 있다.
// 대가는 8MB WASM 이라 동적 import 로 격리한다 — 한글 파일을 올린 사람만 내려받는다.
type RhwpModule = {
  default: (opts: { module_or_path: string }) => Promise<unknown>;
  HwpDocument: new (data: Uint8Array) => {
    pageCount(): number;
    getPageTextLayout(i: number): string;   // 조판된 TextRun (표 포함)
    getTextFileUnicode(): string;           // 문서 전문 (쪽 경계 없음)
    free?(): void;
  };
};

let rhwpReady: Promise<RhwpModule> | null = null;

function loadRhwp(): Promise<RhwpModule> {
  if (!rhwpReady) {
    rhwpReady = (async () => {
      const mod = (await import('@rhwp/core')) as unknown as RhwpModule;
      // 조판에는 글자 폭이 필요하다. rhwp 가 전역 훅으로 요구하므로 canvas 로 재서 넘긴다.
      const g = globalThis as unknown as { measureTextWidth?: (font: string, text: string) => number };
      if (!g.measureTextWidth) {
        let ctx: CanvasRenderingContext2D | null = null;
        let lastFont = '';
        g.measureTextWidth = (font: string, text: string) => {
          if (!ctx) ctx = document.createElement('canvas').getContext('2d');
          if (!ctx) return 0;
          if (font !== lastFont) { ctx.font = font; lastFont = font; }
          return ctx.measureText(text).width;
        };
      }
      await mod.default({ module_or_path: '/rhwp_bg.wasm' });
      return mod;
    })().catch((e) => { rhwpReady = null; throw e; }); // 실패를 캐시하지 않는다(다시 시도 가능해야 한다)
  }
  return rhwpReady;
}

/** rhwp 가 JSON 문자열로 돌려주는 값을 실제 문자열로 되돌린다 */
function unquote(raw: string): string {
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === 'string' ? v : raw;
  } catch {
    return raw;
  }
}

/** 조판된 TextRun 배열 → y 좌표 변화로 줄바꿈을 복원한 텍스트 */
function runsToText(rawJson: string): string {
  let runs: Array<{ text?: string; y?: number }>;
  try {
    runs = (JSON.parse(rawJson) as { runs?: Array<{ text?: string; y?: number }> }).runs ?? [];
  } catch {
    return '';
  }
  let out = '';
  let lastY: number | null = null;
  for (const r of runs) {
    if (!r.text) continue;
    if (lastY !== null && typeof r.y === 'number' && Math.abs(r.y - lastY) > 1) out += '\n';
    out += r.text;
    if (typeof r.y === 'number') lastY = r.y;
  }
  return out;
}

async function fromHancom(file: File): Promise<Pick<ExtractedDoc, 'units'>> {
  const { HwpDocument } = await loadRhwp();
  const doc = new HwpDocument(new Uint8Array(await file.arrayBuffer()));
  try {
    // 🔴 getPageText() 를 쓰지 말 것. 본문 문단만 주고 **표 안 글자를 통째로 빠뜨린다** —
    // 실측(모바일기술대상 신청서 16쪽): getPageText 2,417자 vs 조판 레이아웃 21,341자.
    // 한국 신청서는 대부분 표라서 그 경로로는 89%를 잃는다.
    const n = doc.pageCount();
    const units: DocUnit[] = [];
    for (let i = 0; i < n; i++) {
      units.push({ label: `${i + 1}쪽`, text: squash(runsToText(doc.getPageTextLayout(i))) });
    }
    if (units.some((u) => u.text.length > 0)) return { units };

    // 조판이 비면 쪽 경계를 포기하고 전문이라도 살린다. 쪽을 지어내지는 않는다.
    const whole = squash(unquote(doc.getTextFileUnicode()));
    if (whole.length > 0) return { units: [{ label: '본문', text: whole }] };
    throw new ExtractError('EMPTY');
  } finally {
    doc.free?.();
  }
}

// ─────────────────────────── HWPX ───────────────────────────

async function fromHwpx(file: File): Promise<Pick<ExtractedDoc, 'units'>> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const paths = Object.keys(zip.files)
    .filter((p) => /Contents\/section\d+\.xml$/i.test(p))
    .sort(byTrailingNumber);
  if (!paths.length) throw new ExtractError('NO_SECTION');

  const units: DocUnit[] = [];
  for (let i = 0; i < paths.length; i++) {
    const xml = await zip.file(paths[i])!.async('string');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const lines = Array.from(doc.getElementsByTagName('*'))
      .filter((el) => el.localName === 'p')
      .map((p) =>
        Array.from(p.getElementsByTagName('*'))
          .filter((el) => el.localName === 't')
          .map((t) => t.textContent ?? '')
          .join(''),
      )
      .map((s) => s.trim())
      .filter(Boolean);
    // 확장자만 .hwpx 인 변종이 실제로 돈다(내부가 hp:p/hp:t 가 아닌 평문 XML). 문단 구조를
    // 못 찾았는데 텍스트는 있는 경우, 빈 결과 대신 구역 전체 텍스트로 떨어뜨린다.
    const text = lines.length ? lines.join('\n') : (doc.documentElement?.textContent ?? '');
    units.push({ label: paths.length > 1 ? `${i + 1}구역` : '본문', text: squash(text) });
  }
  return { units };
}

// ─────────────────────────── 진입점 ───────────────────────────

const EXT_LABEL: Record<string, string> = {
  pdf: 'PDF', pptx: 'PowerPoint', docx: 'Word', hwp: '한글', hwpx: '한글', txt: '텍스트', md: '텍스트',
};

export function acceptAttr(): string {
  return '.pdf,.pptx,.docx,.hwp,.hwpx,.txt,.md';
}

export function describeSupport(): string {
  return 'PDF · PPTX · DOCX · HWP · HWPX · TXT';
}

/** 결정론적 구조 요약 — 분량 편중 판정은 계산이지 추론이 아니다 (SP#18) */
function summarize(kind: DocKind, units: DocUnit[]): string {
  const noun = kind === 'pptx' ? '슬라이드' : units.some((u) => u.label.endsWith('쪽')) ? '쪽' : '구역';
  const body = units.filter((u) => !u.label.includes('발표자 노트'));
  const counts = body.map((u) => `${u.label} ${u.text.length}자`).join(' · ');
  const nonEmpty = body.filter((u) => u.text.length > 0).length;
  const notes = units.length - body.length;
  const head = `${EXT_LABEL[kind] ?? kind} · 총 ${body.length}${noun} (내용 있는 ${noun} ${nonEmpty}개${notes ? `, 발표자 노트 ${notes}개` : ''})`;
  return `${head}\n${counts}`;
}

export async function extractFile(file: File): Promise<ExtractedDoc> {
  const ext = (file.name.split('.').pop() ?? '').toLowerCase();

  let kind: DocKind;
  let part: Pick<ExtractedDoc, 'units'> & { warning?: string };

  if (ext === 'pdf') { kind = 'pdf'; part = await fromPdf(file); }
  else if (ext === 'pptx') { kind = 'pptx'; part = await fromPptx(file); }
  else if (ext === 'docx') { kind = 'docx'; part = await fromDocx(file); }
  else if (ext === 'hwp' || ext === 'hwpx') {
    kind = ext as DocKind;
    try {
      part = await fromHancom(file);
    } catch (e) {
      // hwpx 는 zip+xml 이라 자체 파서로 되살릴 수 있다. hwp 는 되살릴 길이 없으므로 그대로 알린다.
      if (ext === 'hwpx') part = await fromHwpx(file);
      else throw new ExtractError(
        e instanceof Error && /password|encrypt/i.test(e.message)
          ? '암호가 걸린 한글 문서는 읽지 못합니다. 암호를 푼 사본을 올려 주세요.'
          : '이 한글 문서를 읽지 못했습니다. 한글에서 "PDF로 저장"한 뒤 올려 주세요.',
      );
    }
  }
  else if (ext === 'txt' || ext === 'md') {
    kind = 'text';
    part = { units: [{ label: '본문', text: squash(await file.text()) }] };
  } else {
    throw new ExtractError(`${ext ? `.${ext}` : '이 형식'}은 지원하지 않습니다. ${describeSupport()} 중 하나로 올려 주세요.`);
  }

  const units = part.units;
  const text = units
    .filter((u) => u.text.length > 0)
    .map((u) => `[${u.label}]\n${u.text}`)
    .join('\n\n');

  return {
    kind,
    fileName: file.name,
    units,
    text,
    totalChars: text.length,
    structure: summarize(kind, units),
    warning: part.warning,
  };
}
