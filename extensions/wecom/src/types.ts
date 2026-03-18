/**
 * 文件功能：定义 wecom 通道插件的配置类型与回调事件类型。
 * 主要类/函数：WecomChannelConfig/ResolvedWecomAccount 描述配置；WecomInboundEvent 描述入站消息。
 * 关键依赖或环境变量：WECOM_CORP_ID、WECOM_AGENT_ID、WECOM_SECRET、WECOM_TOKEN、WECOM_AES_KEY。
 */

export type WecomDmPolicy = "open" | "allowlist" | "disabled";

export interface WecomAccountRaw {
  enabled?: boolean;
  name?: string;
  corpId?: string;
  agentId?: string;
  secret?: string;
  token?: string;
  aesKey?: string;
  webhookPath?: string;
  proxyUrl?: string;
  messageToUser?: string;
  dmPolicy?: WecomDmPolicy;
  allowFrom?: string | string[];
  /** 豆包语音识别：火山引擎 AppID */
  doubaoAsrAppId?: string;
  /** 豆包语音识别：API Token */
  doubaoAsrToken?: string;
  /** 豆包语音识别：资源 ID，v3 默认 volc.seedasr.sauc.duration */
  doubaoAsrResourceId?: string;
  /** 兼容旧版 v1 接口配置；未设置 resourceId 时可回退读取 */
  doubaoAsrCluster?: string;
}

export interface WecomChannelConfig extends WecomAccountRaw {
  defaultAccount?: string;
  accounts?: Record<string, WecomAccountRaw>;
}

export interface ResolvedWecomAccount {
  accountId: string;
  enabled: boolean;
  name?: string;
  configured: boolean;
  corpId: string;
  agentId: string;
  secret: string;
  token: string;
  aesKey: string;
  webhookPath: string;
  proxyUrl: string;
  messageToUser: string;
  dmPolicy: WecomDmPolicy;
  allowFrom: string[];
  /** 豆包语音识别 AppID，为空时不支持语音 */
  doubaoAsrAppId: string;
  /** 豆包语音识别 Token */
  doubaoAsrToken: string;
  /** 豆包语音识别资源 ID */
  doubaoAsrResourceId: string;
  /** 兼容旧版 v1 接口配置 */
  doubaoAsrCluster: string;
}

export type WecomInboundMsgType = "text" | "image" | "voice";

export interface WecomInboundEvent {
  msgType: WecomInboundMsgType;
  fromUser: string;
  toUser: string;
  msgId?: string;
  createTime?: string;
  content?: string;
  mediaId?: string;
  picUrl?: string;
  /** 语音消息格式，通常为 amr 或 speex */
  format?: string;
}

export interface WecomDownloadedMedia {
  fileName: string;
  contentType: string;
  contentBytes: Buffer;
}
