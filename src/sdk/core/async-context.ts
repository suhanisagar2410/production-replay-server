import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContext {
  requestId: string;
}

export const contextStorage = new AsyncLocalStorage<RequestContext>();

export function getRequestId(): string | undefined {
  return contextStorage.getStore()?.requestId;
}

export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return contextStorage.run({ requestId }, fn);
}
