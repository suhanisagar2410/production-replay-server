export interface ExecutionEvent {
  id: string;
  type: string;
  timestamp: number;
  requestId?: string;
  data: Record<string, unknown>;
}

export class CircularBuffer {
  private buffer: ExecutionEvent[];
  private maxSize: number;
  private memoryLimitMB: number;

  constructor(maxSize = 50000, memoryLimitMB = 50) {
    this.buffer = [];
    this.maxSize = maxSize;
    this.memoryLimitMB = memoryLimitMB;
  }

  push(event: ExecutionEvent): void {
    // Evict oldest if maxSize is reached
    if (this.buffer.length >= this.maxSize) {
      this.buffer.shift();
    }

    this.buffer.push(event);

    // Dynamic memory eviction check to guarantee 50MB ceiling
    while (this.estimatedMemoryMB() > this.memoryLimitMB && this.buffer.length > 0) {
      this.buffer.shift();
    }
  }

  getEvents(): ExecutionEvent[] {
    return [...this.buffer];
  }

  clear(): void {
    this.buffer = [];
  }

  estimatedMemoryMB(): number {
    // Fast estimation of memory size of JSON stringified elements
    try {
      const serialized = JSON.stringify(this.buffer);
      return serialized.length / (1024 * 1024);
    } catch {
      return this.buffer.length * 0.001; // fallback approximation
    }
  }
}
