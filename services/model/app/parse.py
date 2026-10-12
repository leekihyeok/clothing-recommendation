"""Free text / photo → course request draft (PLAN.md 2.1 ③ and ⑤).

/parse: "망원역 근처에서 빈티지랑 워크웨어 5곳, 3시간, 저렴하게" → region or place, styles, count, time, budget, items.
Also when ("토요일 2시에") and how it ends ("6시까지", "합정역에서 끝나게", "다시 돌아오게"). Day words become a date here,
not in the model: it only names the day.
A place that isn't one of our regions is geocoded with Kakao keyword search (inside Seoul).
/photo: a clothing photo → style weights.

Both use structured output limited to the shared catalog, so the AI can't invent styles or items.
"""

import base64
import json
import re
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field

from ai import generate
from app.catalog import load_catalog
from app.settings import settings

CATALOG = load_catalog()
StyleId = Enum("StyleId", {s.id: s.id for s in CATALOG.styles}, type=str)
ItemId = Enum("ItemId", {i.id: i.id for i in CATALOG.items}, type=str)
STYLE_LIST = ", ".join(f"{s.id}({s.label})" for s in CATALOG.styles)
ITEM_LIST = ", ".join(f"{i.id}({i.label})" for i in CATALOG.items)


class StyleWeight(BaseModel):
    id: StyleId
    weight: float = Field(ge=0.1, le=1, description="1 = 꼭, 0.5 = 조금")


class ParsedRequest(BaseModel):
    region_name: str | None = Field(None, description="주어진 지역 목록의 이름 그대로, 없으면 null")
    place: str | None = Field(None, description="지역 목록에 없는 출발 장소(역, 건물, 동네). 없으면 null")
    styles: list[StyleWeight] = []
    stop_count: int | None = Field(None, ge=1, le=20)
    max_stops: bool = Field(False, description="'최대한 많이', '많이 돌고 싶어' 같은 표현")
    time_budget_min: int | None = Field(None, ge=30, le=720)
    budget: Literal["any", "low", "mid", "high"] = "any"
    items: list[ItemId] = []
    wants_cafe: bool = False
    wants_food: bool = Field(False, description="밥·점심·저녁·맛집을 코스에 넣고 싶어 하면 true")
    gender: Literal["any", "men", "women"] = Field("any", description="누구 옷을 보러 가나. 분명할 때만 men/women")
    must_shops: list[str] = Field([], max_length=8, description="꼭 넣어 달라고 이름을 말한 가게들 (말한 그대로)")
    brands: list[str] = Field([], max_length=5, description="사려는·보고 싶은 옷 브랜드 이름 (말한 그대로)")
    start_day: Literal["오늘", "내일", "모레", "월", "화", "수", "목", "금", "토", "일"] | None = Field(
        None, description="출발 날을 말했으면. '이번 주말'은 토"
    )
    start_time: str | None = Field(None, description="출발 시각 HH:MM (24시간제). 말하지 않았으면 null")
    end_time: str | None = Field(None, description="'6시까지'처럼 끝낼 시각 HH:MM (24시간제)")
    end_place: str | None = Field(None, description="'합정역에서 끝나게'처럼 코스를 끝낼 장소")
    round_trip: bool = Field(False, description="출발한 곳으로 다시 돌아오고 싶으면 true")
    unsupported: list[str] = Field([], description="지금 들어줄 수 없는 요청(예: 대중교통, 다른 도시)을 짧게, 사용자가 쓴 언어로")
    summary: str = Field(description="이해한 내용을 사용자가 쓴 언어로 한 줄 (영어로 썼으면 영어). 예: '망원에서 빈티지·워크웨어 5곳, 3시간, 저렴하게'")


