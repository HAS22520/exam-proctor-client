const entries = [];
let cursor = 0;
const logs = document.getElementById('logs'), status = document.getElementById('status');
const filter = document.getElementById('filter'), level = document.getElementById('level'), follow = document.getElementById('follow');
const line = (entry) => `${entry.time} ${entry.level.toUpperCase()} ${entry.event} ${JSON.stringify(entry.data)}`;
function render() {
  const query = filter.value.toLowerCase();
  const visible = entries.filter((entry) => (!level.value || entry.level === 'error' || level.value === 'warn' && entry.level === 'warn')
    && line(entry).toLowerCase().includes(query));
  const scroll = logs.scrollTop;
  logs.replaceChildren(...visible.map((entry) => {
    const row = document.createElement('div'); row.className = entry.level; row.textContent = line(entry); return row;
  }));
  logs.scrollTop = follow.checked ? logs.scrollHeight : scroll;
}
filter.oninput = render; level.onchange = render; follow.onchange = render;
document.getElementById('copy').onclick = async () => {
  try { await navigator.clipboard.writeText(logs.textContent); status.textContent = '已复制当前显示的日志'; }
  catch { status.textContent = '复制失败，可直接选中日志复制'; }
};
document.getElementById('devtools').onclick = async () => {
  try { await window.debugAPI.devtools(); } catch { status.textContent = '管理员身份已失效'; }
};
async function poll() {
  try {
    const result = await window.debugAPI.logs(cursor);
    entries.push(...result.entries); entries.splice(0, Math.max(0, entries.length - 1000)); cursor = result.latest;
    if (result.entries.length) render();
    status.textContent = `实时连接 · ${entries.length} 条记录 · ${new Date().toLocaleTimeString()}`;
    document.getElementById('file').textContent = result.file ? `诊断文件：${result.file}（每次启动最多 4 MiB，保留最近 3 次）` : '本次未写入诊断文件';
  } catch { status.textContent = '控制台连接失败或管理员身份已失效'; }
  setTimeout(poll, 1000);
}
poll();
