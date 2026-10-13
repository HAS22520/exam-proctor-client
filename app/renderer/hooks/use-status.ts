import { useEffect, useState } from 'react';
import { subscribeStatus, type StatusSource } from '../lib/status-source';
export type { StatusSource } from '../lib/status-source';

/** 先订阅再读初值；若实时推送先到达，不让较旧的初值覆盖它。 */
export function useStatus<T>(source: StatusSource<T>, initial: T) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState('');
  useEffect(() => {
    return subscribeStatus(source, (next) => { setValue(next); setError(''); },
      () => setError('无法读取状态，请保留客户端数据。'));
  }, [source]);
  return { value, error };
}
