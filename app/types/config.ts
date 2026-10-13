/** 编译时信任边界；远端配置不能更换密钥、白名单或调试权限。 */
export interface BuildIdentity {
  productName?: string;
  version: string;
  buildVersion: string;
  nativeNetworkVersion?: number;
}

export interface Trust {
  keyId: string;
  authPublicKey: string;
  logPublicKey: string;
  updatePublicKey?: string;
  allowedOrigins: string[];
  updateOrigins?: string[];
}

export interface ClientConfig {
  exam: { targetUrl: string; title?: string; allowedOrigins: string[]; allowedDomains?: string[] };
  updater: {
    enabled?: boolean;
    checkOnStartup?: boolean;
    timeoutMs?: number;
    versionUrl?: string;
    fallbackVersionUrl?: string;
    allowedOrigins?: string[];
    signingPublicKey?: string;
  };
  debug?: { allowRoot: boolean };
  window?: {
    kiosk?: boolean;
    alwaysOnTop?: boolean;
    preventMinimize?: boolean;
    disableDevTools?: boolean;
    width?: number;
    height?: number;
  };
  antiCheat?: {
    blockShortcuts?: string[];
    processBlacklist?: string[];
    processBlacklistByPlatform?: Record<string, string[]>;
    checkProcessIntervalMs?: number;
    singleScreenOnly?: boolean;
    terminateBlacklisted?: boolean;
  };
  globalFirewallLock?: { enabled: boolean };
  trust?: Trust;
}
