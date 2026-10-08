import { useMutation } from '@apollo/client';
import { ArrowLeft, Camera, X } from '@phosphor-icons/react';
import { useState } from 'react';
import { graphql } from '../gql';
import type { HoursDayInput } from '../gql/graphql';

const ClaimDoc = graphql(`
  mutation ClaimShop($shopId: ID!, $input: OwnerClaimInput!) {
    claimShop(shopId: $shopId, input: $input) { id status checked }
  }
`);

const UpdateInfoDoc = graphql(`
  mutation UpdateShopInfo($shopId: ID!, $input: ShopInfoInput!) {
    updateShopInfo(shopId: $shopId, input: $input)
  }
`);

const AddPhotoDoc = graphql(`
  mutation AddShopPhoto($shopId: ID!, $imageBase64: String!) {
    addShopPhoto(shopId: $shopId, imageBase64: $imageBase64)
  }
`);

const RemovePhotoDoc = graphql(`
  mutation RemoveShopPhoto($shopId: ID!, $url: String!) {
    removeShopPhoto(shopId: $shopId, url: $url)
  }
`);

export const DAYS = ['월', '화', '수', '목', '금', '토', '일'];

/** 123-45-67890 while typing. */
function formatBusinessNo(v: string): string {
  const d = v.replace(/\D/g, '').slice(0, 10);
  return [d.slice(0, 3), d.slice(3, 5), d.slice(5)].filter(Boolean).join('-');
}

/** "이 가게 사장님이세요?": business number, name, contact. An admin approves; the result shows on my page. */
export function ClaimForm({ shopId, shopName, onBack }: { shopId: string; shopName: string; onBack: () => void }) {
  const [no, setNo] = useState('');
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [message, setMessage] = useState('');
  const [agree, setAgree] = useState(false);
  const [claim, { loading, error, data }] = useMutation(ClaimDoc);

  if (data) {
    return (
      <div>
        <button type="button" className="btn-text" onClick={onBack}>
          <ArrowLeft size={14} aria-hidden /> 가게로
        </button>
        <div className="region-note mt-3" role="status">
          <strong>신청했어요.</strong> {data.claimShop.checked ? '국세청에서 사업자 상태를 확인했고, ' : ''}관리자가 확인하면 마이페이지에서 결과를 볼 수
          있어요. 승인되면 이 가게 화면에서 영업시간과 사진을 직접 고칠 수 있어요.
        </div>
      </div>
    );
  }
  return (
    <form
      className="owner-form"
      onSubmit={(e) => {
        e.preventDefault();
        claim({ variables: { shopId, input: { businessNo: no, ownerName: name, contact, message: message || null } } }).catch(() => undefined);
      }}
    >
      <button type="button" className="btn-text" onClick={onBack}>
        <ArrowLeft size={14} aria-hidden /> 가게로
      </button>
      <h2 className="course-title mt-2">{shopName} 사장님이세요?</h2>
      <p className="hint">사업자등록번호로 확인한 뒤 관리자가 승인해요. 승인되면 영업시간, 사진, 소개를 직접 올릴 수 있어요.</p>

      <label className="field-label" htmlFor="claim-no">
        사업자등록번호 <span className="required">(필수)</span>
      </label>
      <input id="claim-no" inputMode="numeric" autoComplete="off" value={no} onChange={(e) => setNo(formatBusinessNo(e.target.value))} placeholder="123-45-67890" required />
      <label className="field-label" htmlFor="claim-name">
        대표자 이름 <span className="required">(필수)</span>
      </label>
      <input id="claim-name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={30} required />
      <label className="field-label" htmlFor="claim-contact">
        연락처 <span className="required">(필수)</span>
      </label>
      <input id="claim-contact" autoComplete="tel" value={contact} onChange={(e) => setContact(e.target.value)} maxLength={50} placeholder="전화번호 또는 이메일" required />
      <span className="hint d-block mt-1">확인이 필요할 때만 연락드려요.</span>
      <label className="field-label" htmlFor="claim-message">
        남길 말 <span className="hint d-inline">(선택)</span>
      </label>
      <textarea id="claim-message" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} rows={3} />
      <label className="check-row">
        <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} required />
        본인이 이 가게의 대표자(또는 대표자에게 위임받은 사람)이며, 확인을 위해 위 정보를 쓰는 데 동의해요.
      </label>
      {error && (
        <p className="field-error" role="alert">
          {error.message}
        </p>
      )}
      <button type="submit" className="btn-ink mt-3" disabled={loading || !agree}>
        {loading ? '보내는 중…' : '사장님 신청하기'}
      </button>
    </form>
  );
}

export interface OwnerInfoValue {
  hours?: { closed: boolean; open?: string | null; close?: string | null }[] | null;
  hoursNote?: string | null;
  intro?: string | null;
  instagram?: string | null;
  phone?: string | null;
  website?: string | null;
  photos: string[];
}

const EMPTY_DAY = { closed: false, open: '11:00', close: '21:00' };

