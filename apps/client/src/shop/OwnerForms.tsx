import { useMutation } from '@apollo/client';
import { ArrowLeft, Camera, FileText, X } from '@phosphor-icons/react';
import { useState } from 'react';
import { graphql } from '../gql';
import type { HoursDayInput } from '../gql/graphql';
import { getLang, t } from '../i18n';

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
const DAYS_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAYS_EN_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** The weekday as shown in the editor: 월 / Mon. */
const dayName = (i: number) => (getLang() === 'en' ? DAYS_EN[i] : DAYS[i]);

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
  // 사업자등록증 photo: resized here (long side 1600 px, enough to read the small print), sent with the claim.
  const [doc, setDoc] = useState<{ base64: string; preview: string } | null>(null);
  const [docBusy, setDocBusy] = useState(false);
  const [claim, { loading, error, data }] = useMutation(ClaimDoc);

  if (data) {
    return (
      <div>
        <button type="button" className="btn-text" onClick={onBack}>
          <ArrowLeft size={14} aria-hidden /> {t('가게로', 'Back to shop')}
        </button>
        <div className="region-note mt-3" role="status">
          <strong>{t('신청했어요.', 'Request sent.')}</strong>{' '}
          {getLang() === 'en'
            ? `${data.claimShop.checked ? 'We checked your business status with the National Tax Service. ' : ''}Once an admin reviews it, you'll see the result on My page. If approved, you can edit the hours and photos right on this shop's page.`
            : `${data.claimShop.checked ? '국세청에서 사업자 상태를 확인했고, ' : ''}관리자가 확인하면 마이페이지에서 결과를 볼 수 있어요. 승인되면 이 가게 화면에서 영업시간과 사진을 직접 고칠 수 있어요.`}
        </div>
      </div>
    );
  }
  return (
    <form
      className="owner-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!doc) return;
        claim({ variables: { shopId, input: { businessNo: no, ownerName: name, contact, message: message || null, documentBase64: doc.base64 } } }).catch(() => undefined);
      }}
    >
      <button type="button" className="btn-text" onClick={onBack}>
        <ArrowLeft size={14} aria-hidden /> {t('가게로', 'Back to shop')}
      </button>
      <h2 className="course-title mt-2">{getLang() === 'en' ? `Do you own ${shopName}?` : `${shopName} 사장님이세요?`}</h2>
      <p className="hint">
        {t(
          '사업자등록증과 신청 내용을 관리자가 대조한 뒤 승인해요. 승인되면 영업시간, 사진, 소개를 직접 올릴 수 있어요.',
          "An admin checks your business registration certificate against what you enter, then approves. Once approved, you can post your hours, photos and intro.",
        )}
      </p>

      <label className="field-label" htmlFor="claim-no">
        {t('사업자등록번호', 'Business registration number')} <span className="required">{t('(필수)', '(required)')}</span>
      </label>
      <input id="claim-no" inputMode="numeric" autoComplete="off" value={no} onChange={(e) => setNo(formatBusinessNo(e.target.value))} placeholder="123-45-67890" required />
      <label className="field-label" htmlFor="claim-name">
        {t('대표자 이름', 'Owner name')} <span className="required">{t('(필수)', '(required)')}</span>
      </label>
      <input id="claim-name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={30} required />
      <label className="field-label" htmlFor="claim-contact">
        {t('연락처', 'Contact')} <span className="required">{t('(필수)', '(required)')}</span>
      </label>
      <input id="claim-contact" autoComplete="tel" value={contact} onChange={(e) => setContact(e.target.value)} maxLength={50} placeholder={t('전화번호 또는 이메일', 'Phone or email')} required />
      <span className="hint d-block mt-1">{t('확인이 필요할 때만 연락드려요.', "We'll only contact you if we need to check something.")}</span>
      <div className="field-label">
        {t('사업자등록증 사진', 'Business registration certificate')} <span className="required">{t('(필수)', '(required)')}</span>
      </div>
      <label className={`doc-pick${doc ? ' has-doc' : ''}`}>
        {doc ? (
          <img src={doc.preview} alt={t('올린 사업자등록증', 'Your certificate')} />
        ) : (
          <span className="doc-pick-empty">
            <FileText size={22} aria-hidden />
            {docBusy ? t('줄이는 중…', 'Preparing…') : t('사진 찍기 또는 고르기', 'Take or choose a photo')}
          </span>
        )}
        <input
          type="file"
          accept="image/*"
          capture="environment"
          className="visually-hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            setDocBusy(true);
            try {
              const base64 = await jpeg(f, 1600);
              setDoc({ base64, preview: `data:image/jpeg;base64,${base64}` });
            } finally {
              setDocBusy(false);
            }
          }}
        />
      </label>
      {doc && (
        <button type="button" className="btn-text p-0" style={{ minHeight: 36 }} onClick={() => setDoc(null)}>
          <X size={14} aria-hidden /> {t('다른 사진으로', 'Use another photo')}
        </button>
      )}
      <span className="hint d-block mt-1">
        {t(
          '상호·대표자·번호가 보이게 찍어 주세요. 관리자만 보고, 승인이나 반려가 끝나면 바로 지워요.',
          'Make sure the shop name, owner and number are readable. Only an admin sees it, and it is deleted as soon as the request is decided.',
        )}
      </span>
      <label className="field-label" htmlFor="claim-message">
        {t('남길 말', 'Message')} <span className="hint d-inline">{t('(선택)', '(optional)')}</span>
      </label>
      <textarea id="claim-message" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} rows={3} />
      <label className="check-row">
        <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} required />
        {t(
          '본인이 이 가게의 대표자(또는 대표자에게 위임받은 사람)이며, 확인을 위해 위 정보를 쓰는 데 동의해요.',
          "I'm the owner of this shop (or authorised by the owner), and I agree to the use of this information for verification.",
        )}
      </label>
      {error && (
        <p className="field-error" role="alert">
          {error.message}
        </p>
      )}
      <button type="submit" className="btn-ink mt-3" disabled={loading || !agree || !doc}>
        {loading ? t('보내는 중…', 'Sending…') : t('사장님 신청하기', 'Claim this shop')}
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
        <ArrowLeft size={14} aria-hidden /> {t('가게로', 'Back to shop')}
      </button>
      <h2 className="course-title mt-2">{t('가게 정보 고치기', 'Edit shop info')}</h2>

      <fieldset className="hours-editor">
        <legend className="field-label">{t('영업시간', 'Opening hours')}</legend>
        {hours.map((h, i) => (
          <div key={DAYS[i]} className="hours-row">
            <span className="day">{dayName(i)}</span>
            <label className="check-row m-0">
              <input type="checkbox" checked={h.closed} onChange={(e) => setDay(i, { closed: e.target.checked })} /> {t('쉬는 날', 'Closed')}
            </label>
            {!h.closed && (
              <>
                <input type="time" aria-label={t(`${DAYS[i]}요일 여는 시간`, `${DAYS_EN_LONG[i]} opening time`)} value={h.open ?? ''} onChange={(e) => setDay(i, { open: e.target.value })} required />
                <span aria-hidden>~</span>
                <input type="time" aria-label={t(`${DAYS[i]}요일 닫는 시간`, `${DAYS_EN_LONG[i]} closing time`)} value={h.close ?? ''} onChange={(e) => setDay(i, { close: e.target.value })} required />
              </>
            )}
          </div>
        ))}
        <button type="button" className="btn-text p-0" style={{ minHeight: 36 }} onClick={() => setHours((h) => h.map(() => ({ ...h[0] })))}>
          {t('월요일과 같게 모두 맞추기', 'Copy Monday to all days')}
        </button>
      </fieldset>
      <label className="field-label" htmlFor="hours-note">
        {t('영업시간 메모', 'Hours note')} <span className="hint d-inline">{t('(선택)', '(optional)')}</span>
      </label>
      <input id="hours-note" value={hoursNote} maxLength={100} onChange={(e) => setHoursNote(e.target.value)} placeholder={t('예) 매월 마지막 월요일 휴무', 'e.g. Closed the last Monday of each month')} />

      <label className="field-label" htmlFor="owner-intro">
        {t('가게 소개', 'About the shop')} <span className="hint d-inline">{t('(선택)', '(optional)')}</span>
      </label>
      <textarea id="owner-intro" rows={4} maxLength={1000} value={intro} onChange={(e) => setIntro(e.target.value)} />
      <label className="field-label" htmlFor="owner-insta">
        {t('인스타그램 아이디', 'Instagram handle')} <span className="hint d-inline">{t('(선택)', '(optional)')}</span>
      </label>
      <input id="owner-insta" value={instagram} maxLength={60} onChange={(e) => setInstagram(e.target.value)} placeholder="@shop_name" />
      <label className="field-label" htmlFor="owner-phone">
        {t('전화', 'Phone')} <span className="hint d-inline">{t('(선택)', '(optional)')}</span>
      </label>
      <input id="owner-phone" type="tel" autoComplete="tel" value={phone} maxLength={30} onChange={(e) => setPhone(e.target.value)} />
      <label className="field-label" htmlFor="owner-web">
        {t('웹사이트·온라인 스토어', 'Website or online store')} <span className="hint d-inline">{t('(선택)', '(optional)')}</span>
      </label>
      <input id="owner-web" type="url" inputMode="url" autoComplete="url" value={website} maxLength={300} onChange={(e) => setWebsite(e.target.value)} placeholder="https://myshop.com" />

      <div className="field-label">{t('가게 사진', 'Shop photos')} ({photos.length}/6)</div>
      <ul className="owner-photos">
        {photos.map((url) => (
          <li key={url}>
            <img src={url} alt="" />
            <button
              type="button"
              className="photo-remove"
              aria-label={t('이 사진 지우기', 'Remove this photo')}
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
              <span>{addState.loading ? t('올리는 중…', 'Uploading…') : t('사진 추가', 'Add photo')}</span>
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
        {saveState.loading ? t('저장 중…', 'Saving…') : t('저장하기', 'Save')}
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
