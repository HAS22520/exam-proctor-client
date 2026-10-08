const { contextBridge, ipcRenderer } = require('electron');

// 暴露 API
contextBridge.exposeInMainWorld('examAPI', {
  ping: () => 'pong',
  requestQuit: () => ipcRenderer.invoke('exam:request-quit')
});

// 在页面挂载监考悬浮工具栏 (包含录屏中指示、考试用时、正常交卷退出按钮)
function initProctorToolbar() {
  if (document.getElementById('exam-proctor-container')) return;

  const container = document.createElement('div');
  container.id = 'exam-proctor-container';

  // 使用 Shadow DOM 隔离页面自身 CSS 样式
  const shadow = container.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <style>
      .proctor-pill {
        position: fixed;
        top: 14px;
        right: 20px;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 6px 14px 6px 14px;
        background: rgba(23, 23, 28, 0.94);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 9999px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35), 0 2px 6px rgba(0, 0, 0, 0.2);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        user-select: none;
        -webkit-user-select: none;
        transition: all 0.2s ease;
      }
      .proctor-pill:hover {
        background: rgba(28, 28, 35, 0.98);
        border-color: rgba(255, 255, 255, 0.25);
      }
      .badge-status {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        font-weight: 500;
        color: #e2e8f0;
        letter-spacing: 0.3px;
      }
      .recording-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #ef4444;
        box-shadow: 0 0 10px #ef4444;
        animation: pulse 1.6s infinite ease-in-out;
      }
      @keyframes pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.3; transform: scale(0.8); }
      }
      .timer-badge {
        font-size: 13px;
        font-family: monospace, ui-monospace, Consolas, "Courier New";
        font-weight: 600;
        color: #38bdf8;
        background: rgba(56, 189, 248, 0.1);
        border: 1px solid rgba(56, 189, 248, 0.2);
        padding: 3px 8px;
        border-radius: 6px;
      }
      .divider {
        width: 1px;
        height: 18px;
        background: rgba(255, 255, 255, 0.18);
      }
      .btn-quit {
        border: none;
        outline: none;
        background: linear-gradient(135deg, #e11d48, #be123c);
        color: #ffffff;
        padding: 6px 16px;
        font-size: 13px;
        font-weight: 600;
        border-radius: 9999px;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 6px;
        box-shadow: 0 2px 8px rgba(225, 29, 72, 0.4);
        transition: all 0.15s ease;
      }
      .btn-quit:hover {
        background: linear-gradient(135deg, #f43f5e, #e11d48);
        box-shadow: 0 4px 14px rgba(225, 29, 72, 0.6);
        transform: translateY(-1px);
      }
      .btn-quit:active {
        transform: translateY(1px);
        box-shadow: 0 1px 4px rgba(225, 29, 72, 0.3);
      }
    </style>
    <div class="proctor-pill">
      <div class="badge-status">
        <div class="recording-dot"></div>
        <span>监考录像中</span>
      </div>
      <div class="timer-badge" id="exam-timer">00:00:00</div>
      <div class="divider"></div>
      <button class="btn-quit" id="btn-exit-exam" title="交卷并退出监考系统">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
          <polyline points="16 17 21 12 16 7"></polyline>
          <line x1="21" y1="12" x2="9" y2="12"></line>
        </svg>
        <span>交卷退出</span>
      </button>
    </div>
  `;

  // 挂载到根节点
  (document.documentElement || document.body).appendChild(container);

  // 绑定退出按钮
  const quitBtn = shadow.getElementById('btn-exit-exam');
  if (quitBtn) {
    quitBtn.addEventListener('click', () => {
      ipcRenderer.invoke('exam:request-quit');
    });
  }

  // 计时器
  const startTime = Date.now();
  const timerElem = shadow.getElementById('exam-timer');
  setInterval(() => {
    if (!timerElem) return;
    const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
    const h = String(Math.floor(elapsedSec / 3600)).padStart(2, '0');
    const m = String(Math.floor((elapsedSec % 3600) / 60)).padStart(2, '0');
    const s = String(elapsedSec % 60).padStart(2, '0');
    timerElem.textContent = `${h}:${m}:${s}`;
  }, 1000);
}

// 确保 DOM 准备好后注入工具栏
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initProctorToolbar);
} else {
  initProctorToolbar();
}

// 针对 SPA 路由变化防抖保底
setInterval(initProctorToolbar, 2000);
