import type { ClientError } from './contracts';

// 只使用服务端明确返回的拒绝原因；普通 403 不能当作确定的版本错误。
class ProctorError extends Error {
  declare status: number;
  declare code: string;
  declare publicMessage: string;

  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
    if (/^(?:Proctor )?(?:client )?version mismatch\.?$/i.test(message)) {
      this.code = 'PROCTOR_VERSION_MISMATCH';
      this.publicMessage = '客户端版本不符合系统要求，认证已被拒绝。请安装符合 OJ 要求的客户端后重试。';
    } else if (/^Proctor session expired or client version mismatch\.?$/i.test(message)) {
      this.code = 'PROCTOR_SESSION_REJECTED';
      this.publicMessage = '监考会话已过期或客户端版本不符合系统要求。请重新认证；若仍失败，请联系管理员确认所需版本。';
    } else if (status === 403 && /^(?:ForbiddenError|Proctor request rejected)$/.test(message)) {
      this.publicMessage =
        'OJ 拒绝了监考认证（HTTP 403），服务端未提供具体原因。请管理员检查客户端版本、比赛报名及访问权限。';
    } else if (message === 'Attend the contest before starting proctoring.') {
      this.code = 'PROCTOR_ATTEND_REQUIRED';
      this.publicMessage = '请先报名／参加当前比赛，再验证监考客户端。';
    }
  }
  get retryable() {
    return !this.status || this.status === 429 || this.status >= 500 || /in progress|retry/i.test(this.message);
  }
}

function proctorErrorMessage(error: ClientError, version?: string) {
  if (error.code === 'PROCTOR_VERSION_MISMATCH' && version) {
    return `客户端版本不符合系统要求（当前：${version}），认证已被拒绝。请安装符合 OJ 要求的客户端后重试。`;
  }
  if (error.publicMessage) return error.publicMessage;
  if (isNetworkError(error))
    return error.code === 'NETWORK_OJ_UNREACHABLE'
      ? error.message
      : '无法连接 OJ，当前认证尚未完成。请检查网络，关闭代理软件的系统代理／TUN／Fake-IP 模式后重试；监考日志已保留。';
  return '认证失败，请检查登录账号、客户端版本及认证密钥，或查看调试控制台中的具体原因。';
}

function isNetworkError(error: ClientError) {
  return (
    /^(?:NETWORK_|DNS_|FILTER_FAILED|HELPER_EXITED|ETIMEDOUT|ECONN|ENOTFOUND)/.test(error.code || '') ||
    ['TimeoutError', 'AbortError'].includes(error.name) ||
    /net::ERR_|fetch failed|Failed to fetch/i.test(error.message)
  );
}

function parseReply(raw: string, status: number, type: string) {
  if (status >= 300 && status < 400) throw new ProctorError('Login or redirect requires attention', status);
  if (!type.includes('application/json')) throw new ProctorError('Server did not return protocol JSON', status);
  if (raw.length > 1024 * 1024) throw new ProctorError('Protocol response too large', 400);
  const data = JSON.parse(raw);
  const serverError = data?.error;
  if (status < 200 || status >= 300 || serverError) {
    // Hydro puts the detailed reason in params; message may only be ForbiddenError.
    const param =
      Array.isArray(serverError?.params) &&
      serverError.params.find((value: unknown) => typeof value === 'string' && value.trim());
    const reason =
      param ||
      (typeof serverError === 'string'
        ? serverError
        : typeof serverError?.message === 'string' && serverError.message) ||
      'Proctor request rejected';
    throw new ProctorError(String(reason).trim().slice(0, 300), status);
  }
  return data;
}

export { ProctorError, proctorErrorMessage, isNetworkError, parseReply };
