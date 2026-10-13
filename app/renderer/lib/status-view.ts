import type { ActivityStatus, ClientStatus, DiagnosticEntry } from '../../types/status';

const uploadLabels: Record<string, string> = {
  'restoring-network': '正在恢复系统网络', closing: '正在结束监考', preparing: '正在加密日志',
  uploading: '正在上传日志', verifying: '等待服务端确认', complete: '日志上传完成', deferred: '日志等待补传',
};
export const bytes = (value = 0) => value >= 1048576 ? `${(value / 1048576).toFixed(1)} MB` : `${Math.ceil(value / 1024)} KB`;
export const diagnosticLine = (entry: DiagnosticEntry) => `${entry.time} ${entry.level.toUpperCase()} ${entry.event} ${JSON.stringify(entry.data)}`;

/** 使用单调时钟累加快照耗时，系统时间调整不会让等待时间倒退。 */
export function activityTiming(activity: ActivityStatus, elapsedMs: number) {
  if (!activity?.busy) return '请查看错误提示，检查连接后重试。';
  const min = activity.estimatedMinMs, max = activity.estimatedMaxMs;
  if (min === undefined || max === undefined) return `已等待 ${Math.floor(elapsedMs / 1000)} 秒 · 正在等待系统响应`;
  return `已等待 ${Math.floor(elapsedMs / 1000)} 秒 · ${elapsedMs > max
    ? '已超出参考耗时，仍在等待系统响应'
    : `预计 ${Math.ceil(min / 1000)}–${Math.ceil(max / 1000)} 秒（参考）`}`;
}

export function uploadView(status: ClientStatus) {
  const upload = status.upload || { phase: 'closing' };
  const phase = upload.phase;
  return {
    phase,
    label: status.activity?.busy && status.activity.kind === 'network' ? status.activity.label
      : upload.empty ? '本次无需上传日志' : uploadLabels[phase] || uploadLabels.closing,
    percent: Number.isFinite(upload.percent) ? `${upload.percent}%` : phase === 'deferred' ? '已保存在本机' : '准备中',
    bytes: upload.empty ? '没有待上传的监考日志' : upload.total ? `${bytes(upload.sent)} / ${bytes(upload.total)}`
      : phase === 'complete' ? '服务端已确认接收' : phase === 'deferred' ? '加密日志已保存在本机'
        : phase === 'restoring-network' ? '网络恢复后自动上传日志' : '正在整理日志',
    message: [status.message || (phase === 'verifying' ? '文件已传输，正在校验并保存。服务端确认后才能完成监考。'
      : '日志只上传加密文件，请勿强制关闭客户端。'), status.networkWarning].filter(Boolean).join(' '),
    exit: !status.exitReady ? '请等待日志处理完成' : phase === 'complete' ? '完成并退出' : '保留日志并退出，稍后补传',
  };
}
