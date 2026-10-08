# 옷길 — 서울 옷가게 코스 추천

전체 계획과 단계별 진행 상황은 [PLAN.md](PLAN.md)에 있습니다.

## 구성

| 경로 | 내용 | 포트 |
|---|---|---|
| `apps/client` | React + TypeScript + Vite + Bootstrap | 5180 |
| `apps/api` | NestJS + Apollo GraphQL | 4000 (`/graphql`) |
| `services/model` | Python FastAPI (문장 이해, 코스 계산, 데이터 파이프라인) | 8100 |
| `packages/shared` | `catalog.json`: 스타일·품목·기본값 목록. TS와 Python이 같이 읽음 | — |

PostgreSQL(PostGIS + pgvector)과 Redis는 Docker로 띄웁니다 (`infra/docker-compose.yml`, 포트 5433·6380). PC에 원래 설치된 PostgreSQL·Redis와는 따로 동작합니다.

## 처음 한 번

1. **Node 24**: 이 프로젝트는 Node 22.22 이상이 필요합니다. PC 전체 버전은 그대로 두고, 이 프로젝트 터미널에서만 Node 24를 씁니다.
   ```powershell
   nvm install 24            # 이미 설치되어 있으면 생략
   . .\scripts\use-node.ps1  # 앞의 점(.)까지 입력. 이 터미널에만 적용됨
   ```
   터미널을 새로 열 때마다 `. .\scripts\use-node.ps1`을 먼저 실행합니다.
2. **의존성**
   ```powershell
   npm install
   cd services/model; python -m venv .venv; .venv\Scripts\python -m pip install -e ".[dev]"; cd ../..
   ```
3. **환경 변수**: `.env.example`을 `.env`로 복사합니다. DB·Redis 값은 Docker 설정과 이미 맞춰져 있고, API 키만 채우면 됩니다.
4. **Docker Desktop**을 실행해 둡니다.

## 실행

```powershell
. .\scripts\use-node.ps1
npm run infra:up   # DB, Redis (Docker). 처음엔 이미지 빌드로 몇 분 걸림
npm run dev        # api, client, model 세 개를 한 번에 실행
```

`npm run infra:down`으로 DB와 Redis를 끕니다. 데이터는 Docker 볼륨에 남습니다.

브라우저에서 http://localhost:5180 을 열면 연결 상태판에서 각 구성 요소의 상태를 볼 수 있습니다.

## 자주 쓰는 명령

| 명령 | 하는 일 |
|---|---|
| `npm run codegen` | API 스키마(`apps/api/schema.gql`)로 클라이언트 GraphQL 타입 생성. API를 한 번 실행한 뒤 사용 |
| `npm run typecheck` | 공용 패키지 빌드 + API·클라이언트 타입 검사 |
| `npm run test:model` | 모델 서버 테스트 |
