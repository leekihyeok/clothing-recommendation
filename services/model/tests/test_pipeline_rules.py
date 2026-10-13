from pipeline.kakao import Cell, keep_place
from pipeline.sbiz import is_candidate


def sbiz_row(code: str, name: str, lon: str = "127.05") -> dict:
    return {"상권업종소분류코드": code, "상호명": name, "경도": lon, "위도": "37.54"}


def test_clothing_codes_are_candidates():
    assert is_candidate(sbiz_row("G20902", "셀릭빈티지"))
    assert is_candidate(sbiz_row("G20910", "ABC마트"))


def test_repair_rental_and_other_codes_are_not():
    assert not is_candidate(sbiz_row("S20601", "명동수선"))  # 의류 수선
    assert not is_candidate(sbiz_row("N11004", "드레스대여"))  # 의류 대여
    assert not is_candidate(sbiz_row("G20903", "아가방"))  # 유아용 의류


def test_used_goods_keep_clothes_drop_electronics():
    assert is_candidate(sbiz_row("G22201", "빈티지의류잡화점"))
    assert not is_candidate(sbiz_row("G22201", "중고폰뱅크매입판매"))
    assert not is_candidate(sbiz_row("G22201", "모래내헌책방"))
    assert not is_candidate(sbiz_row("G22201", "탑재활용센타"))


def test_rows_without_coordinates_are_dropped():
    assert not is_candidate(sbiz_row("G20902", "좌표없음", lon=""))


def kakao_doc(category: str, address: str = "서울 성동구 성수동2가 1") -> dict:
    return {"category_name": category, "address_name": address, "road_address_name": ""}


def test_kakao_keeps_clothing_shoes_bags_in_seoul():
    assert keep_place(kakao_doc("가정,생활 > 패션 > 의류판매"))
    assert keep_place(kakao_doc("가정,생활 > 패션 > 의류판매 > 무신사 스탠다드"))
    assert keep_place(kakao_doc("가정,생활 > 패션 > 패션잡화점 > 구두,신발 > ABC마트"))
    assert keep_place(kakao_doc("가정,생활 > 패션 > 패션잡화점 > 가방"))


def test_kakao_drops_glasses_cafes_and_outside_seoul():
    assert not keep_place(kakao_doc("가정,생활 > 패션 > 패션잡화점 > 안경,렌즈"))
    assert not keep_place(kakao_doc("음식점 > 카페"))
    assert not keep_place(kakao_doc("가정,생활 > 패션 > 의류판매", address="경기 성남시 분당구 1"))


def test_cell_split_covers_parent_exactly():
    parent = Cell(127.0, 37.5, 127.02, 37.52)
    kids = parent.split()
    assert len(kids) == 4
    assert min(k.min_lon for k in kids) == parent.min_lon and max(k.max_lon for k in kids) == parent.max_lon
    assert min(k.min_lat for k in kids) == parent.min_lat and max(k.max_lat for k in kids) == parent.max_lat
    area = sum((k.max_lon - k.min_lon) * (k.max_lat - k.min_lat) for k in kids)
    assert abs(area - (parent.max_lon - parent.min_lon) * (parent.max_lat - parent.min_lat)) < 1e-12


def fact(name: str, kakao: str | None = None):
    from pipeline.classify import Fact

    return Fact(shop_id=1, name=name, kakao_category=kakao, public_category=None, address=None, in_market=False, building_kind=None)


def test_classify_rules():
    from pipeline.classify import rule_category

    assert rule_category(fact("좋은사람들아울렛 등촌점"))[0] == "excluded"  # 속옷: excluded by decision
    assert rule_category(fact("아무개", "가정,생활 > 패션 > 의류판매 > 한복"))[0] == "excluded"
    assert rule_category(fact("유니클로 명동점"))[0] == "spa"
    assert rule_category(fact("폭스빈티지"))[0] == "vintage"
    assert rule_category(fact("성수 편집샵 아무개"))[0] == "select_shop"
    assert rule_category(fact("MLB 신촌점", "가정,생활 > 패션 > 의류판매 > MLB"))[0] == "brand"
    assert rule_category(fact("아동복나라", "가정,생활 > 패션 > 의류판매 > 아동복,유아복")) is None  # 아동복 stays, AI decides


def test_classify_eval_v1_fixes():
    from pipeline.classify import Fact, rule_category

    assert rule_category(fact("망고")) is None  # local shop, not the SPA brand MANGO
    assert rule_category(fact("망고스틴")) is None
    assert rule_category(fact("MANGO 명동점"))[0] == "spa"
    assert rule_category(fact("미쏘니"))  is None  # Missoni, not 미쏘
    assert rule_category(fact("인따르시아 흑석동점"))[0] == "excluded"
    assert rule_category(fact("양말나라"))[0] == "excluded"
    assert rule_category(fact("성내의류")) is None  # 내의류 = clothing, not underwear
    used = dict(shop_id=1, kakao_category=None, public_category="중고 상품 소매업", address=None, in_market=False, building_kind=None)
    assert rule_category(Fact(name="로얄하우스", **used))[0] == "excluded"
    assert rule_category(Fact(name="풍물시장밀리터리", **used)) is None


