let activity, receivedAt = performance.now();
function render() {
  if (!activity) return;
  document.getElementById('phase').textContent = activity.label;
  const elapsed = Math.floor(((activity.elapsedMs || 0) + performance.now() - receivedAt) / 1000);
  document.getElementById('timing').textContent = activity.busy
    ? `已等待 ${elapsed} 秒 · ${elapsed * 1000 > activity.estimatedMaxMs ? '已超出参考耗时，仍在等待系统响应' : `预计 ${Math.ceil(activity.estimatedMinMs / 1000)}–${Math.ceil(activity.estimatedMaxMs / 1000)} 秒（参考）`}` : '请查看错误提示';
  document.getElementById('hint').textContent = activity.hint || '准备完成后会自动打开考试页面。';
}
function receive(value) { activity = value; receivedAt = performance.now(); render(); }
window.waitingAPI.onStatus(receive);
window.waitingAPI.status().then(receive).catch(() => {});
setInterval(render, 1000);
