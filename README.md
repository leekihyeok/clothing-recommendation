# ROUTE 01 — 취향대로 걷는 서울 옷가게 코스

원하는 스타일과 동네, 시간을 말하면 그 조건에 맞는 서울 옷가게를 골라 **걸어서 도는 순서**까지 짜 주는 웹앱입니다.

> "성수에서 빈티지 위주로 3시간, 끝나면 성수역으로" → 가게 5곳, 실제 도보 경로, 도착 예정 시각, 가게마다 들를 이유

- 가게 정보는 사람이 하나씩 입력하지 않습니다. 카카오맵·공공데이터·블로그 글을 모은 뒤 AI가 스타일을 채점하고 검증해서 만듭니다.
- 코스는 영업시간, 날씨, 걷는 거리를 함께 따져서 계산합니다.

## 주요 기능

**코스 짜기**
- 버튼·칩으로 고르거나, 문장으로 쓰거나("홍대 빈티지 6시까지"), 옷 사진을 올려서 요청할 수 있어요.
- 한 번에 세 가지 버전이 나와요: 추천, 가까운 위주, 취향 위주.
- **시간:** 출발 시각과 끝나는 시각을 정하면 가게별 영업시간을 맞춰요. 영업시간은 사장님이 올린 것을 먼저 쓰고, 없으면 블로그 글에서 읽어요.
- **날씨:** 기상청 단기예보를 봐서 비나 더위가 예보되면 실내(백화점·몰)를 넣고 걷는 거리를 줄여요.
- **조건:** 꼭 넣을 가게(고정)와 브랜드("아더에러 파는 곳"), 누구 옷, 예산, 카페·맛집 쉬어 가기, 끝나는 곳을 정할 수 있어요.
- 같은 조건으로 "다른 코스"를 받아도 고정한 가게와 브랜드는 그대로 남아요.

**고치기**
- 버튼으로 고쳐요: 빼기, 다른 가게로, 옮기기, 더 넣기, 가깝게 다시 짜기.
- 말로도 고쳐요: "3번 빼고 신발 가게로".
- 되돌리기는 서버에도 저장돼요.

**걷기·공유**
- 걷기 모드: 다음 장소, 남은 거리, 도착 확인, 가게 평가, 완주 요약 카드를 보여 줘요.
- 공유 링크, 같이 가기(친구 취향을 섞어 다시 짜기), 저장한 코스, 최근 코스가 있어요.

**가게**
- 상세 화면: 소개, 블로그 평판, 후기·별점, 비슷한 가게(임베딩), 찜·다녀옴을 볼 수 있어요.
- 사장님 인증은 사업자등록증 사진으로 해요. 관리자가 확인한 뒤 사진은 바로 지워요. 인증된 사장님은 영업시간·사진·소식을 올릴 수 있어요.

**그 밖에**
- 한국어/영어: 가게 소개와 코스 문구는 미리 번역해 둔 것을 써요.
- 관리자 화면: 사용 통계, 데이터 건강(데이터 작업 상태, 단계별 남은 일, 오늘 AI·T map 사용량), 품질 표본 검수, 사장님 신청 처리를 해요.

## 구조

```
apps/client      React 19 · TypeScript · Vite · Apollo Client · Bootstrap(SCSS) · 카카오맵      :5180
apps/api         NestJS · Apollo GraphQL · PostgreSQL(pg) · Redis                             :4000/graphql
services/model   Python · FastAPI: 문장·사진 이해(AI), 코스 최적화, 데이터 파이프라인        :8100
packages/shared  catalog.json: 스타일·품목·기본값 (TS와 Python이 같이 읽음)
infra            docker-compose (PostgreSQL + PostGIS + pgvector + pg_trgm, Redis), SQL 마이그레이션
```

- 사용자 요청은 **client → api(GraphQL) → model(최적화·AI)** 순서로 처리돼요. API가 가게 후보를 DB에서 고르고 점수를 매기면, 모델 서버가 순서를 계산해요. 계산은 영업시간을 고려한 빔 서치와 로컬 서치예요.
- **AI**는 Gemini 무료 등급을 써요(`AI_PROVIDER`로 바꿀 수 있게 만들었고, Claude 어댑터 자리도 있어요). 사용자 요청에 쓰는 몫과 데이터 작업에 쓰는 몫을 나눠서 관리해요.
- **데이터 작업**(`services/model/pipeline`)은 백그라운드에서 혼자 돌아요. 순서는 이래요.
  1. 근거 글 수집
  2. 스타일 채점
  3. 검증
  4. 평판·영업시간·브랜드 읽기
  5. 임베딩
  6. 번역
  7. 주간·월간 갱신과 오래된 기록 정리
- 진행 상황은 `python -m pipeline.status`나 관리자 화면에서 볼 수 있어요.

자세한 설계는 [PLAN.md](PLAN.md)에, 진행 기록은 [PROGRESS.md](PROGRESS.md)에, 남은 일은 [BACKLOG.md](BACKLOG.md)에 있어요.

## 시작하기

개발은 Windows(PowerShell)에서 했어요. 실행 스크립트(`scripts/*.ps1`, `npm run dev:model`의 `.venv\Scripts`)도 Windows 기준이에요.

### 준비물

- Node.js **22.22 이상**(개발은 24에서 했어요)
- Python 3.12 이상
- Docker Desktop

