import { useState } from 'react';
import type { ClientStatus } from '../../types/status';
import { Activity } from '../components/Activity';
import { Brand } from '../components/Brand';
import { useStatus } from '../hooks/use-status';
import { uploadView } from '../lib/status-view';

/** 完成按钮只服从主进程的回执状态，不依据上传百分比自行放行。 */
export function UploadContent({ status, error = '', onExit }: { status: ClientStatus; error?: string; onExit(): void }) {
  const view = uploadView(status);
  const percent = status.upload?.percent;
  return <main className="upload-page" data-phase={view.phase}>
    <Brand/><h1>上传日志，完成监考</h1>
    <p className="intro">开启监考的比赛需要成功上传日志，成绩才能有效。请保持网络连接，等待服务端确认。</p>
    <section className="card" aria-live="polite">
      <div className="row"><strong id="phase">{view.label}</strong><span id="percent">{view.percent}</span></div>
      <progress max={100} value={typeof percent === 'number' && Number.isFinite(percent) ? percent : undefined} aria-label="日志上传进度"/>
      <div className="row detail"><span>{view.bytes}</span><span id="contest">{status.upload?.tid ? `比赛 ${status.upload.tid.slice(-6)}` : ''}</span></div>
      <Activity activity={status.activity}/>
    </section>
    <p className="message" role="status">{error || view.message}</p>
    <button disabled={!status.exitReady} onClick={onExit}>{view.exit}</button>
    <p className="footnote">网络中断时日志会保留在本机，可联网后登录原考试账号补传。</p>
  </main>;
}
export function UploadPage() {
  const { value, error } = useStatus(window.uploadAPI, {});
  const [actionError, setActionError] = useState('');
  return <UploadContent status={value} error={actionError || error} onExit={() => {
    window.uploadAPI.exit().catch(() => setActionError('日志仍在处理中，请稍候。'));
  }}/>;
}
