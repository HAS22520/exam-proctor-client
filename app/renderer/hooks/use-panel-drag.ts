/* eslint style/indent: ['warn', 2], style/indent-binary-ops: ['warn', 2] -- 前端遵循两空格缩进，其余检查保持启用。 */
import { type PointerEvent, useEffect, useRef } from 'react';

const storageKey = 'hydro-proctor-panel-position';
const clamp = (value: number, max: number) => Math.max(0, Math.min(value, Math.max(0, max)));

/** 仅存归一化坐标；窗口缩放、收起或内容变高时重新约束到可见区域。 */
export function usePanelDrag(host: HTMLElement) {
  const position = useRef<{ x: number, y: number }>(null);
  const dragging = useRef<{ id: number, x: number, y: number }>(null);
  const place = () => {
    if (!position.current) return;
    const rect = host.getBoundingClientRect();
    host.style.right = 'auto';
    host.style.bottom = 'auto';
    host.style.left = `${clamp(position.current.x * (window.innerWidth - rect.width), window.innerWidth - rect.width)}px`;
    host.style.top = `${clamp(position.current.y * (window.innerHeight - rect.height), window.innerHeight - rect.height)}px`;
  };
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) position.current = saved;
    } catch {
      /* 页面可能禁用 localStorage，拖动仍然可用。 */
    }
    place();
    const resize = () => place();
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    window.addEventListener('resize', resize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, [host]);
  const stop = () => {
    if (!dragging.current) return;
    dragging.current = null;
    try {
      if (position.current) localStorage.setItem(storageKey, JSON.stringify(position.current));
    } catch {}
  };
  return {
    onPointerDown(event: PointerEvent<HTMLDivElement>) {
      if (event.button !== 0 || (event.target as Element).closest('button')) return;
      const rect = host.getBoundingClientRect();
      dragging.current = { id: event.pointerId, x: event.clientX - rect.left, y: event.clientY - rect.top };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    onPointerMove(event: PointerEvent<HTMLDivElement>) {
      const drag = dragging.current;
      if (!drag || drag.id !== event.pointerId) return;
      const rect = host.getBoundingClientRect();
      const width = Math.max(0, window.innerWidth - rect.width);
      const height = Math.max(0, window.innerHeight - rect.height);
      position.current = {
        x: width ? clamp(event.clientX - drag.x, width) / width : 0,
        y: height ? clamp(event.clientY - drag.y, height) / height : 0,
      };
      place();
    },
    onPointerUp: stop,
    onPointerCancel: stop,
    onLostPointerCapture: stop,
  };
}