### 설치

```powershell
npm install
cd services/model; python -m venv .venv; .venv\Scripts\python -m pip install -e ".[dev]"; cd ../..
copy .env.example .env      # 아래 표를 보고 키를 채워요
```

PC 전체의 Node 버전을 바꾸고 싶지 않으면, 터미널마다 `. .\scripts\use-node.ps1`을 실행해서 그 터미널에서만 nvm의 Node 24를 쓰면 돼요.

### 실행

```powershell
npm run infra:up                                   # PostgreSQL, Redis (Docker, 포트 5433·6380)
cd services/model; .venv\Scripts\python -m pipeline.migrate; cd ../..   # DB 마이그레이션
npm run dev                                        # api, client, model 동시 실행
```

브라우저에서 http://localhost:5180 을 열어요. 맨 아래 "개발 정보"에서 각 구성 요소의 연결 상태를 볼 수 있어요.

가게 데이터는 데이터 작업으로 채워요. 처음 한 번은 아래 명령으로 시작해요. 키가 있는 출처만 모아요.

```powershell
cd services/model
.venv\Scripts\python -m pipeline.refresh --once    # 한 바퀴 돌고 멈춤 (계속 돌리려면 scripts/pipeline-bg.ps1)
.venv\Scripts\python -m pipeline.status            # 진행 상황
```

### 환경 변수 (`.env`)

DB·Redis 값은 `docker-compose` 설정과 이미 맞춰져 있어요. 나머지 키는 없어도 앱은 떠요. 대신 해당 기능이 꺼지거나 대체 방식으로 동작해요.

| 변수 | 쓰는 곳 | 없으면 |
|---|---|---|
| `VITE_KAKAO_MAP_JS_KEY` | 지도 (카카오 JavaScript 키) | 지도가 안 떠요 |
| `KAKAO_REST_API_KEY`, `KAKAO_CLIENT_SECRET`, `KAKAO_REDIRECT_URI` | 가게 수집, 장소 검색, 카카오 로그인 | 로그인과 가게 수집이 안 돼요 |
| `KAKAO_ADMIN_KEY` | 탈퇴할 때 카카오 연결 끊기 | 탈퇴는 되지만 연결은 남아요 |
| `GEMINI_API_KEY`, `AI_PROVIDER` | 문장·사진 이해, 데이터 채점·검증·번역 | AI 기능이 꺼져요(버튼으로 짜기는 돼요) |
| `AI_BATCH_DAILY_CAP` | 데이터 작업이 모델별로 하루에 쓸 AI 상한 | 기본 420 |
| `NAVER_SEARCH_CLIENT_ID`, `NAVER_SEARCH_CLIENT_SECRET` | 블로그·카페 근거 글 수집 | 채점할 근거가 안 모여요 |
| `TMAP_APP_KEY`, `TMAP_DAILY_CAP` | 실제 도보 경로 (SK T map) | 직선 거리로 어림해요 |
| `DATA_GO_KR_SERVICE_KEY` | 기상청 단기예보 | Open-Meteo 예보를 써요 |
| `ODSAY_API_KEY` | 대중교통 길찾기 | 카카오맵 길찾기 링크만 나와요 |
| `ADMIN_KAKAO_IDS` | 관리자 화면에 들어갈 카카오 계정 id (쉼표로 구분) | 관리자 화면에 못 들어가요 |
| `NODE_ENV=production`, `TRUST_PROXY=1` | 배포: 오류 내부 정보 숨김, 프록시 뒤 IP | 개발 모드로 동작해요 |

`.env`는 git에 올라가지 않아요(`.gitignore`). 사용자가 올린 사진(`data/uploads`)과 사업자등록증(`data/private`)도 마찬가지예요.

## 자주 쓰는 명령

| 명령 | 하는 일 |
|---|---|
| `npm run dev` | api·client·model 동시 실행 |
| `npm run codegen` | API 스키마(`apps/api/schema.gql`)로 클라이언트 GraphQL 타입 생성. API가 한 번 떠야 스키마가 생겨요 |
| `npm run typecheck` | 공용 패키지 빌드 + API·클라이언트 타입 검사 |
| `npm run test:model` | 모델 서버 테스트 (최적화, 파이프라인 규칙, AI 한도) |
| `scripts/dev-bg.ps1` / `dev-bg-stop.ps1` | 개발 서버를 창 없이 띄우기 / 끄기 |
| `scripts/pipeline-bg.ps1` / `pipeline-bg-stop.ps1` | 데이터 작업을 백그라운드로 띄우기 / 끄기 (`pipeline-task.ps1`: 로그인할 때 자동 시작) |

## 보안·개인정보 메모

- **요청 횟수 제한:** AI·코스 짜기·고치기 등에 사람별·IP별 한도가 있어요. 횟수는 Redis로 세요.
- **"내 위치" 출발점:** 약 200m 단위로 뭉개서 저장해요. 공유 링크를 받은 사람에게 집 위치가 드러나지 않게 하려는 거예요.
- **오래된 개인정보:** 데이터 작업이 매주 지워요. 대상은 오래된 익명 기록, 처리가 끝난 사장님 신청의 연락처, 오래된 사용 기록이에요.
- **배포 설정:** `NODE_ENV=production`이면 GraphQL 오류에서 내부 정보를 숨기고 스키마 조회(introspection)를 꺼요.
