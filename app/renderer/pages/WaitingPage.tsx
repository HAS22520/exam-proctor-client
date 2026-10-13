/* eslint style/indent: ['warn', 2], style/indent-binary-ops: ['warn', 2] -- 前端遵循两空格缩进，其余检查保持启用。 */
import { Activity } from '../components/Activity';
import { Brand } from '../components/Brand';
import { useStatus } from '../hooks/use-status';

export function WaitingPage() {
  const { value, error } = useStatus(window.waitingAPI, null);
  return (
    <main>
      <Brand />
      <h1>正在准备，请稍候</h1>
      <section className="card" aria-live="polite">
        <strong>{value?.label || '正在检查考试环境'}</strong>
        <progress aria-label="准备状态" />
        <Activity activity={value} />
      </section>
      <p className="message">{error || value?.hint || '准备完成后会自动打开考试页面。'}</p>
    </main>
  );
}
