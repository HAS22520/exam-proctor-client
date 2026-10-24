/* eslint style/indent: ['warn', 2], style/indent-binary-ops: ['warn', 2] -- 前端遵循两空格缩进，其余检查保持启用。 */
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ClientStatus } from '../../types/status';
import { Activity } from '../components/Activity';
import { LogRetryControls } from '../components/LogRetryControls';
import { ProctorStatusIcon } from '../components/ProctorStatusIcon';
import { usePanelDrag } from '../hooks/use-panel-drag';
import type { StatusSource } from '../hooks/use-status';
import { bindPanelTheme } from '../lib/panel-theme';
import { panelView } from '../lib/panel-view';

export type PanelAction =
  'exam:request-quit' | 'exam:debug' | 'exam:retry' | 'exam:update-check' | 'exam:update-install' | 'exam:update-download';
export interface PanelBridge extends StatusSource<ClientStatus> {
  action(channel: PanelAction): Promise<unknown>;
}

/** 在 preload 的隔离 world 中挂载；私有操作桥不会暴露给远程 OJ。 */
export function Panel({ bridge, host }: { bridge: PanelBridge, host: HTMLElement }) {
  const [status, setStatus] = useState<ClientStatus>({});
  const [collapsed, setCollapsed] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<PanelAction[]>([]);
  const pendingRef = useRef(new Set<PanelAction>());
  const drag = usePanelDrag(host, () => flushSync(() => setCollapsed(true)));
  useEffect(() => bindPanelTheme(host), [host]);
  useEffect(() => {
    const collapse = (event: Event) => {
      if (!event.composedPath().includes(host)) setCollapsed(true);
    };
    const document = host.ownerDocument;
    document.addEventListener('pointerdown', collapse, true);
    document.addEventListener('click', collapse, true);
    const onBlur = () => {
      if (document.activeElement?.tagName === 'IFRAME') setCollapsed(true);
    };
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('pointerdown', collapse, true);
      document.removeEventListener('click', collapse, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [host]);
  useEffect(() => {
    let active = true;
    let polling = false;
    const refresh = async () => {
      if (polling) return;
      polling = true;
      try {
        const next = await bridge.status();
        if (active) {
          setStatus(next);
          setError('');
        }
      } catch {
        if (active) setError('请返回考试系统查看监考状态');
      } finally {
        polling = false;
      }
    };
    const unsubscribe = bridge.onStatus((next) => {
      if (active) {
        setStatus(next);
        setError('');
      }
    });
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      active = false;
      clearInterval(timer);
      unsubscribe();
    };
  }, [bridge]);
  const view = panelView(status);
  const update = status.update || { phase: 'disabled' };
  async function action(channel: PanelAction) {
    if (pendingRef.current.has(channel)) return;
    pendingRef.current.add(channel);
    setPending([...pendingRef.current]);
    try {
      await bridge.action(channel);
      setStatus(await bridge.status());
      setError('');
    } catch (failure) {
      setError((failure instanceof Error ? failure.message : '操作未完成，请重试。').slice(0, 500));
    } finally {
      pendingRef.current.delete(channel);
      setPending([...pendingRef.current]);
    }
  }
  const button = (channel: PanelAction, label: string, disabled = false, title?: string, className?: string) => (
    <button
      disabled={disabled || pending.includes(channel)}
      data-busy={pending.includes(channel)}
      title={title}
      className={className}
      onClick={() => void action(channel)}
    >
      {label}
    </button>
  );
  return (
    <div
      className={`panel${collapsed ? ' collapsed' : ' expanded'}`}
      data-state={view.state}
      data-collapsed={collapsed}
      {...drag}
      onClick={() => {
        if (collapsed) setCollapsed(false);
      }}
    >
      <button
        type="button"
        className="status-ball"
        data-panel-drag-handle
        aria-label={`${view.badge}，展开监考面板`}
        aria-expanded={!collapsed}
        title={`${view.badge} · 点击展开，拖动移动`}
        tabIndex={collapsed ? 0 : -1}
      >
        <span className="ball-icon">
          <ProctorStatusIcon state={view.state} />
        </span>
        <span className="ball-pulse" aria-hidden="true" />
      </button>

      <div className="panel-content" aria-hidden={collapsed}>
        <div className="heading" title="拖动标题收起并移动监考面板" data-panel-drag-handle>
          <div className="heading-left">
            <span className="status-icon"><ProctorStatusIcon state={view.state} /></span>
            <span className="brand">{status.productName || '监考客户端'}</span>
          </div>
          <div className="heading-right">
            <span className="badge" data-state={view.state}>
              {view.badge}
            </span>
            <button
              type="button"
              className="toggle"
              aria-label="收起监考面板"
              aria-expanded={!collapsed}
              title="收起为悬浮球"
              onClick={(event) => {
                event.stopPropagation();
                setCollapsed(true);
              }}
            >
              −
            </button>
          </div>
        </div>
        <div className="panel-scroll-body">
          <Activity activity={status.activity} compact />
          <div className="body">
            <div className="status">{view.title}</div>
            <div className="meta">{view.meta}</div>
            <div className="message" role="status">
              {error || view.message}
            </div>
            <div className="version">{view.version}</div>
            {view.warning ? <div className="update-warning">{view.warning}</div> : null}
            <div className="updates">
              {update.enabled ? button('exam:update-check', '检查更新', view.busy) : null}
              {update.canHotUpdate ? button('exam:update-install', '更新并重启', view.busy || view.installBlocked, view.installTitle) : null}
              {update.installerUrl ? button('exam:update-download', '下载安装包', view.busy) : null}
            </div>
            <LogRetryControls status={status} pending={pending.includes('exam:retry')} onRetry={() => void action('exam:retry')} />
            <div className="actions">
              {status.root && status.allowRootDebug ? button('exam:debug', '调试控制台') : null}
              {button('exam:request-quit', '退出 / 结束监考', !!status.finishing || !!status.retrying, undefined, 'end')}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