class ParseRequest(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    region_names: list[str]


class GeoPoint(BaseModel):
    lat: float
    lng: float
    name: str


class ParseResponse(BaseModel):
    parsed: ParsedRequest
    place_point: GeoPoint | None = None
    end_point: GeoPoint | None = None
    start_at: str | None = None  # "2026-10-17T14:00", Seoul


SYSTEM = f"""너는 서울 옷가게 코스 앱의 입력 해석기다. 사용자가 쓴 문장을 코스 요청서로 바꾼다.
문장에 없는 칸은 비워 둔다(지어내지 않는다).

- styles: 이 목록 안에서만 고른다 → {STYLE_LIST}
  '빈티지·구제'처럼 비슷한 말은 가까운 것으로. 직접 말한 스타일은 weight 1, '좀', '살짝'은 0.5.
- items: 이 목록 안에서만 → {ITEM_LIST}
- stop_count: '5곳', '다섯 군데'. '최대한 많이'면 max_stops=true, stop_count는 null.
- time_budget_min: '3시간'→180, '반나절'→240, '하루 종일'→480, '한 시간 반'→90.
- budget: '싸게·가성비'→low, '적당히'→mid, '명품·고급'→high.
- region_name: 사용자가 말한 동네가 지역 목록에 있으면 그 이름 그대로(예: '성수동'→'성수', '홍대'→'홍대·연남').
  목록에 없으면 place에 적는다(예: '망원역 근처'→place '망원역').
- wants_cafe: 카페·커피 들르기를 원하면 true.
- wants_food: 점심·저녁·밥·맛집을 코스 중간에 넣고 싶어 하면 true ("점심 먹고", "맛집도").
- gender: '남자 옷', '남성복', '남친 옷 사러' → men / '여자 옷', '여성복', '원피스 보러' → women. 함께 가는 사람만 말한 것
  ('여친이랑', '남자친구랑')은 누구 옷인지 모르므로 any.
- must_shops: "○○는 무조건 넣어줘", "○○ 꼭 들르고 싶어"처럼 이름을 대고 꼭 넣어 달라는 가게 이름을 말한 그대로.
  스타일·동네·브랜드 종류(예: '빈티지샵')는 넣지 않는다.
- brands: "아더에러 파는 데", "칼하트 있는 빈티지샵", "살로몬 신발 보러"처럼 찾는 옷·신발·가방 브랜드 이름을 말한 그대로.
  가게 이름(must_shops)과 헷갈리면: '○○ 파는/있는 곳'이면 브랜드, '○○ 넣어 줘/들르고 싶어'면 가게.
- start_day / start_time: '토요일 2시에', '내일 오후 1시 출발' → 토 / 14:00, 내일 / 13:00. 시각만 말하면 start_day는 null.
  오전·오후 말이 없는 1~9시는 오후로 본다 ('2시' → 14:00). '지금', '바로'는 둘 다 null.
- end_time: '6시까지', '저녁 7시 전에 끝나게' → 18:00, 19:00 (같은 오후 규칙).
- end_place: '합정역에서 끝나게', '끝나고 연남동에서 약속' → 합정역, 연남동. 출발 장소와 같은 곳으로 '돌아오게'면 round_trip=true.
- unsupported: 대중교통으로 여러 동네 잇기, 서울 밖, 특정 가게 예약처럼 지금 못 하는 것."""

SEOUL = timezone(timedelta(hours=9))
WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"]
HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


def start_at(day: str | None, time: str | None, now: datetime | None = None) -> str | None:
    """"토" + "14:00" → the coming Saturday at 14:00 (today if it's Saturday and still before then). A day without a time
    starts at 12:00; a time without a day is today, or tomorrow once that time has passed."""
    if not day and not time:
        return None
    now = now or datetime.now(SEOUL)
    if time and not HHMM.match(time):
        return None
    h, m = map(int, (time or "12:00").split(":"))
    if day in ("오늘", None):
        date = now.date()
        if day is None and (h, m) <= (now.hour, now.minute):
            date += timedelta(days=1)
    elif day == "내일":
        date = now.date() + timedelta(days=1)
    elif day == "모레":
        date = now.date() + timedelta(days=2)
    else:
        ahead = (WEEKDAYS.index(day) - now.weekday()) % 7
        if ahead == 0 and (h, m) <= (now.hour, now.minute):
            ahead = 7
        date = now.date() + timedelta(days=ahead)
    return f"{date.isoformat()}T{h:02d}:{m:02d}"


def geocode(place: str) -> GeoPoint | None:
    """Kakao keyword search, limited to Seoul's bounding box."""
    if not settings.kakao_rest_api_key:
        return None
    q = urllib.parse.urlencode({"query": place, "rect": "126.76,37.41,127.19,37.72", "size": 1})
    req = urllib.request.Request(
        f"https://dapi.kakao.com/v2/local/search/keyword.json?{q}",
        headers={"Authorization": f"KakaoAK {settings.kakao_rest_api_key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            docs = json.load(res)["documents"]
    except Exception:
        return None
    if not docs:
        return None
    d = docs[0]
    return GeoPoint(lat=float(d["y"]), lng=float(d["x"]), name=d["place_name"])


def parse(req: ParseRequest) -> ParseResponse:
    now = datetime.now(SEOUL)
    parsed = generate(
        purpose="parse_prompt",
        system=SYSTEM,
        prompt=f"지역 목록: {', '.join(req.region_names)}\n지금: {WEEKDAYS[now.weekday()]}요일 {now:%H:%M}\n\n문장: {req.text}",
        schema=ParsedRequest,
        tier="fast",
        paced=False,
    )
    if parsed.region_name and parsed.region_name not in req.region_names:
        parsed.place, parsed.region_name = parsed.place or parsed.region_name, None
    point = geocode(parsed.place) if parsed.place and not parsed.region_name else None
    end = geocode(parsed.end_place) if parsed.end_place and not parsed.round_trip else None
    if parsed.end_time and not HHMM.match(parsed.end_time):
        parsed.end_time = None
    return ParseResponse(parsed=parsed, place_point=point, end_point=end, start_at=start_at(parsed.start_day, parsed.start_time, now))


# ---------- photo ----------
class PhotoStyles(BaseModel):
    styles: list[StyleWeight] = Field(description="사진의 옷과 어울리는 스타일 1~3개")
    items: list[ItemId] = []
    description: str = Field(description="사진 속 옷을 한국어 한 줄로. 예: '워싱 데님 재킷과 체크 셔츠'")


class PhotoRequest(BaseModel):
    image_base64: str = Field(max_length=6_000_000)
    mime_type: Literal["image/jpeg", "image/png", "image/webp"]


PHOTO_SYSTEM = f"""너는 패션 에디터다. 사진 속 옷차림을 보고 가장 가까운 스타일을 이 목록 안에서 1~3개 고른다 → {STYLE_LIST}
가장 뚜렷한 것은 weight 1, 곁들여진 느낌은 0.5. 보이는 품목은 이 목록 안에서 → {ITEM_LIST}
사람이 누구인지는 말하지 않는다. 옷이 안 보이면 styles를 비운다."""


def photo(req: PhotoRequest) -> PhotoStyles:
    from google.genai import types

    image = types.Part.from_bytes(data=base64.b64decode(req.image_base64), mime_type=req.mime_type)
    return generate(
        purpose="parse_photo",
        system=PHOTO_SYSTEM,
        prompt=[image, "이 사진의 옷 스타일을 골라라."],
        schema=PhotoStyles,
        tier="fast",
        paced=False,
    )
