import * as inspector from 'inspector';
import { CircularBuffer } from './circular-buffer';
import { getRequestId } from './async-context';

export class ExecutionTracer {
  private session: inspector.Session | null = null;
  private buffer: CircularBuffer;
  private isEnabled = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(buffer: CircularBuffer) {
    this.buffer = buffer;
  }

  enable(): void {
    if (this.isEnabled) return;

    try {
      this.session = new inspector.Session();
      this.session.connect();

      this.session.post('Debugger.enable', {});
      this.session.post('Runtime.enable', {});
      this.session.post('Debugger.setPauseOnExceptions', { state: 'uncaught' });

      // Trace call stack snapshot every 500ms periodically - production-safe
      this.timer = setInterval(() => {
        this.captureStackSnapshot();
      }, 500);

      this.isEnabled = true;
      console.log('[Production Replay SDK] V8 Inspector execution tracer is active in periodic sampling mode.');
    } catch (err) {
      console.warn('[Production Replay SDK] Could not attach V8 Inspector tracer:', err);
    }
  }

  private captureStackSnapshot(): void {
    const err = new Error();
    const stack = err.stack;
    if (!stack) return;

    const frames = stack
      .split('\n')
      .slice(2) // skip own frame and captureStackSnapshot
      .map(line => {
        const match = line.match(/at\s+(.+)\s+\((.+):(\d+):(\d+)\)/) || line.match(/at\s+(.+):(\d+):(\d+)/);
        if (!match) return null;
        if (match.length === 5) {
          return {
            functionName: match[1],
            file: match[2],
            line: parseInt(match[3], 10),
          };
        }
        return {
          functionName: 'anonymous',
          file: match[1],
          line: parseInt(match[2], 10),
        };
      })
      .filter(Boolean);

    if (frames.length > 0) {
      this.buffer.push({
        id: `stack-${Math.random().toString(36).substring(2, 9)}`,
        type: 'function_call',
        timestamp: Date.now(),
        requestId: getRequestId(),
        data: {
          name: frames[0]?.functionName || 'anonymous',
          file: frames[0]?.file || 'unknown',
          line: frames[0]?.line || 0,
          args: {
            timestamp: Date.now(),
            activeMemoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          },
        },
      });
    }
  }

  disable(): void {
    if (!this.isEnabled) return;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.session) {
      try {
        this.session.post('Debugger.disable', {});
        this.session.disconnect();
      } catch (err) {
        // ignore
      }
      this.session = null;
    }

    this.isEnabled = false;
  }
}
