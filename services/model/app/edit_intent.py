"""Course assistant: "3번 빼고 신발 가게로", "좀 더 가깝게" → a list of edit operations the API knows how to apply.

The model only chooses operations; the API does the actual shop search and distance maths, so it can't invent shops.
"""

from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field

from ai import generate
from app.catalog import load_catalog

CATALOG = load_catalog()
StyleId = Enum("StyleId", {s.id: s.id for s in CATALOG.styles}, type=str)
ItemId = Enum("ItemId", {i.id: i.id for i in CATALOG.items}, type=str)


class Stop(BaseModel):
    order: int
    name: str
    category: str
    summary: str | None = None
    price_range: str | None = None


class EditIntentRequest(BaseModel):
    text: str = Field(min_length=1, max_length=300)
    stops: list[Stop]


class Op(BaseModel):
    op: Literal["remove", "replace", "move", "add", "replan"]
    order: int | None = Field(None, description="대상 가게 번호(1부터). add/replan은 null")
    to_order: int | None = Field(None, description="move일 때 옮길 자리")
    want_category: Literal["select_shop", "vintage", "brand", "spa", "general", "complex"] | None = None
    want_style: StyleId | None = None
    want_item: ItemId | None = None
    want_budget: Literal["low", "mid", "high"] | None = None
    prefer: Literal["nearby", "taste"] | None = Field(None, description="replan일 때")
    shop_name: str | None = Field(None, description="add/replace에서 사용자가 이름을 댄 가게 (말한 그대로, 조사 빼고)")


class EditIntent(BaseModel):
    ops: list[Op] = Field(description="순서대로 적용할 고치기. 못 알아들으면 빈 목록")
    reply: str = Field(description="사용자에게 보일 한 줄. 못 하면 이유를 짧게")


SYSTEM = f"""너는 옷가게 쇼핑 코스를 고쳐 주는 비서다. 지금 코스(번호 붙은 가게 목록)와 사용자의 말을 보고, 아래 고치기만 써서 답한다.

- remove: order번 가게 빼기 ("3번 빼줘", "마지막 건 빼")
- replace: order번 가게를 다른 가게로 ("2번 다른 데로", "2번 말고 더 싼 데" → want_budget low, "신발 가게로" → want_item shoes,
  "빈티지로" → want_category vintage 또는 want_style vintage, "편집숍으로" → want_category select_shop)
- move: order번을 to_order번 자리로 ("4번을 맨 앞으로" → to_order 1, "2번이랑 3번 바꿔" → move order 2 to_order 3)
- add: 가게 하나 더 넣기 ("가방 가게 하나 추가" → want_item bag)
- 가게 이름을 대면 그 가게를 넣는다: shop_name에 이름만(조사·'가게' 빼고) 쓴다. 다른 가게로 바꾸지 않는다.
  "팔라스 넣어줘" → add, shop_name "팔라스" / "2번을 아더에러로 바꿔" → replace order 2, shop_name "아더에러"
  / "EQL도 들르고 싶어" → add, shop_name "EQL". 스타일·종류 말("빈티지샵 하나 더")은 이름이 아니다.
- replan: 전체를 다시 짜기 ("좀 더 가깝게", "덜 걷게" → prefer nearby / "취향 위주로", "더 내 스타일로" → prefer taste)

스타일 id: {", ".join(f"{s.id}({s.label})" for s in CATALOG.styles)}
품목 id: {", ".join(f"{i.id}({i.label})" for i in CATALOG.items)}
'마지막'은 가장 큰 번호. 여러 개를 말하면 말한 순서대로 여러 op. 번호는 지금 코스 기준(앞에서 뺀 것 때문에 번호를 바꾸지 않는다).
카페·식당 넣기, 다른 동네로 옮기기처럼 못 하는 것은 ops를 비우고 reply에 짧게 이유를 쓴다."""


def edit_intent(req: EditIntentRequest) -> EditIntent:
    course = "\n".join(
        f"{s.order}. {s.name} ({s.category}{', ' + s.price_range if s.price_range else ''}) {s.summary or ''}" for s in req.stops
    )
    return generate(
        purpose="edit_intent",
        system=SYSTEM,
        prompt=f"지금 코스:\n{course}\n\n사용자: {req.text}",
        schema=EditIntent,
        tier="fast",
        paced=False,
    )
