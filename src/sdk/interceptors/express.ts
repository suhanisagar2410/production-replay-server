import { Request, Response, NextFunction } from 'express';
import { runWithRequestId } from '../core/async-context';
import { CircularBuffer } from '../core/circular-buffer';
import { safeSerialize } from '../core/serializer';

export function expressInterceptor(buffer: CircularBuffer, serviceName: string, environment: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = `req-${Math.random().toString(36).substring(2, 9)}`;
    const startTime = Date.now();

    // Trace inbound http request event
    buffer.push({
      id: `evt-${Math.random().toString(36).substring(2, 9)}`,
      type: 'http_request',
      timestamp: startTime,
      requestId,
      data: {
        method: req.method,
        url: req.originalUrl || req.url,
        headers: safeSerialize(req.headers),
        body: safeSerialize(req.body),
      },
    });

    // Run in scoped AsyncLocalStorage context
    runWithRequestId(requestId, () => {
      // Monkey patch res.end to trace inbound http response event
      const originalEnd = res.end;
      res.end = function(chunk?: any, encoding?: any, cb?: any) {
        const endTime = Date.now();
        const duration = endTime - startTime;

        buffer.push({
          id: `evt-${Math.random().toString(36).substring(2, 9)}`,
          type: 'http_response',
          timestamp: endTime,
          requestId,
          data: {
            statusCode: res.statusCode,
            duration,
          },
        });

        return originalEnd.call(this, chunk, encoding, cb);
      };

      next();
    });
  };
}
