export interface StatusSource<T> {
  status(): Promise<T>;
  onStatus(callback: (value: T) => void): () => void;
}

/** 订阅先于初始读取；迟到的成功或失败都不能覆盖已经收到的实时状态。 */
export function subscribeStatus<T>(source: StatusSource<T>, receive: (value: T) => void, fail: () => void) {
  let active = true, received = false;
  const unsubscribe = source.onStatus((next) => {
    received = true;
    if (active) receive(next);
  });
  source.status().then((next) => { if (active && !received) receive(next); })
    .catch(() => { if (active && !received) fail(); });
  return () => { active = false; unsubscribe(); };
}
