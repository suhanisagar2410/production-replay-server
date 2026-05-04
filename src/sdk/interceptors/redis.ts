import { CircularBuffer } from '../core/circular-buffer';
import { getRequestId } from '../core/async-context';

export function patchRedis(buffer: CircularBuffer): void {
  let Redis: any;
  try {
    Redis = require('ioredis');
  } catch {
    // ioredis not installed in the host app — skip silently
    return;
  }

  if (!Redis || !Redis.prototype) return;

  const originalSendCommand = Redis.prototype.sendCommand;
  const TRACKED_COMMANDS = new Set([
    'get', 'set', 'del', 'hget', 'hset', 'expire', 'lpush', 'sadd'
  ]);

  Redis.prototype.sendCommand = function (command: any, stream?: any) {
    const cmdName = (command?.name ?? '').toLowerCase();

    if (!TRACKED_COMMANDS.has(cmdName)) {
      return originalSendCommand.call(this, command, stream);
    }

    const queryId = `redis-${Math.random().toString(36).substring(2, 9)}`;
    const startTime = Date.now();
    const requestId = getRequestId();
    const key = String(command?.args?.[0] ?? '[unknown]');

    buffer.push({
      id: queryId,
      type: 'redis_command_start',
      timestamp: startTime,
      requestId,
      data: {
        queryId,
        command: cmdName.toUpperCase(),
        key,
      },
    });

    const result = originalSendCommand.call(this, command, stream);

    if (result && typeof result.then === 'function') {
      result.then(
        (res: any) => {
          buffer.push({
            id: `redis-e-${Math.random().toString(36).substring(2, 9)}`,
            type: 'redis_command_end',
            timestamp: Date.now(),
            requestId,
            data: {
              queryId,
              duration: Date.now() - startTime,
              hit: res !== null && res !== undefined,
              success: true,
            },
          });
        },
        (err: any) => {
          buffer.push({
            id: `redis-e-${Math.random().toString(36).substring(2, 9)}`,
            type: 'redis_command_end',
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

    return result;
  };

  console.log('[Production Replay SDK] Successfully attached ioredis runtime command interceptor.');
}
