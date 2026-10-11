const stages = {
  identity: ['正在验证登录身份', 1000, 10000],
  challenge: ['正在验证客户端身份与版本', 1000, 10000],
  handshake: ['正在完成安全握手', 1000, 10000],
  refresh: ['正在刷新认证令牌', 1000, 10000],
  lock: ['正在启用系统网络过滤', 1000, 10000],
  restore: ['正在解除系统网络过滤', 500, 5000],
  'resolve-destinations': ['正在解析允许访问的服务器地址', 1000, 10000],
  'apply-native-policy': ['正在应用临时网络白名单', 1000, 10000],
  'verify-oj-connectivity': ['正在确认网络限制下可以连接 OJ', 500, 5000],
  'remove-native-policy': ['正在移除临时网络限制', 500, 5000],
  'restore-outbound-policy': ['正在恢复原有网络访问策略', 3000, 20000],
  'restore-original-rules': ['正在恢复原有防火墙规则', 3000, 20000],
  'remove-exam-rules': ['正在移除考试网络限制', 3000, 20000],
  'boot-identity': ['正在检查系统重启状态', 1000, 5000],
  'load-exam': ['正在打开考试页面', 1000, 10000],
  pause: ['正在保留日志并等待已发出的请求完成', 1000, 10000],
};

class ActivityProgress {
  constructor({ onChange = () => {}, now = () => performance.now() } = {}) {
    this.onChange = onChange; this.now = now;
    this.tasks = new Map(); this.sequence = 0; this.failure = null;
  }
  snapshot() {
    // Network setup/recovery explains an authentication wait more precisely.
    const tasks = [...this.tasks.values()];
    const task = tasks.findLast((item) => item.kind === 'network') || tasks.at(-1);
    if (!task) return this.failure && this.now() - this.failure.finishedAt < 8000 ? { ...this.failure, busy: false } : null;
    const [label, minMs, maxMs] = stages[task.stage] || stages.identity;
    const elapsedMs = Math.max(0, this.now() - task.startedAt);
    return { kind: task.kind, stage: task.stage, label, busy: true, elapsedMs, estimatedMinMs: minMs, estimatedMaxMs: maxMs,
      delayed: elapsedMs > maxMs,
      hint: task.kind === 'network' ? '正在等待 Windows 网络组件响应；参考耗时以本机实际情况为准。'
        : task.kind === 'startup' ? '正在检查本机环境或打开考试页面，完成后会自动进入。'
          : task.kind === 'exit' ? '正在保留日志并等待已发出的请求完成；下次可登录原考试账号继续。'
            : '实际耗时取决于网络和服务端响应；耗时超出参考范围时仍会等待请求结果。' };
  }
  changed() { this.onChange(this.snapshot()); }
  stage(kind, stage) {
    if (!stages[stage]) return;
    const task = [...this.tasks.values()].findLast((item) => item.kind === kind);
    if (task && task.stage !== stage) { task.stage = stage; this.changed(); }
  }
  async run(kind, stage, action) {
    const id = ++this.sequence;
    this.failure = null; this.tasks.set(id, { kind, stage, startedAt: this.now() }); this.changed();
    try { return await action(); }
    catch (error) {
      this.failure = { kind, stage, label: kind === 'network' ? '网络设置未完成，请查看错误提示' : '认证或准备未完成，请查看错误提示', finishedAt: this.now() };
      throw error;
    } finally { this.tasks.delete(id); this.changed(); }
  }
}
module.exports = ActivityProgress;
