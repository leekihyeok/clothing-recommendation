import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** HTTP client for services/model. The model service is internal-only; nothing else should call it. */
@Injectable()
export class ModelClient {
  private readonly baseUrl: string;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>('MODEL_SERVICE_URL', 'http://localhost:8100');
  }

  async get<T>(path: string, timeoutMs = 3000): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      throw new Error(`model service ${path} responded ${res.status}`);
    }
    return (await res.json()) as T;
  }

  async post<T>(path: string, body: unknown, timeoutMs = 10000): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 503) {
      // Free AI quota used up or every model overloaded (services/model app/main.py): say so in words.
      throw new ServiceUnavailableException('AI가 지금 붐벼요. 잠시 뒤 다시 해 주세요. 지역과 칩으로 고르면 바로 짤 수 있어요');
    }
    if (!res.ok) {
      throw new Error(`model service ${path} responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }
}
