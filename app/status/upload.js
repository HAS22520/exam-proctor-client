const labels = { 'restoring-network': '正在恢复系统网络', closing: '正在结束监考', preparing: '正在加密日志', uploading: '正在上传日志', verifying: '等待服务端确认', complete: '日志上传完成', deferred: '日志等待补传' };
const bytes = (value) => value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(value / 1024)} KB`;
let activity, activityReceivedAt = performance.now();
function renderTiming() {
  const timing = document.getElementById('timing');
  timing.hidden = !activity?.busy;
  if (!activity?.busy) return;
  const elapsed = Math.floor(((activity.elapsedMs || 0) + performance.now() - activityReceivedAt) / 1000);
  timing.textContent = `已等待 ${elapsed} 秒 · ${elapsed * 1000 > activity.estimatedMaxMs ? '已超出参考耗时，仍在等待系统响应' : `预计 ${Math.ceil(activity.estimatedMinMs / 1000)}–${Math.ceil(activity.estimatedMaxMs / 1000)} 秒（参考）`}`;
  timing.title = activity.hint || '';
}
function render(status) {
  const upload = status.upload || { phase: 'closing' };
  const phase = upload.phase;
  document.body.dataset.phase = phase;
  activity = status.activity; activityReceivedAt = performance.now();
  document.getElementById('phase').textContent = activity?.busy && activity.kind === 'network' ? activity.label
    : upload.empty ? '本次无需上传日志' : labels[phase] || labels.closing;
  const progress = document.getElementById('progress');
  if (Number.isFinite(upload.percent)) progress.value = upload.percent; else progress.removeAttribute('value');
  document.getElementById('percent').textContent = Number.isFinite(upload.percent) ? `${upload.percent}%` : phase === 'deferred' ? '已保存在本机' : '准备中';
  document.getElementById('bytes').textContent = upload.empty ? '没有待上传的监考日志' : upload.total ? `${bytes(upload.sent)} / ${bytes(upload.total)}`
    : phase === 'complete' ? '服务端已确认接收' : phase === 'deferred' ? '加密日志已保存在本机'
      : phase === 'restoring-network' ? '网络恢复后自动上传日志' : '正在整理日志';
  document.getElementById('contest').textContent = upload.tid ? `比赛 ${upload.tid.slice(-6)}` : '';
  document.getElementById('message').textContent = [status.message || (phase === 'verifying' ? '文件已传输，正在校验并保存。服务端确认后才能完成监考。' : '日志只上传加密文件，请勿强制关闭客户端。'), status.networkWarning].filter(Boolean).join(' ');
  const exit = document.getElementById('exit');
  exit.disabled = !status.exitReady;
  exit.textContent = !status.exitReady ? '请等待日志处理完成' : phase === 'complete' ? '完成并退出' : '保留日志并退出，稍后补传';
  renderTiming();
}
document.getElementById('exit').onclick = async () => {
  try { await window.uploadAPI.exit(); } catch { document.getElementById('message').textContent = '日志仍在处理中，请稍候。'; }
};
window.uploadAPI.onStatus(render);
window.uploadAPI.status().then(render).catch(() => {
  document.getElementById('message').textContent = '无法读取上传状态，请保留客户端数据。';
});
setInterval(renderTiming, 1000);
