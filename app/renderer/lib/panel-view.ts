/* eslint style/indent: ['warn', 2], style/indent-binary-ops: ['warn', 2] -- 前端遵循两空格缩进，其余检查保持启用。 */
import type { ClientStatus } from '../../types/status';

export function panelView(data: ClientStatus) {
  const info = data.update || { phase: 'disabled' };
  const failed = ['network-error', 'authentication-error'].includes(data.phase || '');
  const authenticated = !!data.authenticated && !failed;
  return {
    badge: failed ? '失败' : authenticated ? '成功' : '待认证',
    state: failed ? 'failed' as const : authenticated ? 'success' as const : 'pending' as const,
    title: data.debug
      ? '管理员调试模式'
      : data.ended
        ? '本场监考已结束'
        : authenticated
          ? '监考进行中'
          : data.phase === 'network-error'
            ? '网络连接中断'
            : data.phase === 'authentication-error'
              ? '认证未完成'
              : '等待比赛认证',
    meta: [
      data.createdAt
        ? `已监考 ${Math.max(0, Math.floor((Date.now() - Date.parse(data.createdAt)) / 60000))} 分钟`
        : '登录后进入比赛，自动验证客户端',
      data.networkMode === 'macos-audit-only' ? 'macOS 仅记录日志，不限制系统网络' : '',
      data.pendingUploads ? `待补传 ${data.pendingUploads} 份` : '',
    ]
      .filter(Boolean)
      .join(' · '),
    message:
      data.upload && ['uploading', 'verifying'].includes(data.upload.phase)
        ? `日志${data.upload.phase === 'verifying' ? '等待服务端确认' : '上传中'}${Number.isFinite(data.upload.percent) ? ` · ${data.upload.percent}%` : ''}`
        : data.message || (authenticated ? '结束监考时请完成日志上传。' : '请登录并进入比赛，客户端将自动验证。'),
    version: [
      [`版本 ${info.version || '未知'}`, `构建 ${info.buildVersion || '未配置'}`, info.source === 'asar' ? 'ASAR' : '']
        .filter(Boolean)
        .join(' · '),
      [info.message || '更新功能未启用', info.phase === 'downloading' ? `${info.percent || 0}%` : ''].filter(Boolean).join(' · '),
      info.rollback || '',
    ]
      .filter(Boolean)
      .join('\n'),
    warning: [
      info.canHotUpdate && info.blocked ? info.blockedReason || '请先上传日志并结束所有监考，再更新客户端。' : '',
      info.installerWarning,
    ]
      .filter(Boolean)
      .join('\n'),
    busy: ['checking', 'downloading', 'verifying'].includes(info.phase),
    installBlocked: !!info.blocked || !!data.finishing,
    installTitle: info.blockedReason || (data.finishing ? '正在结束监考，请等待日志上传完成' : ''),
  };
}
