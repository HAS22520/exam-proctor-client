const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('examAPI', {
  proctorHeaders: (request) => ipcRenderer.invoke('exam:proctor-headers', request),
  requestQuit: () => ipcRenderer.invoke('exam:request-quit'),
  status: () => ipcRenderer.invoke('exam:status'),
});
window.addEventListener('DOMContentLoaded', () => {
  const host = document.createElement('div');
  host.id = 'hydro-proctor-status';
  host.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;max-width:calc(100vw - 32px)';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    *{box-sizing:border-box} .panel{max-height:calc(100vh - 32px);overflow:auto;width:296px;max-width:100%;padding:16px;border:1px solid #e1e7f0;background:#fff;color:#23324b;border-radius:14px;font:12px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;box-shadow:0 8px 32px #1c35541a}
    .heading{cursor:move;touch-action:none;user-select:none;display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}.brand{font-size:11px;color:#71819b;letter-spacing:1px;font-weight:600}.badge{font-size:11px;padding:2px 8px;background:#edf2fc;color:#5e74a4;border-radius:20px}.badge[data-state=connected]{background:#e8f7ef;color:#23865d}.badge[data-state=debug]{background:#fff4df;color:#a57927}
    .version{color:#8894a8;font-size:11px;margin-top:10px;white-space:pre-line}.updates{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}.updates button{font-size:11px;padding:4px 8px}.status{font-size:14px;font-weight:600}.meta{color:#8894a8;font-size:11px;margin:4px 0 10px}.message{color:#6b7890;font-size:11px;line-height:1.6;white-space:pre-line}.actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}button{border:1px solid #dfe6f1;border-radius:8px;background:white;color:#577098;padding:7px 11px;font:inherit;cursor:pointer}button.end{margin-left:auto;background:#edf2fc;color:#4265b1;border-color:#edf2fc}button:focus-visible{outline:2px solid #7b99e3;outline-offset:2px}button:disabled{opacity:.55;cursor:wait}button[hidden]{display:none}
    button:disabled{cursor:not-allowed}button[data-busy=true]{cursor:wait}.update-warning{color:#94691f;background:#fff7e8;border-radius:8px;padding:8px;margin-top:6px;white-space:pre-line}.update-warning[hidden]{display:none}
    .waiting{padding:10px;margin:8px 0;border-radius:9px;background:#f3f6fc;color:#4265b1}.waiting[hidden]{display:none}.waiting-title{display:flex;align-items:center;gap:8px;font-weight:600}.spinner{flex:none;width:13px;height:13px;border:2px solid #cad7f0;border-top-color:#5275d6;border-radius:50%;animation:spin .8s linear infinite}.waiting[data-busy=false] .spinner{display:none}.waiting-time{color:#71819b;font-size:11px;margin-top:4px}.waiting[data-delayed=true]{background:#fff7e8;color:#94691f}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinner{animation:none}}
    .toggle{border:0;padding:0 3px;color:#8a96aa;font-size:16px;background:none}.panel.collapsed .body{display:none}.panel.collapsed .heading{margin-bottom:0}
  `;
  const box = document.createElement('div');
  box.className = 'panel';
  const heading = document.createElement('div'); heading.className = 'heading';
  const brand = document.createElement('span'); brand.className = 'brand'; brand.textContent = 'HYDRO · 监考';
  const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = '连接中';
  const toggle = document.createElement('button'); toggle.className = 'toggle'; toggle.textContent = '−'; toggle.setAttribute('aria-label', '收起监考面板');
  toggle.onclick = () => { const collapsed = box.classList.toggle('collapsed'); toggle.textContent = collapsed ? '+' : '−'; toggle.setAttribute('aria-label', collapsed ? '展开监考面板' : '收起监考面板'); placePanel(); };
  heading.append(brand, badge, toggle); heading.title = '拖动标题移动监考面板';
  const body = document.createElement('div'); body.className = 'body';
  const status = document.createElement('div');
  status.className = 'status';
  const meta = document.createElement('div'); meta.className = 'meta';
  const waiting = document.createElement('div'); waiting.className = 'waiting'; waiting.hidden = true;
  const waitingTitle = document.createElement('div'); waitingTitle.className = 'waiting-title'; waitingTitle.setAttribute('aria-live', 'polite');
  const spinner = document.createElement('span'); spinner.className = 'spinner'; spinner.setAttribute('aria-hidden', 'true');
  const waitingLabel = document.createElement('span'); waitingTitle.append(spinner, waitingLabel);
  const waitingTime = document.createElement('div'); waitingTime.className = 'waiting-time';
  waiting.append(waitingTitle, waitingTime);
  let activity, activityReceivedAt = performance.now();
  function receiveActivity(value) { activity = value; activityReceivedAt = performance.now(); renderActivity(); }
  function renderActivity() {
    if (!activity) { waiting.hidden = true; return; }
    const elapsedMs = (activity.elapsedMs || 0) + performance.now() - activityReceivedAt;
    // Cached authentication normally finishes before the indicator is needed.
    waiting.hidden = activity.busy && elapsedMs < 250;
    waiting.dataset.busy = String(!!activity.busy);
    waiting.dataset.delayed = String(activity.busy && elapsedMs > activity.estimatedMaxMs);
    waitingLabel.textContent = activity.label;
    waitingTime.textContent = activity.busy
      ? `已等待 ${Math.floor(elapsedMs / 1000)} 秒 · ${elapsedMs > activity.estimatedMaxMs ? '已超出参考耗时，仍在等待响应' : `预计 ${Math.ceil(activity.estimatedMinMs / 1000)}–${Math.ceil(activity.estimatedMaxMs / 1000)} 秒（参考）`}`
      : '请查看错误提示，检查连接后重试。';
    waiting.title = activity.hint || '';
  }
  ipcRenderer.on('exam:activity-status', (_, value) => receiveActivity(value));
  const message = document.createElement('div'); message.className = 'message';
  const actions = document.createElement('div'); actions.className = 'actions';
  const end = document.createElement('button');
  end.className = 'end';
  end.textContent = '退出 / 结束监考';
  const pendingActions = new Set();
  let panelStatus = {};
  const action = async (channel, button) => {
    if (pendingActions.has(button)) return;
    pendingActions.add(button); button.disabled = true; button.dataset.busy = 'true';
    try { await ipcRenderer.invoke(channel); await update(); } catch (error) { message.textContent = String(error.message || '操作未完成，请重试。').slice(0, 500); }
    finally { pendingActions.delete(button); updateButtons(); }
  };
  end.onclick = () => action('exam:request-quit', end);
  const debug = document.createElement('button');
  debug.textContent = '调试控制台'; debug.hidden = true;
  debug.onclick = () => action('exam:debug', debug);
  const retry = document.createElement('button'); retry.textContent = '补传日志'; retry.hidden = true;
  retry.onclick = () => action('exam:retry', retry);
  const version = document.createElement('div'); version.className = 'version';
  const updateWarning = document.createElement('div'); updateWarning.className = 'update-warning'; updateWarning.hidden = true;
  const updateActions = document.createElement('div'); updateActions.className = 'updates';
  const check = document.createElement('button'); check.textContent = '检查更新'; check.onclick = () => action('exam:update-check', check);
  const install = document.createElement('button'); install.textContent = '更新并重启'; install.hidden = true; install.onclick = () => action('exam:update-install', install);
  const download = document.createElement('button'); download.textContent = '下载安装包'; download.hidden = true; download.onclick = () => action('exam:update-download', download);
  updateActions.append(check, install, download);
  actions.append(retry, debug, end); body.append(status, meta, message, version, updateWarning, updateActions, actions); box.append(heading, waiting, body); shadow.append(style, box); document.documentElement.append(host);
  let position, dragging;
  try { const saved = JSON.parse(localStorage.getItem('hydro-proctor-panel-position'));
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) position = saved;
  } catch { /* Position storage may be disabled by the page. */ }
  const clamp = (value, max) => Math.max(0, Math.min(value, Math.max(0, max)));
  function placePanel() {
    if (!position) return;
    const rect = host.getBoundingClientRect();
    host.style.right = 'auto'; host.style.bottom = 'auto';
    host.style.left = `${clamp(position.x * (window.innerWidth - rect.width), window.innerWidth - rect.width)}px`;
    host.style.top = `${clamp(position.y * (window.innerHeight - rect.height), window.innerHeight - rect.height)}px`;
  }
  heading.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('button')) return;
    const rect = host.getBoundingClientRect();
    dragging = { id: event.pointerId, x: event.clientX - rect.left, y: event.clientY - rect.top };
    heading.setPointerCapture(event.pointerId); event.preventDefault();
  });
  heading.addEventListener('pointermove', (event) => {
    if (!dragging || dragging.id !== event.pointerId) return;
    const rect = host.getBoundingClientRect();
    const width = Math.max(0, window.innerWidth - rect.width), height = Math.max(0, window.innerHeight - rect.height);
    position = { x: width ? clamp(event.clientX - dragging.x, width) / width : 0,
      y: height ? clamp(event.clientY - dragging.y, height) / height : 0 };
    placePanel();
  });
  const stopDrag = () => { if (!dragging) return; dragging = null;
    if (position) try { localStorage.setItem('hydro-proctor-panel-position', JSON.stringify(position)); } catch {} };
  heading.addEventListener('pointerup', stopDrag); heading.addEventListener('pointercancel', stopDrag); heading.addEventListener('lostpointercapture', stopDrag);
  window.addEventListener('resize', placePanel); placePanel();
  function updateButtons() {
    const data = panelStatus, info = data.update || {};
    const busy = ['checking', 'downloading', 'verifying'].includes(info.phase);
    const setState = (button, disabled, waiting = false) => {
      button.disabled = !!disabled || pendingActions.has(button);
      button.dataset.busy = String(waiting || pendingActions.has(button));
    };
    check.hidden = !info.enabled; setState(check, busy, busy);
    install.hidden = !info.canHotUpdate; setState(install, busy || info.blocked || data.finishing, busy);
    install.title = info.blocked ? info.blockedReason || '请先上传日志并结束所有监考' : '下载签名 ASAR，验证后重启';
    download.hidden = !info.installerUrl; setState(download, busy, busy);
    setState(end, data.finishing, !!data.finishing);
    setState(debug, false); setState(retry, false);
    debug.hidden = !(data.root && data.allowRootDebug); retry.hidden = !data.pendingUploads;
  }
  async function update() {
    try {
      const data = await ipcRenderer.invoke('exam:status');
      panelStatus = data;
      receiveActivity(data.activity);
      badge.dataset.state = data.debug ? 'debug' : data.authenticated ? 'connected' : 'pending';
      badge.textContent = data.debug ? '管理员' : data.ended ? '已结束' : data.authenticated ? '已认证' : '待验证';
      status.textContent = data.debug ? '管理员调试模式' : data.ended ? '本场监考已结束' : data.authenticated ? '监考进行中' : '等待比赛认证';
      const elapsed = data.createdAt ? `已监考 ${Math.max(0, Math.floor((Date.now() - Date.parse(data.createdAt)) / 60000))} 分钟` : '登录后进入比赛，自动验证客户端';
      meta.textContent = `${elapsed}${data.pendingUploads ? ` · 待补传 ${data.pendingUploads} 份` : ''}`;
      message.textContent = data.upload && ['uploading', 'verifying'].includes(data.upload.phase)
        ? `日志${data.upload.phase === 'verifying' ? '等待服务端确认' : '上传中'}${Number.isFinite(data.upload.percent) ? ` · ${data.upload.percent}%` : ''}`
        : data.message || (data.authenticated ? '结束监考时请完成日志上传。' : '请登录并进入比赛，客户端将自动验证。');
      const info = data.update || {};
      version.textContent = `版本 ${info.version || '未知'} · 构建 ${info.buildVersion || '未配置'}${info.source === 'asar' ? ' · ASAR' : ''}\n${info.message || '更新功能未启用'}${info.phase === 'downloading' ? ` · ${info.percent || 0}%` : ''}${info.rollback ? `\n${info.rollback}` : ''}`;
      updateWarning.hidden = !info.canHotUpdate || !info.blocked;
      updateWarning.textContent = info.blockedReason || '请先上传日志并结束所有监考，再更新客户端。';
      updateButtons(); placePanel();
    } catch { status.textContent = '请返回考试系统查看监考状态'; }
  }
  update(); setInterval(update, 5000); setInterval(renderActivity, 1000);
});
