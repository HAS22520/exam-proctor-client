import { useEffect, useRef, useState } from 'react';
import type { ClientStatus } from '../../types/status';
import { Activity } from '../components/Activity';
import type { StatusSource } from '../hooks/use-status';
import { usePanelDrag } from '../hooks/use-panel-drag';
import { panelView } from '../lib/panel-view';

export type PanelAction = 'exam:request-quit' | 'exam:debug' | 'exam:retry' | 'exam:update-check' | 'exam:update-install' | 'exam:update-download';
export interface PanelBridge extends StatusSource<ClientStatus> { action(channel: PanelAction): Promise<unknown> }

/** 在 preload 的隔离 world 中挂载；私有操作桥不会暴露给远程 OJ。 */
export function Panel({ bridge, host }: { bridge: PanelBridge; host: HTMLElement }) {
  const [status, setStatus] = useState<ClientStatus>({});
  const [collapsed, setCollapsed] = useState(false), [error, setError] = useState('');
  const [pending, setPending] = useState<PanelAction[]>([]);
  const pendingRef = useRef(new Set<PanelAction>());
  const drag = usePanelDrag(host);
  useEffect(() => {
    let active = true, polling = false;
    const refresh = async () => {
      if (polling) return;
      polling = true;
      try { const next = await bridge.status(); if (active) { setStatus(next); setError(''); } }
      catch { if (active) setError('请返回考试系统查看监考状态'); }
      finally { polling = false; }
    };
    const unsubscribe = bridge.onStatus((next) => { if (active) { setStatus(next); setError(''); } });
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => { active = false; clearInterval(timer); unsubscribe(); };
  }, [bridge]);
  const view = panelView(status), update = status.update || { phase: 'disabled' };
  async function action(channel: PanelAction) {
    if (pendingRef.current.has(channel)) return;
    pendingRef.current.add(channel); setPending([...pendingRef.current]);
    try { await bridge.action(channel); setStatus(await bridge.status()); setError(''); }
    catch (failure) { setError((failure instanceof Error ? failure.message : '操作未完成，请重试。').slice(0, 500)); }
    finally { pendingRef.current.delete(channel); setPending([...pendingRef.current]); }
  }
  const button = (channel: PanelAction, label: string, disabled = false, title?: string, className?: string) =>
    <button disabled={disabled || pending.includes(channel)} data-busy={pending.includes(channel)} title={title} className={className} onClick={() => void action(channel)}>{label}</button>;
  return <div className={`panel${collapsed ? ' collapsed' : ''}`}>
    <div className="heading" title="拖动标题移动监考面板" {...drag}><span className="brand">{status.productName || '监考客户端'}</span><span className="badge" data-state={view.state}>{view.badge}</span>
      <button className="toggle" aria-label={collapsed ? '展开监考面板' : '收起监考面板'} onClick={() => setCollapsed((old) => !old)}>{collapsed ? '+' : '−'}</button></div>
    <Activity activity={status.activity} compact/>
    <div className="body"><div className="status">{view.title}</div><div className="meta">{view.meta}</div>
      <div className="message" role="status">{error || view.message}</div><div className="version">{view.version}</div>
      {view.warning ? <div className="update-warning">{view.warning}</div> : null}
      <div className="updates">
        {update.enabled ? button('exam:update-check', '检查更新', view.busy) : null}
        {update.canHotUpdate ? button('exam:update-install', '更新并重启', view.busy || view.installBlocked, view.installTitle) : null}
        {update.installerUrl ? button('exam:update-download', '下载安装包', view.busy) : null}
      </div><div className="actions">
        {status.pendingUploads ? button('exam:retry', '补传日志') : null}
        {status.root && status.allowRootDebug ? button('exam:debug', '调试控制台') : null}
        {button('exam:request-quit', '退出 / 结束监考', !!status.finishing, undefined, 'end')}
      </div>
    </div>
  </div>;
}
