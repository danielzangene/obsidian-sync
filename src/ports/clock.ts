export interface Clock {
  /** Device time, epoch ms. Never compared with server times (DESIGN §5.1). */
  now(): number;
  sleep(ms: number): Promise<void>;
}