/** The owner's editor: hours for each weekday, a note, intro, links, photos (up to 6). */
export function OwnerEditor({ shopId, initial, onDone }: { shopId: string; initial: OwnerInfoValue | null; onDone: () => void }) {
  const [hours, setHours] = useState<HoursDayInput[]>(
    initial?.hours?.length === 7 ? initial.hours.map((h) => ({ closed: h.closed, open: h.open ?? '', close: h.close ?? '' })) : DAYS.map(() => ({ ...EMPTY_DAY })),
  );
  const [hoursNote, setHoursNote] = useState(initial?.hoursNote ?? '');
  const [intro, setIntro] = useState(initial?.intro ?? '');
  const [instagram, setInstagram] = useState(initial?.instagram ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [website, setWebsite] = useState(initial?.website ?? '');
  const [photos, setPhotos] = useState<string[]>(initial?.photos ?? []);
  const [save, saveState] = useMutation(UpdateInfoDoc);
  const [addPhoto, addState] = useMutation(AddPhotoDoc);
  const [removePhoto] = useMutation(RemovePhotoDoc);
  const [photoError, setPhotoError] = useState<string | null>(null);

  const setDay = (i: number, patch: Partial<HoursDayInput>) => setHours((h) => h.map((d, j) => (j === i ? { ...d, ...patch } : d)));

  return (
    <form
      className="owner-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const input = {
          hours: hours.map((h) => (h.closed ? { closed: true } : { closed: false, open: h.open, close: h.close })),
          hoursNote: hoursNote || null, intro: intro || null, instagram: instagram || null, phone: phone || null, website: website || null,
        };
        const res = await save({ variables: { shopId, input } }).catch(() => null);
        if (res?.data) onDone();
      }}
    >
      <button type="button" className="btn-text" onClick={onDone}>
        <ArrowLeft size={14} aria-hidden /> 가게로
      </button>
      <h2 className="course-title mt-2">가게 정보 고치기</h2>

      <fieldset className="hours-editor">
        <legend className="field-label">영업시간</legend>
        {hours.map((h, i) => (
          <div key={DAYS[i]} className="hours-row">
            <span className="day">{DAYS[i]}</span>
            <label className="check-row m-0">
              <input type="checkbox" checked={h.closed} onChange={(e) => setDay(i, { closed: e.target.checked })} /> 쉬는 날
            </label>
            {!h.closed && (
              <>
                <input type="time" aria-label={`${DAYS[i]}요일 여는 시간`} value={h.open ?? ''} onChange={(e) => setDay(i, { open: e.target.value })} required />
                <span aria-hidden>~</span>
                <input type="time" aria-label={`${DAYS[i]}요일 닫는 시간`} value={h.close ?? ''} onChange={(e) => setDay(i, { close: e.target.value })} required />
              </>
            )}
          </div>
        ))}
        <button type="button" className="btn-text p-0" style={{ minHeight: 36 }} onClick={() => setHours((h) => h.map(() => ({ ...h[0] })))}>
          월요일과 같게 모두 맞추기
        </button>
      </fieldset>
      <label className="field-label" htmlFor="hours-note">
        영업시간 메모 <span className="hint d-inline">(선택)</span>
      </label>
      <input id="hours-note" value={hoursNote} maxLength={100} onChange={(e) => setHoursNote(e.target.value)} placeholder="예) 매월 마지막 월요일 휴무" />

      <label className="field-label" htmlFor="owner-intro">
        가게 소개 <span className="hint d-inline">(선택)</span>
      </label>
      <textarea id="owner-intro" rows={4} maxLength={1000} value={intro} onChange={(e) => setIntro(e.target.value)} />
      <label className="field-label" htmlFor="owner-insta">
        인스타그램 아이디 <span className="hint d-inline">(선택)</span>
      </label>
      <input id="owner-insta" value={instagram} maxLength={60} onChange={(e) => setInstagram(e.target.value)} placeholder="@shop_name" />
      <label className="field-label" htmlFor="owner-phone">
        전화 <span className="hint d-inline">(선택)</span>
      </label>
      <input id="owner-phone" type="tel" autoComplete="tel" value={phone} maxLength={30} onChange={(e) => setPhone(e.target.value)} />
      <label className="field-label" htmlFor="owner-web">
        웹사이트·온라인 스토어 <span className="hint d-inline">(선택)</span>
      </label>
      <input id="owner-web" type="url" inputMode="url" autoComplete="url" value={website} maxLength={300} onChange={(e) => setWebsite(e.target.value)} placeholder="https://myshop.com" />

      <div className="field-label">가게 사진 ({photos.length}/6)</div>
      <ul className="owner-photos">
        {photos.map((url) => (
          <li key={url}>
            <img src={url} alt="" />
            <button
              type="button"
              className="photo-remove"
              aria-label="이 사진 지우기"
              onClick={async () => {
                const res = await removePhoto({ variables: { shopId, url } }).catch(() => null);
                if (res?.data) setPhotos(res.data.removeShopPhoto);
              }}
            >
              <X size={14} />
            </button>
          </li>
        ))}
        {photos.length < 6 && (
          <li>
            <label className="photo-add">
              <Camera size={20} aria-hidden />
              <span>{addState.loading ? '올리는 중…' : '사진 추가'}</span>
              <input
                type="file"
                accept="image/*"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (!f) return;
                  setPhotoError(null);
                  const res = await addPhoto({ variables: { shopId, imageBase64: await jpeg(f, 1200) } }).catch((err: Error) => (setPhotoError(err.message), null));
                  if (res?.data) setPhotos(res.data.addShopPhoto);
                }}
              />
            </label>
          </li>
        )}
      </ul>
      {photoError && (
        <p className="field-error" role="alert">
          {photoError}
        </p>
      )}
      {saveState.error && (
        <p className="field-error" role="alert">
          {saveState.error.message}
        </p>
      )}
      <button type="submit" className="btn-ink mt-3" disabled={saveState.loading}>
        {saveState.loading ? '저장 중…' : '저장하기'}
      </button>
    </form>
  );
}

/** Shrink so the long side is at most `max` px, as JPEG base64 (no data: prefix). */
async function jpeg(file: File, max: number): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL('image/jpeg', 0.85);
  return url.slice(url.indexOf(',') + 1);
}
