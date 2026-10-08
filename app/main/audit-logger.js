const fs = require('fs');
const path = require('path');

class AuditLogger {
  constructor(config) {
    this.outputDir = path.resolve(config.recording?.outputDir || './records');
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.startTime = new Date();
    this.logFilePath = path.join(this.outputDir, `exam_audit_${timestamp}.log`);
    this.jsonFilePath = path.join(this.outputDir, `exam_violations_${timestamp}.json`);
    this.violations = [];

    // 初始化日志文件头部
    const header = [
      '=================================================================',
      `  在线考试安全监考系统 - 非法访问与防作弊审计日志`,
      `  考试启动时间: ${this.formatDateTime(this.startTime)}`,
      `  仅放行白名单域名: ${JSON.stringify(config.exam?.allowedDomains || [])}`,
      '=================================================================\r\n\r\n'
    ].join('\r\n');

    fs.writeFileSync(this.logFilePath, header, 'utf-8');
    fs.writeFileSync(this.jsonFilePath, '[]', 'utf-8');
    console.log(`[AuditLogger] [INFO] 审计日志已初始化，存储路径: ${this.logFilePath}`);
  }

  formatDateTime(d = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
           `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  }

  /**
   * 记录违规/试图访问外网事件 (实时同步落盘)
   * @param {Object} item 
   * @param {string} item.source 来源 ('CLIENT' | 'SYSTEM_PROXY' | 'ANTI_CHEAT')
   * @param {string} item.type 类型代码
   * @param {string} item.target 试图访问的目标 URL 或域名
   * @param {string} item.detail 中文说明
   */
  logViolation({ source, type, target, detail }) {
    const now = new Date();
    const timeStr = this.formatDateTime(now);

    const record = {
      timestamp: now.toISOString(),
      timeFormatted: timeStr,
      source: source || 'UNKNOWN',
      type: type || 'BLOCKED_ACCESS',
      target: target || 'N/A',
      detail: detail || ''
    };

    this.violations.push(record);

    // 格式化单行纯文本日志并立即落盘，防止进程强退丢失
    const line = `[${timeStr}] [${record.source}] [${record.type}] 目标: ${record.target} | 说明: ${record.detail}\r\n`;
    try {
      fs.appendFileSync(this.logFilePath, line, 'utf-8');
      // 实时保存一份 JSON
      fs.writeFileSync(this.jsonFilePath, JSON.stringify(this.violations, null, 2), 'utf-8');
    } catch (err) {
      console.error('[AuditLogger] [ERROR] 写入审计日志失败:', err.message);
    }

    console.warn(`[AuditLogger] [AUDIT] 记录违规访问: [${record.source}] ${record.target} (${record.detail})`);
  }

  /**
   * 考试结束时生成完整的违规统计报告
   */
  finalize() {
    const endTime = new Date();
    const totalCount = this.violations.length;

    // 统计不同来源
    const clientCount = this.violations.filter(v => v.source === 'CLIENT').length;
    const systemCount = this.violations.filter(v => v.source === 'SYSTEM_PROXY').length;
    const antiCheatCount = this.violations.filter(v => v.source === 'ANTI_CHEAT').length;

    // 统计试图访问频次最高的外部域名
    const domainStats = {};
    for (const v of this.violations) {
      try {
        let domain = v.target;
        if (domain.startsWith('http://') || domain.startsWith('https://')) {
          domain = new URL(domain).hostname;
        } else {
          domain = domain.split(':')[0];
        }
        domainStats[domain] = (domainStats[domain] || 0) + 1;
      } catch (e) {
        domainStats[v.target] = (domainStats[v.target] || 0) + 1;
      }
    }

    const domainSummary = Object.entries(domainStats)
      .sort((a, b) => b[1] - a[1])
      .map(([domain, count]) => `    * ${domain}: 尝试访问 ${count} 次`)
      .join('\r\n');

    const summary = [
      '\r\n=================================================================',
      `  考试结束 - 违规访问审计统计汇总`,
      `  交卷时间: ${this.formatDateTime(endTime)}`,
      `  考试时长: ${Math.round((endTime - this.startTime) / 1000)} 秒`,
      `  总违规/受阻次数: ${totalCount} 次`,
      `    - 考试客户端内违规跳出/外链: ${clientCount} 次`,
      `    - 整机其他程序试图联网外链: ${systemCount} 次`,
      `    - 切屏失焦/黑名单进程报警: ${antiCheatCount} 次`,
      `  高频涉嫌外部域名排行:`,
      domainSummary || '    (无非法域名访问记录)',
      '=================================================================\r\n'
    ].join('\r\n');

    try {
      fs.appendFileSync(this.logFilePath, summary, 'utf-8');
      console.log(`[AuditLogger] [INFO] 审计报告汇总已写入: ${this.logFilePath}`);
    } catch (e) {}
  }
}

module.exports = AuditLogger;
