/* eslint style/indent: ['warn', 2], style/indent-binary-ops: ['warn', 2] -- 前端遵循两空格缩进，其余检查保持启用。 */
import type { ClientStatus } from '../../types/status';

/** 入口始终可见，不依赖进入某场比赛后才发现的待上传数量。 */
export function LogRetryControls({ status, pending, onRetry }: {
  status: ClientStatus;
  pending: boolean;
  onRetry: () => void;
}) {
  const busy = pending || status.retrying;
  const result = status.logRetry;
  const upload = status.upload;
  return (
    <div className="log-retry">
      <button
        disabled={!status.loggedIn || !!status.finishing || !!busy}
        data-busy={!!busy}
        title={status.loggedIn ? '扫描当前账号已结束但未上传的日志，按比赛逐份补传' : '请先登录原考试账号'}
        onClick={onRetry}
      >
        {busy ? result?.phase === 'scanning' ? '扫描中…' : '补传中…' : '补传日志'}
      </button>
      {result && (
        <div className="message" role="status" aria-live="polite">
          {result.phase === 'scanning' ? '正在验证账号并扫描本机日志…'
            : result.phase === 'failed' ? '补传未完成，请检查登录账号和网络后重试。'
              : result.total ? `已上传 ${result.uploaded}/${result.total} 份，失败 ${result.failed} 份`
                : '当前账号没有已结束且待补传的日志。'}
          {result.phase === 'uploading' && upload?.tid && <div>正在处理比赛：{upload.tid}</div>}
          {result.phase === 'uploading' && upload?.phase === 'uploading' && (
            <div>
              上传进度：{upload.percent ?? 0}%（{upload.sent || 0} / {upload.total || 0} 字节）
              <progress max={100} value={upload.percent ?? 0} aria-label="日志补传进度" />
            </div>
          )}
          {result.phase === 'uploading' && upload?.phase === 'verifying' && <div>文件已发送，正在等待服务端确认…</div>}
          {result.open > 0 && <div>另有 {result.open} 场监考尚未结束，日志继续保留，可进入对应比赛继续监考或结束后上传。</div>}
          {result.unreadable > 0 && <div>有 {result.unreadable} 份日志状态无法读取，已保留原文件，请联系管理员。</div>}
        </div>
      )}
    </div>
  );
}
