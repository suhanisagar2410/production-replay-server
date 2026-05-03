import http from 'http';
import https from 'https';
import { getRequestId } from '../core/async-context';
import { CircularBuffer } from '../core/circular-buffer';

export function outgoingHttpInterceptor(buffer: CircularBuffer) {
  // Save original methods
  const originalHttpRequest = http.request;
  const originalHttpsRequest = https.request;

  const patchRequest = (original: typeof http.request, isHttps: boolean) => {
    return function(this: any, ...args: any[]) {
      const startTime = Date.now();
      const reqId = getRequestId();

      const req = (original as any).apply(this, args);

      req.on('response', (res: any) => {
        const endTime = Date.now();
        buffer.push({
          id: `evt-${Math.random().toString(36).substring(2, 9)}`,
          type: 'http_response',
          timestamp: endTime,
          requestId: reqId,
          data: {
            statusCode: res.statusCode,
            duration: endTime - startTime,
            outbound: true,
          },
        });
      });

      return req;
    };
  };

  http.request = patchRequest(originalHttpRequest, false) as any;
  https.request = patchRequest(originalHttpsRequest, true) as any;
}
