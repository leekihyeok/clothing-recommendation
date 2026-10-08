import { useQuery } from '@apollo/client';
import { graphql } from '../gql';

const HealthQuery = graphql(`
  query Health {
    health {
      api { ok detail }
      db { ok detail }
      postgis { ok detail }
      redis { ok detail }
      model { ok detail }
      ai { ok detail }
      walk { ok detail }
    }
  }
`);

const ROWS = [
  ['api', 'API 서버'],
  ['db', 'PostgreSQL'],
  ['postgis', 'PostGIS'],
  ['redis', 'Redis'],
  ['model', '모델 서버'],
  ['ai', 'AI'],
  ['walk', '도보 경로'],
] as const;

export function HealthPanel() {
  const { data, loading, error, refetch } = useQuery(HealthQuery, { fetchPolicy: 'network-only' });

  return (
    <section className="mb-4">
      <div className="d-flex align-items-center justify-content-between mb-2">
        <h2 className="h6 mb-0">연결 상태</h2>
        <button className="btn btn-sm btn-outline-secondary" onClick={() => refetch()} disabled={loading}>
          다시 확인
        </button>
      </div>
      {error && (
        <div className="alert alert-danger small py-2 mb-0">
          API 서버에 연결할 수 없습니다: {error.message}
        </div>
      )}
      {data && (
        <ul className="list-group list-group-flush status-list">
          {ROWS.map(([key, label]) => {
            const s = data.health[key];
            return (
              <li key={key} className="list-group-item d-flex gap-2 align-items-start px-0">
                <span className={`status-dot ${s.ok ? 'is-ok' : 'is-down'}`} aria-label={s.ok ? '정상' : '실패'} />
                <span className="fw-medium">{label}</span>
                <span className="text-secondary small ms-auto text-end">{s.detail}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
