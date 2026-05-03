import http from 'http';
import https from 'https';
import { redactObject } from './redaction';

export interface UploadPayload {
  triggerType: string;
  triggerLabel?: string;
  errorMessage?: string;
  errorStack?: string;
  serviceName: string;
  environment: string;
  durationMs: number;
  eventCount: number;
  events: any[];
  httpCaptures: any[];
  dbQueries: any[];
}

export function uploadReplay(apiUrl: string, apiKey: string, payload: UploadPayload): void {
  try {
    const safeUrl = apiUrl || 'http://localhost:4000';
    const parsed = new URL(safeUrl);

    // Apply strict redaction to payload right before data leaves the server
    const redactedPayload = redactObject(payload);
    const body = JSON.stringify(redactedPayload);

    const client = parsed.protocol === 'https:' ? https : http;

    const req = client.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: '/api/ingest/replay',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      }
    }, (res) => {
      // Intentionally discard standard streams to avoid intercepting memory
      res.resume();
    });

    req.on('error', (err) => {
      console.error('[Production Replay SDK] Failed to send buffer snapshot to ingest server:', err.message);
    });

    req.write(body);
    req.end();
  } catch (err: any) {
    console.error('[Production Replay SDK] Silent fallback to avoid crashing host application:', err.message);
  }
}