def test_blog_matching_helpers():
    from pipeline.blogs import mentions, neighborhood, shop_key

    assert neighborhood("서울 성동구 성수동2가 280-7") == "성수동"
    assert neighborhood("서울특별시 마포구 서교동 395") == "서교동"
    assert neighborhood("서울 성동구 서울숲4길 23") is None
    assert shop_key("무신사 스탠다드 성수점") == "무신사스탠다드"
    post = {"title": "성수 <b>셀릭빈티지</b> 다녀옴", "contents": "빈티지 데님 구경"}
    assert mentions(post, shop_key("셀릭빈티지"), "성수동")
    assert not mentions(post, shop_key("폭스빈티지"), "성수동")
    short = {"title": "<b>와</b> 맛집", "contents": "강남 와인"}
    assert not mentions(short, shop_key("와"), "성수동")  # one-letter names never match


def test_verify_confidence_caps():
    from datetime import date

    from pipeline.verify import combine

    today = date(2026, 10, 7)
    assert combine(0.9, posts=5, has_kakao=True, last_post=date(2026, 9, 1), today=today) == 0.9
    assert combine(0.9, posts=0, has_kakao=True, last_post=None, today=today) == 0.45  # exists, little known
    assert combine(0.1, posts=0, has_kakao=True, last_post=None, today=today) == 0.45
    assert combine(0.9, posts=0, has_kakao=False, last_post=None, today=today) == 0.25
    assert combine(1.0, posts=3, has_kakao=True, last_post=date(2023, 1, 1), today=today) == 0.7


def test_blog_matching_seongsu_trial_fixes():
    from pipeline.blogs import is_generic, mentions, shop_key

    assert shop_key("삼성물산비이커성수", "성수동") == "비이커"  # company prefix and trailing area dropped
    assert shop_key("아크메드라비성수", "성수동") == "아크메드라비"
    assert is_generic(shop_key("성수빈티지", "성수동"), "성수동")
    listing = {"title": "성수 빈티지 대형 카페", "contents": "성수 빈티지 감성"}
    assert not mentions(listing, shop_key("성수빈티지", "성수동"), "성수동", "성수빈티지")
    exact = {"title": "성수빈티지 다녀옴", "contents": ""}
    assert mentions(exact, shop_key("성수빈티지", "성수동"), "성수동", "성수빈티지")
    unrelated = {"title": "에센셜 후드집업", "contents": "한섬 브랜드 아우터 성수"}
    assert not mentions(unrelated, shop_key("한섬 성수점", "성수동"), "성수동", "한섬")  # 2 letters: title must say it


def test_name_variants_and_address_spot():
    from pipeline.blogs import FOOD_TITLE, name_variants, road_spot

    assert "에어빈티지" in name_variants("빈티지에어")
    assert name_variants("셀릭") == []
    assert road_spot("서울 성동구 연무장길 39") == "연무장길 39"
    assert road_spot("서울특별시 성동구 왕십리로4길 10-20") == "왕십리로4길 10-20"
    assert road_spot("서울 성동구 성수동2가 280") is None
    assert FOOD_TITLE.search("성수 빙수 맛집") and not FOOD_TITLE.search("와이드 바지 코디")


def test_same_brand_store_across_spellings():
    from pipeline.merge_dupes import same_brand_store

    aliases = sorted(
        [("supreme", "슈프림"), ("슈프림", "슈프림"), ("covernat", "커버낫"), ("커버낫", "커버낫"), ("헤지스", "hazzys"),
         ("뉴발란스", "newbalance"), ("시에라디자인", "시에라디자인"), ("아레나", "아레나"), ("아더에러", "adererror")],
        key=lambda x: -len(x[0]),
    )
    words = sorted({"점", "직영점", "플래그십", "플래그쉽", "스토어", "코리아", "도산", "성수", "종로", "신촌", "라움이스트"}, key=lambda w: -len(w))

    def same(a, b):
        return same_brand_store(a, b, aliases, words)

    assert same("Supreme도산", "슈프림")
    assert same("커버낫성수플래그십", "커버낫 플래그쉽 성수점")
    assert same("시에라디자인종로5가점", "시에라디자인종로5가 직영점")
    # another line, another shop; units and branch numbers too
    assert not same("헤지스골프 라움이스트점", "헤지스ACC 라움이스트점")
    assert not same("뉴발란스 신촌직영점", "뉴발란스키즈 직영신촌점")
    assert not same("아레나스퀘어4096호", "아레나스퀘어9014호")
    assert not same("아더에러 시그니피컨트 성수", "아더에러 오브샵 성수")
