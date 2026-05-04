import { CircularBuffer } from '../core/circular-buffer';
import { getRequestId } from '../core/async-context';

export function patchMongoose(buffer: CircularBuffer): void {
  let mongoose: any;
  try {
    mongoose = require('mongoose');
  } catch {
    // mongoose not installed in the host app — skip silently
    return;
  }

  if (!mongoose || !mongoose.Query || !mongoose.Query.prototype) return;

  const originalExec = mongoose.Query.prototype.exec;

  mongoose.Query.prototype.exec = function (callback?: Function) {
    const queryId = `db-mongo-${Math.random().toString(36).substring(2, 9)}`;
    const startTime = Date.now();
    const requestId = getRequestId();

    const collection = this.model?.collection?.name ?? 'unknown';
    const operation = this.op ?? 'find';
    const conditions = JSON.stringify(this._conditions ?? {});

    buffer.push({
      id: queryId,
      type: 'db_query_start',
      timestamp: startTime,
      requestId,
      data: {
        queryId,
        dialect: 'mongodb',
        collection,
        operation,
        conditions,
      },
    });

    const promise = originalExec.call(this, callback);

    if (promise && typeof promise.then === 'function') {
      promise.then(
        (result: any) => {
          buffer.push({
            id: `db-mongo-e-${Math.random().toString(36).substring(2, 9)}`,
            type: 'db_query_end',
            timestamp: Date.now(),
            requestId,
            data: {
              queryId,
              duration: Date.now() - startTime,
              rowCount: Array.isArray(result) ? result.length : (result ? 1 : 0),
              success: true,
            },
          });
        },
        (err: any) => {
          buffer.push({
            id: `db-mongo-e-${Math.random().toString(36).substring(2, 9)}`,
            type: 'db_query_end',
            timestamp: Date.now(),
            requestId,
            data: {
              queryId,
              duration: Date.now() - startTime,
              error: err?.message,
              success: false,
            },
          });
        }
      );
    }

    return promise;
  };

  console.log('[Production Replay SDK] Successfully attached Mongoose runtime query interceptor.');
}
