import { useEffect, useState } from 'react';

export interface StatusSource<T> {
  status(): Promise<T>;
  onStatus(callback: (value: T) => void): () => void;
}

/** 先订阅再读初值；若实时推送先到达，不让较旧的初值覆盖它。 */
export function useStatus<T>(source: StatusSource<T>, initial: T) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true, received = false;
    const unsubscribe = source.onStatus((next) => { received = true; if (active) setValue(next); });
    source.status().then((next) => { if (active && !received) setValue(next); })
      .catch(() => { if (active) setError('无法读取状态，请保留客户端数据。'); });
    return () => { active = false; unsubscribe(); };
  }, [source]);
  return { value, error };
}
