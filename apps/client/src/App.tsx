import { useApolloClient, useQuery } from '@apollo/client';
import { getLang, setLang, t, useLang } from './i18n';
import { ArrowClockwise, ArrowLeft, ArrowRight, NavigationArrow } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSheet } from './layout/useSheet';
import { Logo } from './brand/Logo';
import { HealthPanel } from './components/HealthPanel';
import { User } from '@phosphor-icons/react';
import { MyPage } from './me/MyPage';
import { useProfile } from './me/useProfile';
import { Avatar, categoryLabel } from './shop/ShopDetail';
import { takeLoginResult } from './me/useAccount';
import { CourseForm } from './course/CourseForm';
import { CourseResult } from './course/CourseResult';
import { useCourseEdit } from './course/useCourseEdit';
import { SHOP_PARAM, useLoadCourse } from './course/useSavedCourses';
import { type MeTab, readRoute, writeRoute } from './route';
import { readDraft, writeDraft } from './draft';
import { PlanProgress } from './course/PlanProgress';
import { PresetRow } from './course/PresetRow';
import { type Echo, PromptBox } from './course/PromptBox';
import { type PlannedCourse, usePlanner } from './course/usePlanner';
import { WalkMode, type WalkState } from './course/WalkMode';
import { useNewNewsCount } from './shop/ShopNews';
import { GROUP_PARAM, GroupJoin } from './course/Group';
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
  // Everything below re-renders when the language changes (no memoised children); data is asked for again in it.
  const lang = useLang();
  const apollo = useApolloClient();
  const [categories, setCategories] = useState<string[]>(ALL);
  // What the address said when the page loaded (route.ts): the screen a reload comes back to.
  const [initialRoute] = useState(readRoute);
  // The shop detail on screen (?shop=<id> in the address, so it can be linked and survives a reload).
  const [detailId, setDetailId] = useState<string | null>(initialRoute.shop);
  const [viewport, setViewport] = useState<ViewportInfo | null>(null);
  // The area picked on the form, kept through a reload like the rest of the form (draft.ts).
  const [regionId, setRegionId] = useState<string | null>(() => readDraft<string>('region'));
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
  const [showMine, setShowMine] = useState(loginNotice !== null || initialRoute.me !== null);
  // 마이페이지's tab and page (?me=&p=), kept while it's closed so it opens where it was.
  const [mePlace, setMePlace] = useState<{ tab: MeTab | null; page: number }>({ tab: initialRoute.me, page: initialRoute.page });
  // "지도에서 고르기": the next tap on the map sets the start or the finish.
  const [pickMode, setPickMode] = useState<'start' | 'end' | null>(null);
  // 걷기 모드 on the course on screen, and what the map shows meanwhile (my position, the next place).
  const [walking, setWalking] = useState(false);
  const [walkState, setWalkState] = useState<WalkState | null>(null);
  const [echo, setEcho] = useState<Echo | null>(null);
  const [picked, setPicked] = useState<{ lat: number; lng: number } | null>(null);
  const [focusShop, setFocusShop] = useState<{ lat: number; lng: number } | null>(null);
  // Where the open shop page's shop is (the map marks it).
  const [shopPin, setShopPin] = useState<{ lat: number; lng: number; name: string } | null>(null);
  // The page was opened on a shop or a group link: the map shows that, not "where I am".
  const [linkedPlace] = useState(() => {
    const p = new URLSearchParams(window.location.search);
    return p.has(SHOP_PARAM) || p.has(GROUP_PARAM);
  });
  const profile = useProfile().data?.myProfile ?? null;
  // Saved shops posted something since the last look: a dot on 마이페이지.
  const unreadNews = useNewNewsCount(!profile);
  const loadCourse = useLoadCourse();
  const [openNote, setOpenNote] = useState<string | null>(null);
  // A course is being opened from the address (a share link, back / forward): the address is left alone meanwhile, so
  // it isn't cleared (or set back to the old course) before the course arrives.
  // The ref is set at once (the effect below can run in the same commit as the call); the state re-runs that effect.
  const [linkLoading, setLinkLoading] = useState(false);
  const linkPending = useRef(false);
  // The course in the address (?c=<id>) when the page loaded: a share link, or this user's own course after a reload.
  const [initialLink] = useState(initialRoute.course);
  const [mapBounds, setMapBounds] = useState<MapBounds | null>(null);
  // Opened from a "같이 가기" link (?g=<id>): the join screen, until a course for the group is open.
  const [joinGroup, setJoinGroup] = useState<string | null>(() => new URLSearchParams(window.location.search).get(GROUP_PARAM));
  const body = useRef<HTMLDivElement>(null);
  const regions = useQuery(RegionsDoc).data?.regions ?? NO_REGIONS;
  useEffect(() => writeDraft('region', regionId), [regionId]);
  const region = regions.find((r) => r.id === regionId) ?? null;

  const planner = usePlanner((c) => {
    editor.reset();
    setWalking(false);
    sheet.setSnap('half'); // phones: the route on the map above, the list below
    setVariantIndex(0);
    // No place was chosen and the brands asked for picked the region: show it as chosen (map, buttons, next plans).
    if (c.request.regionPicked && c.request.regionId) setRegionId(c.request.regionId);
    setCourse(c);
    body.current?.scrollTo({ top: 0 });
  });
  const editor = useCourseEdit(course, variantIndex, setCourse);
  const styleLabels = useMemo(
    () => Object.fromEntries((planner.catalog?.styles ?? []).map((s) => [s.id, s.label])),
    [planner.catalog],
  );

  /**
   * A saved course (share link, "최근 코스") back on screen, with its conditions in the form. From the address (a reload,
   * back / forward) it opens as it was left: the same version tab, 걷기 모드, and whatever was over it stays.
   */
  async function openCourse(id: string, at: { variant?: number; walk?: boolean; keep?: boolean } = {}) {
    setOpenNote(null);
    linkPending.current = true;
    setLinkLoading(true);
    const c = await loadCourse(id).finally(() => {
      linkPending.current = false;
      setLinkLoading(false);
    });
    if (!c) {
      setOpenNote(t('코스를 찾지 못했어요. 링크가 맞는지 확인해 주세요', "We couldn't find that course. Please check the link"));
      return;
    }
    planner.adopt(c);
    editor.reset();
    setWalking(at.walk === true);
    setEcho(null);
    if (!at.keep) setShowMine(false);
    setRegionId(c.request.regionId ?? null);
    setVariantIndex(Math.min(at.variant ?? 0, Math.max(0, c.variants.length - 1)));
    setCourse(c);
    sheet.setSnap('half');
    body.current?.scrollTo({ top: 0 });
  }

  /** The course on screen again from the server (the language changed): what the user was doing stays as it was. */
  async function reloadCourse(id: string) {
    const c = await loadCourse(id);
    if (c) setCourse((now) => (now?.id === id ? c : now));
  }

  const opened = useRef(false);
  useEffect(() => {
    if (initialLink && !opened.current) {
      opened.current = true; // once, also under StrictMode's double effects
      openCourse(initialLink, { variant: initialRoute.variant, walk: initialRoute.walk, keep: true });
    }
  }, [initialLink]); // eslint-disable-line react-hooks/exhaustive-deps

  // What's on screen lives in the address (route.ts), so a reload or a copied URL brings it back. Opening a screen is a
  // new history entry (browser back closes it); a tab, a page or closing it edits the current one.
  const courseId = course?.id ?? null;
  useEffect(() => {
    if (linkPending.current || (initialLink && !opened.current)) return; // the course in the address is on its way
    if (!courseId && openNote) return; // a link that didn't open stays visible while the note explains
    writeRoute({
      course: courseId,
      variant: courseId ? variantIndex : 0,
      walk: !!courseId && walking,
      shop: detailId,
      me: showMine ? (mePlace.tab ?? 'courses') : null,
      page: mePlace.page,
    });
  }, [courseId, variantIndex, walking, detailId, showMine, mePlace, openNote, linkLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Browser back / forward: follow the address.
  const courseRef = useRef(course);
  courseRef.current = course;
  useEffect(() => {
    const onPop = () => {
      const r = readRoute();
      setDetailId(r.shop);
      setShowMine(r.me !== null);
      if (r.me) setMePlace({ tab: r.me, page: r.page });
      if (!r.course) {
        setCourse(null);
        setWalking(false);
      } else if (r.course !== courseRef.current?.id) {
        openCourse(r.course, { variant: r.variant, walk: r.walk, keep: true });
      } else {
        setVariantIndex(r.variant);
        setWalking(r.walk);
      }
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

  const view = detailId ? `shop:${detailId}` : showMine ? 'mine' : joinGroup && !course ? 'group' : course && walking ? 'walk' : course ? `course:${course.id}` : 'form';
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    // After the new view has rendered (and the sheet moved).
    const id = window.setTimeout(() => {
      const target = body.current?.querySelector<HTMLElement>('h2, [data-autofocus]');
      if (!target) return;
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    }, 60);
    return () => window.clearTimeout(id);
  }, [view.replace(/^course:.*/, 'course')]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc leaves "지도에서 고르기".
  useEffect(() => {
    if (!pickMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPickMode(null);
        sheet.setSnap('half');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const itemLabels = useMemo(
    () => Object.fromEntries((planner.catalog?.items ?? []).map((s) => [s.id, s.label])),
    [planner.catalog],
  );

  const mapCourse = useMemo<MapCourse | null>(() => {
    if (!course) return null;
    const v = course.variants[variantIndex] ?? course.variants[0];
    return { origin: course.origin, startName: course.startName, stops: v.stops, breaks: v.breaks, end: course.end, endName: course.endName, endLeg: v.endLeg };
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
    else if (picked) planner.run({ point: picked, label: t('고른 위치', 'Picked spot') });
    else if (mapCenter) planner.run({ point: mapCenter, bounds: mapBounds ?? undefined });
  }

  return (
    <div className="app-shell">
      <ShopMap
        categories={categories}
        regions={regions}
        focusRegionId={regionId}
        focusShop={focusShop}
        shopPin={detailId ? shopPin : null}
        pickMode={pickMode}
        onStopClick={(order) => {
          if (!course || walking) return;
          setDetailId(null);
          setShowMine(false);
          setHoverOrder(order);
          sheet.setSnap('half');
          // After the list is back on screen: that card in the middle of it, focused.
          window.setTimeout(() => {
            const list = body.current;
            const card = list?.querySelector<HTMLElement>(`[data-stop-order="${order}"]`);
            if (!list || !card) return;
            const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            // Only the list scrolls (scrollIntoView also moved the page around the fixed layout on phones).
            const listTop = list.getBoundingClientRect().top;
            const top = card.getBoundingClientRect().top - listTop + list.scrollTop;
            // The part of the list on screen: on phones the half sheet shows only its top, above the footer.
            const footTop = footRef.current && !footRef.current.hidden ? footRef.current.getBoundingClientRect().top : window.innerHeight;
            const shown = Math.max(card.offsetHeight, Math.min(list.clientHeight, footTop - listTop, window.innerHeight - listTop));
            list.scrollTo({ top: Math.max(0, top - Math.max(8, (shown - card.offsetHeight) / 2)), behavior: still ? 'auto' : 'smooth' });
            card.focus({ preventScroll: true });
          }, 80);
        }}
        onStopSwap={course && !walking && !editor.busy ? (from, to) => editor.apply({ op: 'swap', order: from, toOrder: to }) : undefined}
        onCancelPick={() => {
          setPickMode(null);
          sheet.setSnap('half');
        }}
        pickedPoint={picked}
        pickedEnd={planner.end.kind === 'point' ? planner.end.point : null}
        walk={walking ? walkState : null}
        onPickPoint={(p) => {
          if (pickMode === 'end') planner.setEnd({ kind: 'point', point: p, name: t('고른 곳', 'Picked spot') });
          else {
            setPicked(p);
            setRegionId(null);
          }
          setPickMode(null);
          sheet.setSnap('half');
        }}
        course={mapCourse}
        hoverOrder={hoverOrder ?? (walking ? walkState?.next?.order ?? null : null)}
        onSelect={(s) => {
          if (s) openShop(s.id);
        }}
        onViewport={setViewport}
        onCenter={setMapCenter}
        onBounds={setMapBounds}
        locateOnStart={!initialLink && !linkedPlace}
      />

      <main
        ref={panelRef}
        className={`panel${sheet.dragging ? ' is-dragging' : ''}`}
        data-snap={sheet.snap}
        style={sheet.style}
        aria-label={t('코스 만들기', 'Plan a course')}
        {...sheet.handlers}
      >
        <button
          type="button"
          className="sheet-handle"
          aria-label={sheet.snap === 'peek' ? t('패널 펼치기', 'Expand panel') : t('패널 접어서 지도 크게 보기', 'Collapse panel to see more map')}
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
          <h1 className="visually-hidden">{t('ROUTE 01 — 취향대로 걷는 서울 옷가게 코스', 'ROUTE 01 — Seoul clothing-shop walks, made to your taste')}</h1>
          <Logo />
          {/* Quiet text switch, editorial style: both languages visible, the current one in ink with the signal
              underline (as active tabs), the other grey. Subordinate to 마이페이지, the header's one button. */}
          <div className="lang-switch" role="group" aria-label="언어 · Language">
            {(['ko', 'en'] as const).map((l) => (
              <button
                key={l}
                type="button"
                lang={l}
                aria-pressed={lang === l}
                aria-label={l === 'ko' ? '한국어' : 'English'}
                onClick={async () => {
                  if (lang === l) return;
                  setLang(l);
                  await apollo.refetchQueries({ include: 'active' });
                  // Its notes and reasons in the new language; the tab, 걷기 모드 and undo stay as they were.
                  if (course) reloadCourse(course.id);
                }}
              >
                {l.toUpperCase()}
              </button>
            ))}
          </div>
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
            <span>{t('마이페이지', 'My page')}</span>
            {unreadNews > 0 && !showMine && <span className="mine-dot" aria-label={t(`찜한 가게 새 소식 ${unreadNews}개`, `${unreadNews} new from saved shops`)} />}
          </button>
        </header>

        <div className="panel-body" ref={body}>
          <PlanProgress active={planner.loading} />
          {detailId ? (
            <ShopDetail
              key={detailId}
              shopId={detailId}
              onPlace={setShopPin}
              onOpenShop={openShop}
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
              busy={planner.busy}
              onPlanSaved={(g) => {
                setEcho(null);
                setPicked(null);
                setShowMine(false);
                setRegionId(g.regionId ?? null);
                planner.runSaved(g);
              }}
              notice={loginNotice}
              place={mePlace}
              onPlace={(tab, page) => setMePlace((x) => (x.tab === tab && x.page === page ? x : { tab, page }))}
              onOpenCourse={(id) => openCourse(id)}
              onClose={() => setShowMine(false)}
              onOpenShop={(id, at) => {
                if (at) setFocusShop(at);
                openShop(id);
              }}
            />
          ) : joinGroup && !course ? (
            <GroupJoin
              groupId={joinGroup}
              styles={planner.catalog?.styles ?? []}
              styleLabels={styleLabels}
              onPlace={({ regionId: rid, at }) => {
                if (rid) setRegionId(rid);
                else if (at) setFocusShop(at);
              }}
              onJoined={(id) => {
                setJoinGroup(null);
                const url = new URL(window.location.href);
                url.searchParams.delete(GROUP_PARAM);
                window.history.replaceState(null, '', url);
                openCourse(id);
              }}
              onClose={() => {
                setJoinGroup(null);
                const url = new URL(window.location.href);
                url.searchParams.delete(GROUP_PARAM);
                window.history.replaceState(null, '', url);
              }}
            />
          ) : course && walking ? (
            <WalkMode
              // Not keyed by the course id: an edit that copies a shared course must not restart the walk.
              key={`walk:${variantIndex}`}
              course={course}
              variant={course.variants[variantIndex] ?? course.variants[0]}
              title={
                getLang() === 'en'
                  ? `${course.request.styles.length ? course.request.styles.map((s) => styleLabels[s] ?? s).join(' · ') : 'Shop walk'} in ${
                      course.request.regionName ?? course.startName ?? 'Seoul'
                    }`
                  : `${course.request.regionName ?? course.startName ?? '서울'}에서 ${
                      course.request.styles.length ? course.request.styles.map((s) => styleLabels[s] ?? s).join(' · ') : '옷가게 산책'
                    }`
              }
              onExit={() => {
                setWalking(false);
                sheet.setSnap('half');
              }}
              onOpenShop={openShop}
              onState={setWalkState}
            />
          ) : course ? (
            <CourseResult
              course={course}
              styleLabels={styleLabels}
              variantIndex={variantIndex}
              activeOrder={hoverOrder}
              onVariant={setVariantIndex}
              onHoverStop={setHoverOrder}
              onFitAll={() => planner.rerunWithoutTimeLimit(course.request.mustShops)}
              onGender={(g) => planner.changeGender(g, (course.variants[variantIndex] ?? course.variants[0]).stops.map((s) => s.shop.id), course.request.mustShops)}
              onAnother={() => planner.again((course.variants[variantIndex] ?? course.variants[0]).stops.map((s) => s.shop.id), course.request.mustShops)}
              onOpenShop={openShop}
              onCourseId={(id) => setCourse((c) => (c ? { ...c, id, shared: false } : c))}
              regions={regions}
              onOpenCourse={openCourse}
              onBrandRegion={(id) => {
                setRegionId(id);
                planner.run({ regionId: id }, planner.form(), 'buttons');
              }}
              onContinue={(id) => {
                const from = course.id;
                setEcho(null);
                setRegionId(id);
                // Pins belong to this area; the next one starts without them.
                planner.run({ regionId: id }, { ...planner.form(), mustShops: [] }, 'buttons', { continueFrom: from });
              }}
              echo={echo}
              busy={planner.busy}
              editor={editor}
              onWeather={(on) => planner.setWeatherAndRerun(on, course.request.mustShops)}
              onWalk={() => {
                setWalking(true);
                sheet.setSnap('half');
                body.current?.scrollTo({ top: 0 });
              }}
            />
          ) : (
            <>
              <PromptBox
                planner={planner}
                onRegion={(id) => id && setRegionId(id)}
                onEcho={setEcho}
                // Text without a place: where the map is (and only what it shows).
                fallbackOrigin={() =>
                  region ? { regionId: region.id } : picked ? { point: picked, label: t('고른 위치', 'Picked spot') } : mapCenter ? { point: mapCenter, bounds: mapBounds ?? undefined } : null
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
                picking={pickMode === 'start'}
                picked={!!picked}
                onPick={() => {
                  setPickMode('start');
                  sheet.setSnap('peek'); // phones: get the sheet out of the way so the map can be tapped
                }}
                onClearPick={() => setPicked(null)}
              />
              <CourseForm
                planner={planner}
                near={picked ?? mapCenter}
                pickingEnd={pickMode === 'end'}
                onPickEnd={() => {
                  setPickMode(pickMode === 'end' ? null : 'end');
                  if (pickMode !== 'end') sheet.setSnap('peek');
                }}
              />

              <details className="dev-details">
                <summary>{t('지도에 보이는 가게 종류', 'Shop types on the map')}</summary>
                <div className="pt-3">
                  <div className="chip-row" role="group" aria-label={t('가게 종류', 'Shop types')}>
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
                          {categoryLabel(c.id) ?? c.label}
                        </button>
                      );
                    })}
                  </div>
                  <p className="hint tabular">
                    {!viewport
                      ? t('지도를 불러오는 중…', 'Loading the map…')
                      : viewport.shown < viewport.total
                        ? t(
                            `이 화면 ${viewport.total.toLocaleString()}곳 중 눈에 띄는 ${viewport.shown.toLocaleString()}곳 표시 · 확대하면 더 보여요`,
                            `Showing ${viewport.shown.toLocaleString()} of ${viewport.total.toLocaleString()} shops here · zoom in to see more`,
                          )
                        : t(`이 화면에 ${viewport.total.toLocaleString()}곳`, `${viewport.total.toLocaleString()} shops here`)}
                  </p>
                </div>
              </details>
              <details className="dev-details">
                <summary>{t('개발 정보', 'Developer info')}</summary>
                <div className="pt-3">
                  <HealthPanel />
                </div>
              </details>
            </>
          )}
        </div>

        {/* The shop detail has its own actions; the plan button would only compete with them. */}
        <footer className="panel-foot" ref={footRef} hidden={!!detailId || (walking && !!course) || (!!joinGroup && !course)}>
          {openNote && !course && (
            <p className="small mb-2" role="alert" style={{ color: 'var(--danger)' }}>
              {openNote}
            </p>
          )}
          {planner.error && (
            <div className="plan-error mb-2" role="alert">
              <span>{planner.error}</span>
              {planner.canRetry && (
                <button type="button" className="btn-text" disabled={planner.busy} onClick={() => planner.retry()}>
                  <ArrowClockwise size={14} aria-hidden /> {t('다시 시도', 'Try again')}
                </button>
              )}
            </div>
          )}
          {planner.notice && !planner.error && (
            <p className="hint small mb-2" role="status">
              {planner.notice}
            </p>
          )}
          {course ? (
            <button
              type="button"
              className="btn-ink"
              onClick={() => {
                // The form shows the course's pins as they are now (pinned or unpinned on its cards).
                planner.setPins(course.request.mustShops);
                setCourse(null);
              }}
            >
              <span className="d-inline-flex align-items-center gap-2">
                <ArrowLeft size={18} aria-hidden /> {t('조건 바꿔서 다시 짜기', 'Change options and replan')}
              </span>
            </button>
          ) : (
            <>
              <button type="button" className="btn-ink" disabled={planner.busy || (!region && !mapCenter)} onClick={planHere}>
                <span>
                  {planner.loading
                    ? t('코스 짜는 중…', 'Planning your course…')
                    : region
                      ? t(`${region.name}에서 코스 짜기`, `Plan a course in ${region.name}`)
                      : picked
                        ? t('고른 위치에서 코스 짜기', 'Plan from the picked spot')
                        : t('지도 가운데서 코스 짜기', 'Plan from the map center')}
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
                {planner.locating ? t('위치 확인 중…', 'Finding you…') : t('지금 내 위치에서 바로', 'Start from where I am')}
              </button>
            </>
          )}
        </footer>
      </main>
      <LoginModal />
    </div>
  );
}
