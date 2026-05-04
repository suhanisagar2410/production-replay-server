import { CircularBuffer } from '../core/circular-buffer';
import { getRequestId } from '../core/async-context';

export function patchPostgres(buffer: CircularBuffer): void {
  let pg: any;
  try {
    pg = require('pg');
  } catch {
    // pg not installed in the host app — skip silently
    return;
  }

  if (!pg || !pg.Client || !pg.Client.prototype) return;

  const originalQuery = pg.Client.prototype.query;

  pg.Client.prototype.query = function (text: any, params?: any[], callback?: Function) {
    const queryId = `db-q-${Math.random().toString(36).substring(2, 9)}`;
    const startTime = Date.now();
    const requestId = getRequestId();
    const sqlText = typeof text === 'string' ? text : text?.text ?? '[unknown]';

    // Push query start event into buffer
    buffer.push({
      id: queryId,
      type: 'db_query_start',
      timestamp: startTime,
      requestId,
      data: {
        queryId,
        sql: sqlText,
        params: params ? JSON.stringify(params) : '[]',
        dbType: 'postgresql',
      },
    });

    // Call original — handle both callback and promise styles
    const result = originalQuery.apply(this, arguments as any);

    // Promise-style (modern usage)
    if (result && typeof result.then === 'function') {
      result.then(
        (res: any) => {
          buffer.push({
            id: `db-e-${Math.random().toString(36).substring(2, 9)}`,
            type: 'db_query_end',
            timestamp: Date.now(),
            requestId,
            data: {
              queryId,
              duration: Date.now() - startTime,
              rowCount: res?.rowCount ?? 0,
              success: true,
              sql: sqlText,
            },
          });
        },
        (err: any) => {
          buffer.push({
            id: `db-e-${Math.random().toString(36).substring(2, 9)}`,
            type: 'db_query_end',
            timestamp: Date.now(),
            requestId,
            data: {
              queryId,
              duration: Date.now() - startTime,
              error: err?.message ?? 'Unknown DB error',
              success: false,
              sql: sqlText,
            },
          });
        }
      );
    }

    return result;
  };

  console.log('[Production Replay SDK] Successfully attached PostgreSQL runtime query interceptor.');
}
