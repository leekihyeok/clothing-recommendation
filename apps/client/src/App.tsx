import { useQuery } from '@apollo/client';
import { ArrowLeft, ArrowRight, NavigationArrow } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSheet } from './layout/useSheet';
import { Logo } from './brand/Logo';
import { HealthPanel } from './components/HealthPanel';
import { User } from '@phosphor-icons/react';
import { MyPage } from './me/MyPage';
import { useProfile } from './me/useProfile';
import { Avatar } from './shop/ShopDetail';
import { takeLoginResult } from './me/useAccount';
import { CourseForm } from './course/CourseForm';
import { CourseResult } from './course/CourseResult';
import { useCourseEdit } from './course/useCourseEdit';
import { SHARE_PARAM, SHOP_PARAM, useLoadCourse } from './course/useSavedCourses';
import { PlanProgress } from './course/PlanProgress';
import { PresetRow } from './course/PresetRow';
import { type Echo, PromptBox } from './course/PromptBox';
import { type PlannedCourse, usePlanner } from './course/usePlanner';
import { graphql } from './gql';
import { SHOP_CATEGORIES } from './map/categories';
import { RegionBar } from './map/RegionBar';
import { LoginModal } from './me/LoginModal';
import { ShopDetail } from './shop/ShopDetail';
import { type MapBounds, type MapCourse, ShopMap, type ViewportInfo } from './map/ShopMap';

const ALL = SHOP_CATEGORIES.map((c) => c.id as string);

// Stable empty list so the map's region effect doesn't re-run on every render while loading.
const NO_REGIONS: never[] = [];

const RegionsDoc = graphql(`
  query Regions {
    regions {
      id name intro shopCount
      polygon { lat lng }
      categories { category count }
    }
  }
`);

