import { CircularBuffer, ExecutionEvent } from './core/circular-buffer';
import { expressInterceptor } from './interceptors/express';
import { outgoingHttpInterceptor } from './interceptors/http';
import { uploadReplay } from './uploader';
import { getRequestId } from './core/async-context';

export interface SdkOptions {
  apiKey: string;
  apiUrl?: string;
  serviceName?: string;
  environment?: 'production' | 'staging' | 'development';
  memoryLimitMB?: number;
  maxEvents?: number;
}

export class ProductionReplaySdk {
  private buffer: CircularBuffer;
  private apiKey: string;
  private apiUrl: string;
  private serviceName: string;
  private environment: string;
  private isInitialized = false;

  constructor() {
    this.buffer = new CircularBuffer(20000, 50);
    this.apiKey = '';
    this.apiUrl = 'http://localhost:4000';
    this.serviceName = 'unknown-service';
    this.environment = 'production';
  }

  init(options: SdkOptions): void {
    if (this.isInitialized) return;

    this.apiKey = options.apiKey;
    this.apiUrl = options.apiUrl || 'http://localhost:4000';
    this.serviceName = options.serviceName || 'host-app';
    this.environment = options.environment || 'production';

    if (options.maxEvents || options.memoryLimitMB) {
      this.buffer = new CircularBuffer(options.maxEvents || 20000, options.memoryLimitMB || 50);
    }

    // Initialize core interceptors immediately
    outgoingHttpInterceptor(this.buffer);

    // Trap critical execution panics (Uncaught Exceptions & Rejections)
    process.on('uncaughtException', (err) => {
      this.capture(err, 'uncaught_exception', 'Fatal exception occurred');
      // Wait slightly for upload then exit
      setTimeout(() => process.exit(1), 1000);
    });

    process.on('unhandledRejection', (reason) => {
      this.capture(reason instanceof Error ? reason : new Error(String(reason)), 'unhandled_rejection');
    });

    this.isInitialized = true;
    console.log(`[Production Replay SDK] Initialized successfully for service: "${this.serviceName}"`);
  }

  expressMiddleware() {
    return expressInterceptor(this.buffer, this.serviceName, this.environment);
  }

  // Record manual function traces or in-scope executions
  recordEvent(type: string, data: Record<string, any>): void {
    if (!this.isInitialized) return;

    this.buffer.push({
      id: `evt-${Math.random().toString(36).substring(2, 9)}`,
      type,
      timestamp: Date.now(),
      requestId: getRequestId(),
      data,
    });
  }

  // Flush buffer to API server immediately
  capture(err: Error, triggerType: string = 'manual', triggerLabel?: string): void {
    if (!this.isInitialized) return;

    // Log the error event first
    this.recordEvent('error', {
      name: err.name,
      message: err.message,
      stack: err.stack,
    });

    const events = this.buffer.getEvents();
    if (events.length === 0) return;

    const firstEventTime = events[0].timestamp;
    const lastEventTime = events[events.length - 1].timestamp;

    // Extract httpCaptures and dbQueries out of internal events
    const httpCaptures: any[] = [];
    const dbQueries: any[] = [];

    events.forEach(e => {
      if (e.type === 'http_request' || e.type === 'http_response') {
        httpCaptures.push({ id: e.id, requestId: e.requestId, ...e.data });
      } else if (e.type === 'db_query_start' || e.type === 'db_query_end') {
        dbQueries.push({ id: e.id, ...e.data });
      }
    });

    uploadReplay(this.apiUrl, this.apiKey, {
      triggerType,
      triggerLabel,
      errorMessage: err.message,
      errorStack: err.stack,
      serviceName: this.serviceName,
      environment: this.environment,
      durationMs: lastEventTime - firstEventTime,
      eventCount: events.length,
      events,
      httpCaptures,
      dbQueries,
    });
  }
}

// Singleton global SDK instance
export const replay = new ProductionReplaySdk();
export default replay;
