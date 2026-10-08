import { ArrowRight, Camera, Sparkle, Warning } from '@phosphor-icons/react';
import { useRef, useState } from 'react';
import type { Origin, Planner } from './usePlanner';

const EXAMPLES = ['망원역 근처 빈티지랑 워크웨어 5곳, 3시간', '성수에서 미니멀한 옷 구경, 저렴하게', '홍대 스트릿 신발 위주로 반나절'];

interface Props {
  planner: Planner;
  /** Called with the region the text named (or null), before planning. */
  onRegion: (regionId: string | null) => void;
  fallbackOrigin: () => Origin | null;
  /** What the AI understood, kept for the result screen. */
  onEcho: (echo: Echo | null) => void;
}

export interface Echo {
  text: string;
  summary: string;
  notes: string[];
}

/** "어떤 코스를 원하세요?" — free text (and a photo) filled into the form by AI, then planned right away. */
export function PromptBox({ planner, onRegion, fallbackOrigin, onEcho }: Props) {
  const [text, setText] = useState('');
  const [echo, setEcho] = useState<{ summary: string; notes: string[] } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function submit(value = text) {
    if (!value.trim() || planner.busy) return;
    const res = await planner.fromText(value.trim());
    if (!res) return;
    const { parsed, form } = res;
    const notes = [...parsed.unsupported.map((u) => `${u}는 아직 못 해요`)];
    if (parsed.wantsCafe) notes.push('가는 길에 들를 카페를 넣었어요');
    if (parsed.wantsFood) notes.push('가는 길에 들를 맛집을 넣었어요');
    if (parsed.gender === 'men' || parsed.gender === 'women') notes.push(parsed.gender === 'men' ? '남성복 가게 위주로 골랐어요' : '여성복 가게 위주로 골랐어요');
    if (parsed.mustShops.length) notes.push(`꼭 넣을 가게: ${parsed.mustShops.map((m) => m.name).join(', ')}`);
    if (parsed.mustNotFound.length) notes.push(`${parsed.mustNotFound.join(', ')}은(는) 찾지 못했어요. ‘꼭 넣을 가게’에서 이름으로 찾아 주세요`);
    setEcho({ summary: parsed.summary, notes });
    onEcho({ text: value.trim(), summary: parsed.summary, notes });
    onRegion(parsed.regionId ?? null);
    const origin: Origin | null = parsed.regionId
      ? { regionId: parsed.regionId }
      : parsed.point
        ? { point: { lat: parsed.point.lat, lng: parsed.point.lng }, label: shortPlace(parsed.placeName) }
        : fallbackOrigin();
    if (origin) await planner.run(origin, form, 'text');
  }

  async function onPhoto(file: File | undefined) {
    if (!file) return;
    const description = await planner.fromPhoto(file);
    if (description) setEcho({ summary: `사진: ${description}`, notes: ['사진에서 찾은 스타일로 칩을 골랐어요. 지역을 고르고 코스를 짜 보세요'] });
    if (fileInput.current) fileInput.current.value = '';
  }

  return (
    <section className="section prompt" aria-labelledby="prompt-label">
      <h2 className="eyebrow" id="prompt-label">
        <span>Ask</span>
        <span className="ko">글로 말하기</span>
      </h2>
      <form
        className="prompt-box"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label htmlFor="prompt-input" className="visually-hidden">
          원하는 코스
        </label>
        <input
          id="prompt-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="어떤 코스를 원하세요? 예) 성수 빈티지 5곳"
          maxLength={500}
          enterKeyHint="go"
          autoComplete="off"
        />
        <button type="button" className="prompt-icon" aria-label="옷 사진으로 스타일 찾기" onClick={() => fileInput.current?.click()} disabled={planner.busy}>
          <Camera size={20} />
        </button>
        <button type="submit" className="prompt-go" aria-label="이 글로 코스 짜기" disabled={planner.busy || !text.trim()}>
          <ArrowRight size={20} />
        </button>
        <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => onPhoto(e.target.files?.[0])} />
      </form>

      {planner.reading && (
        <p className="hint d-flex align-items-center gap-1" role="status">
          <Sparkle size={14} aria-hidden /> 읽는 중…
        </p>
      )}
      {!planner.reading && echo && (
        <div className="prompt-echo" role="status">
          <Sparkle size={14} aria-hidden />
          <div>
            <div>{echo.summary}</div>
            {echo.notes.map((n) => (
              <div key={n} className="prompt-note">
                <Warning size={12} aria-hidden /> {n}
              </div>
            ))}
          </div>
        </div>
      )}
      {!echo && !planner.reading && (
        <div className="prompt-examples">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              className="btn-text"
              onClick={() => {
                setText(ex);
                submit(ex);
              }}
            >
              {ex}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/** "망원역 6호선" → "망원역": Kakao place names often carry a line or branch after the name. */
function shortPlace(name: string | null | undefined): string | undefined {
  return name ? name.split(' ')[0] : undefined;
}
