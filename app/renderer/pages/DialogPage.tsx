import { useEffect, useState } from 'react';
import type { DialogModel } from '../../types/dialog';
import { Brand } from '../components/Brand';

export function DialogContent({ model, busy, onRespond }: { model: DialogModel; busy: boolean; onRespond(response: number, checked: boolean): void }) {
  const [checked, setChecked] = useState(!!model.checkboxChecked);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) { event.preventDefault(); onRespond(model.cancelId, checked); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [model.cancelId, checked, busy, onRespond]);
  return <main role="dialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-detail">
    <Brand/><h1 id="dialog-title">{model.message}</h1>
    <p className="intro dialog-detail" id="dialog-detail">{model.detail}</p>
    {model.checkboxLabel ? <label><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)}/>{model.checkboxLabel}</label> : null}
    <div className="dialog-actions">{model.buttons.map((label, index) => <button key={index} autoFocus={index === model.defaultId}
      className={index === model.defaultId ? '' : 'secondary'} disabled={busy} onClick={() => onRespond(index, checked)}>{label}</button>)}</div>
  </main>;
}
export function DialogPage() {
  const [model, setModel] = useState<DialogModel>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { let active = true; window.dialogAPI.model().then((value) => { if (active) setModel(value); }).catch(() => { if (active) setError('无法读取提示内容，请关闭此窗口重试。'); }); return () => { active = false; }; }, []);
  if (!model) return <main><Brand/><p role="status">{error || '正在读取提示…'}</p></main>;
  return <><DialogContent model={model} busy={busy} onRespond={(response, checked) => {
    if (busy) return;
    setBusy(true);
    window.dialogAPI.respond(response, checked).catch(() => { setBusy(false); setError('操作未完成，请重试。'); });
  }}/>{error ? <p role="alert">{error}</p> : null}</>;
}