export function App() {
  const [categories, setCategories] = useState<string[]>(ALL);
  // The shop detail on screen (?shop=<id> in the address, so it can be linked and survives a reload).
  const [detailId, setDetailId] = useState<string | null>(() => new URLSearchParams(window.location.search).get(SHOP_PARAM));
  const [viewport, setViewport] = useState<ViewportInfo | null>(null);
  const [regionId, setRegionId] = useState<string | null>(null);
  const [mapCenter, setMapCenter] = useState<{ lat: number; lng: number } | null>(null);
  const [course, setCourse] = useState<PlannedCourse | null>(null);
  const [variantIndex, setVariantIndex] = useState(0);
  const [hoverOrder, setHoverOrder] = useState<number | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const headRef = useRef<HTMLElement>(null);
  const footRef = useRef<HTMLElement>(null);
  // Phone bottom sheet: peek shows the handle, header and the main button.
  const sheet = useSheet(panelRef, () => 28 + (headRef.current?.offsetHeight ?? 80) + (footRef.current?.offsetHeight ?? 120));
  // Back from Kakao login (?login=…): open "내 가게", where the login started, with a line about how it went.
  const [loginNotice] = useState(takeLoginResult);
  const [showMine, setShowMine] = useState(loginNotice !== null);
  const [pickMode, setPickMode] = useState(false);
  const [echo, setEcho] = useState<Echo | null>(null);
  const [picked, setPicked] = useState<{ lat: number; lng: number } | null>(null);
  const [focusShop, setFocusShop] = useState<{ lat: number; lng: number } | null>(null);
  const profile = useProfile().data?.myProfile ?? null;
  const loadCourse = useLoadCourse();
  const [openNote, setOpenNote] = useState<string | null>(null);
  // The course in the address (?c=<id>) when the page loaded: a share link, or this user's own course after a reload.
  const [initialLink] = useState(() => new URLSearchParams(window.location.search).get(SHARE_PARAM));
  const [mapBounds, setMapBounds] = useState<MapBounds | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const regions = useQuery(RegionsDoc).data?.regions ?? NO_REGIONS;
  const region = regions.find((r) => r.id === regionId) ?? null;

  const planner = usePlanner((c) => {
    editor.reset();
    sheet.setSnap('half'); // phones: the route on the map above, the list below
    setVariantIndex(0);
    setCourse(c);
    body.current?.scrollTo({ top: 0 });
  });
  const editor = useCourseEdit(course, variantIndex, setCourse);
  const styleLabels = useMemo(
    () => Object.fromEntries((planner.catalog?.styles ?? []).map((s) => [s.id, s.label])),
    [planner.catalog],
  );

  /** A saved course (share link, "최근 코스") back on screen, with its conditions in the form. */
  async function openCourse(id: string) {
    setOpenNote(null);
    const c = await loadCourse(id);
    if (!c) {
      setOpenNote('코스를 찾지 못했어요. 링크가 맞는지 확인해 주세요');
      return;
    }
    planner.adopt(c);
    editor.reset();
    setEcho(null);
    setShowMine(false);
    setRegionId(c.request.regionId ?? null);
    setVariantIndex(0);
    setCourse(c);
    sheet.setSnap('half');
    body.current?.scrollTo({ top: 0 });
  }

  const opened = useRef(false);
  useEffect(() => {
    if (initialLink && !opened.current) {
      opened.current = true; // once, also under StrictMode's double effects
      openCourse(initialLink);
    }
  }, [initialLink]); // eslint-disable-line react-hooks/exhaustive-deps

  // What's on screen lives in the address (?c=<course>, ?shop=<shop>), so a reload or a copied URL brings it back.
  // Opening something is a new history entry (browser back closes it); replacing or closing it edits the current one.
  const courseId = course?.id ?? null;
  useEffect(() => {
    const url = new URL(window.location.href);
    const was = { c: url.searchParams.get(SHARE_PARAM), shop: url.searchParams.get(SHOP_PARAM) };
    if (was.c === courseId && was.shop === detailId) return;
    if (!courseId && openNote) return; // a link that didn't open stays visible while the note explains
    for (const [k, v] of [[SHARE_PARAM, courseId], [SHOP_PARAM, detailId]] as const) {
      if (v) url.searchParams.set(k, v);
      else url.searchParams.delete(k);
    }
    const opened = (!was.c && courseId) || (!was.shop && detailId);
    if (opened) window.history.pushState(null, '', url);
    else window.history.replaceState(null, '', url);
  }, [courseId, detailId, openNote]);

  // Browser back / forward: follow the address.
  const courseRef = useRef(course);
  courseRef.current = course;
  useEffect(() => {
    const onPop = () => {
      const params = new URLSearchParams(window.location.search);
      const id = params.get(SHARE_PARAM);
      setDetailId(params.get(SHOP_PARAM));
      if (!id) setCourse(null);
      else if (id !== courseRef.current?.id) openCourse(id);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Shop detail on top of whatever the panel shows; phones get the full sheet for it. */
  function openShop(id: string) {
    setShowMine(false);
    setDetailId(id);
    sheet.setSnap('full');
    body.current?.scrollTo({ top: 0 });
  }

  // Opened from a ?shop= link: phones show the detail on the full sheet, as when tapping a shop.
  useEffect(() => {
    if (detailId) sheet.setSnap('full');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const itemLabels = useMemo(
    () => Object.fromEntries((planner.catalog?.items ?? []).map((s) => [s.id, s.label])),
    [planner.catalog],
  );

  const mapCourse = useMemo<MapCourse | null>(() => {
    if (!course) return null;
    const v = course.variants[variantIndex] ?? course.variants[0];
    return { origin: course.origin, startName: course.startName, stops: v.stops, breaks: v.breaks };
  }, [course, variantIndex]);

  function toggleCategory(id: string) {
    setCategories((prev) => {
      const next = prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id];
      return next.length ? next : ALL; // turning the last one off means "show everything" again
    });
  }

  function planHere() {
    setEcho(null); // planned from the buttons, not from text
    if (region) planner.run({ regionId: region.id });
    else if (picked) planner.run({ point: picked, label: '고른 위치' });
    else if (mapCenter) planner.run({ point: mapCenter, bounds: mapBounds ?? undefined });
  }

  return (
    <div className="app-shell">
      <ShopMap
        categories={categories}
        regions={regions}
        focusRegionId={regionId}
        focusShop={focusShop}
        pickMode={pickMode}
        pickedPoint={picked}
        onPickPoint={(p) => {
          setPicked(p);
          setPickMode(false);
          setRegionId(null);
          sheet.setSnap('half');
        }}
        course={mapCourse}
        hoverOrder={hoverOrder}
        onSelect={(s) => {
          if (s) openShop(s.id);
        }}
        onViewport={setViewport}
        onCenter={setMapCenter}
        onBounds={setMapBounds}
        locateOnStart={!initialLink}
      />

      <main
        ref={panelRef}
        className={`panel${sheet.dragging ? ' is-dragging' : ''}`}
        data-snap={sheet.snap}
        style={sheet.style}
        aria-label="코스 만들기"
        {...sheet.handlers}
      >
        <button
          type="button"
          className="sheet-handle"
          aria-label={sheet.snap === 'peek' ? '패널 펼치기' : '패널 접어서 지도 크게 보기'}
          aria-expanded={sheet.snap !== 'peek'}
          onKeyDown={(e) => {
            // Taps are handled by the drag code (pointer up without movement); the keyboard gets its own keys.
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              sheet.setSnap(sheet.snap === 'peek' ? 'half' : 'peek');
            }
            if (e.key === 'ArrowUp') sheet.setSnap(sheet.snap === 'peek' ? 'half' : 'full');
            if (e.key === 'ArrowDown') sheet.setSnap(sheet.snap === 'full' ? 'half' : 'peek');
          }}
        />
        <header className="panel-head" ref={headRef}>
          <h1 className="visually-hidden">ROUTE 01 — 취향대로 걷는 서울 옷가게 코스</h1>
          <Logo />
          <button
            type="button"
            className="mine-btn"
            aria-pressed={showMine}
            onClick={() => {
              setDetailId(null);
              setShowMine(!showMine);
            }}
          >
            {profile ? <Avatar name={profile.nickname} url={profile.avatarUrl} size={22} /> : <User size={18} aria-hidden />}
            <span>마이페이지</span>
          </button>
        </header>

        <div className="panel-body" ref={body}>
          <PlanProgress active={planner.loading} />
          {detailId ? (
            <ShopDetail
              key={detailId}
              shopId={detailId}
              styleLabels={styleLabels}
              itemLabels={itemLabels}
              onBack={() => {
                setDetailId(null);
                sheet.setSnap('half');
              }}
              course={
                course
                  ? {
                      stops: (course.variants[variantIndex] ?? course.variants[0]).stops.map((s) => ({ order: s.order, id: s.shop.id, name: s.shop.name })),
                      busy: editor.busy,
                      // Put it in, then back to the course: the change and its message show there.
                      onPut: async (order) => {
                        await editor.apply(order ? { op: 'replace', order, shopId: detailId } : { op: 'add', shopId: detailId });
                        setDetailId(null);
                        sheet.setSnap('half');
                      },
                    }
                  : null
              }
            />
          ) : showMine ? (
            <MyPage
              styleLabels={styleLabels}
              notice={loginNotice}
              onOpenCourse={openCourse}
              onClose={() => setShowMine(false)}
              onOpenShop={(id, at) => {
                if (at) setFocusShop(at);
                openShop(id);
              }}
            />
          ) : course ? (
            <CourseResult
              course={course}
              styleLabels={styleLabels}
              variantIndex={variantIndex}
              activeOrder={hoverOrder}
              onVariant={setVariantIndex}
              onHoverStop={setHoverOrder}
              onFitAll={() => planner.rerunWithoutTimeLimit()}
              onGender={(g) => planner.changeGender(g, (course.variants[variantIndex] ?? course.variants[0]).stops.map((s) => s.shop.id))}
              onAnother={() => planner.again((course.variants[variantIndex] ?? course.variants[0]).stops.map((s) => s.shop.id))}
              onOpenShop={openShop}
              onCourseId={(id) => setCourse((c) => (c ? { ...c, id, shared: false } : c))}
              regions={regions}
              onOpenCourse={openCourse}
              onContinue={(id) => {
                const from = course.id;
                setEcho(null);
                setRegionId(id);
                planner.run({ regionId: id }, undefined, 'buttons', { continueFrom: from });
              }}
              echo={echo}
              busy={planner.busy}
              editor={editor}
            />
          ) : (
            <>
              <PromptBox
                planner={planner}
                onRegion={(id) => id && setRegionId(id)}
                onEcho={setEcho}
                // Text without a place: where the map is (and only what it shows).
                fallbackOrigin={() =>
                  region ? { regionId: region.id } : picked ? { point: picked, label: '고른 위치' } : mapCenter ? { point: mapCenter, bounds: mapBounds ?? undefined } : null
                }
              />
              <PresetRow
                disabled={planner.busy}
                onPick={(p) => {
                  setEcho(null);
                  setPicked(null);
                  setRegionId(p.regionId);
                  planner.runPreset(p);
                }}
              />
              <RegionBar
                regions={regions}
                selectedId={regionId}
                onSelect={(id) => {
                  setRegionId(id);
                  if (id) setPicked(null);
                }}
                picking={pickMode}
                picked={!!picked}
                onPick={() => {
                  setPickMode(true);
                  sheet.setSnap('peek'); // phones: get the sheet out of the way so the map can be tapped
                }}
                onClearPick={() => setPicked(null)}
              />
              <CourseForm planner={planner} near={picked ?? mapCenter} />

              <details className="dev-details">
                <summary>지도에 보이는 가게 종류</summary>
                <div className="pt-3">
                  <div className="chip-row" role="group" aria-label="가게 종류">
                    {SHOP_CATEGORIES.map((c) => {
                      const on = categories.includes(c.id);
                      return (
                        <button
                          key={c.id}
                          type="button"
                          className={`chip is-filter${on ? ' is-on' : ''}`}
                          aria-pressed={on}
                          onClick={() => toggleCategory(c.id)}
                        >
                          <span className="chip-dot" style={{ background: c.color }} />
                          {c.label}
                        </button>
                      );
                    })}
                  </div>
                  <p className="hint tabular">
                    {!viewport
                      ? '지도를 불러오는 중…'
                      : viewport.shown < viewport.total
                        ? `이 화면 ${viewport.total.toLocaleString()}곳 중 눈에 띄는 ${viewport.shown.toLocaleString()}곳 표시 · 확대하면 더 보여요`
                        : `이 화면에 ${viewport.total.toLocaleString()}곳`}
                  </p>
                </div>
              </details>
              <details className="dev-details">
                <summary>개발 정보</summary>
                <div className="pt-3">
                  <HealthPanel />
                </div>
              </details>
            </>
          )}
        </div>

        {/* The shop detail has its own actions; the plan button would only compete with them. */}
        <footer className="panel-foot" ref={footRef} hidden={!!detailId}>
          {openNote && !course && (
            <p className="small mb-2" role="alert" style={{ color: 'var(--danger)' }}>
              {openNote}
            </p>
          )}
          {planner.error && (
            <p className="small mb-2" role="alert" style={{ color: 'var(--danger)' }}>
              {planner.error}
            </p>
          )}
          {course ? (
            <button type="button" className="btn-ink" onClick={() => setCourse(null)}>
              <span className="d-inline-flex align-items-center gap-2">
                <ArrowLeft size={18} aria-hidden /> 조건 바꿔서 다시 짜기
              </span>
            </button>
          ) : (
            <>
              <button type="button" className="btn-ink" disabled={planner.busy || (!region && !mapCenter)} onClick={planHere}>
                <span>
                  {planner.loading ? '코스 짜는 중…' : region ? `${region.name}에서 코스 짜기` : picked ? '고른 위치에서 코스 짜기' : '지도 가운데서 코스 짜기'}
                </span>
                <ArrowRight size={20} aria-hidden />
              </button>
              <button
                type="button"
                className="btn-line"
                disabled={planner.busy}
                onClick={() => {
                  setEcho(null);
                  planner.runHere(mapCenter);
                }}
              >
                <NavigationArrow size={16} aria-hidden />
                {planner.locating ? '위치 확인 중…' : '지금 내 위치에서 바로'}
              </button>
            </>
          )}
        </footer>
      </main>
      <LoginModal />
    </div>
  );
}
