/**
 * 文件功能：企业微信回复文本清洗，统一把 Markdown 降级成适合人读的纯文本。
 * 主要类/函数：
 * - shouldKeepLinksByUserIntent：判断用户是否明确要求保留链接/来源。
 * - sanitizeWecomReplyText：先剥离来源尾注，再做预处理，最后转成可读文本。
 * 关键依赖或环境变量：无。
 */

const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/giu;
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/giu;
const FENCED_CODE_RE = /```[a-z0-9_-]*\n?([\s\S]*?)```/giu;
const INLINE_CODE_RE = /`([^`\n]+)`/gu;
const HEADING_RE = /^\s{0,3}#{1,6}\s+/gmu;
const BLOCKQUOTE_RE = /^\s{0,3}>\s?/gmu;
const UNORDERED_LIST_RE = /^\s*[-*+]\s+/gmu;
const TASK_LIST_RE = /^\s*[-*+]\s+\[( |x)\]\s+/gimu;
const STRONG_EM_RE = /(\*\*|__)(.*?)\1/gu;
const EMPHASIS_RE = /(^|[\s(（【])([*_])([^*_]+)\2(?=[\s).,，。！？；：）】]|$)/gu;
const STRIKETHROUGH_RE = /~~(.*?)~~/gu;
const ANGLE_BRACKET_URL_RE = /<\s*(https?:\/\/[^>\s]+)\s*>/giu;
const URL_RE = /https?:\/\/[^\s<>\])）】]+/giu;
const SOURCE_FOOTER_MARKER_RE =
  /^(我用到的)?(来源|出处|原文地址|原文|参考(资料|链接|网址|来源)?|sources?|references?|citations?)$/iu;

const KEEP_LINK_KEYWORDS = [
  "链接",
  "来源",
  "网址",
  "url",
  "source",
  "reference",
  "参考资料",
  "原文",
  "出处",
];

const DEFAULT_WECOM_TEXT_MAX_CHARS = 500;

export function shouldKeepLinksByUserIntent(userText: string): boolean {
  const normalized = (userText ?? "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return KEEP_LINK_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

function stripDecoration(text: string): string {
  return text
    .replace(/^[\s\-*•>#:：|【】\[\]()（）.、]+/u, "")
    .replace(/[\s\-*•#:：|【】\[\]()（）.、]+$/u, "");
}

function classifyCitationFooterLine(line: string): {
  blank: boolean;
  citationLike: boolean;
  marker: boolean;
  urlLike: boolean;
} {
  const trimmed = line.trim();
  if (!trimmed) {
    return { blank: true, citationLike: false, marker: false, urlLike: false };
  }

  const urlLike = ANGLE_BRACKET_URL_RE.test(trimmed) || URL_RE.test(trimmed);
  const withoutUrls = stripDecoration(
    trimmed.replace(ANGLE_BRACKET_URL_RE, "").replace(URL_RE, "").trim(),
  );
  const marker = SOURCE_FOOTER_MARKER_RE.test(withoutUrls);
  const shortCitationTail =
    urlLike && withoutUrls.length <= 32 && !/[。！？.!?]/u.test(withoutUrls);

  return {
    blank: false,
    citationLike: marker || shortCitationTail || (urlLike && withoutUrls.length === 0),
    marker,
    urlLike,
  };
}

function stripTrailingCitationFooter(text: string): string {
  const lines = text.split(/\r?\n/gu);
  let start = lines.length;
  let sawMarker = false;
  let urlLikeCount = 0;
  let inCandidate = false;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    const info = classifyCitationFooterLine(line);
    if (info.blank) {
      if (inCandidate) {
        start = index;
      }
      continue;
    }
    if (!info.citationLike) {
      break;
    }
    inCandidate = true;
    start = index;
    sawMarker ||= info.marker;
    if (info.urlLike) {
      urlLikeCount += 1;
    }
  }

  if (!inCandidate) {
    return text;
  }
  if (!sawMarker && urlLikeCount < 2) {
    return text;
  }

  return lines.slice(0, start).join("\n").trimEnd();
}

function normalizeForSanitizing(text: string): string {
  return (text ?? "").replace(/\r\n?/gu, "\n").trim();
}

function renderMarkdownAsReadableText(text: string, keepLinks: boolean): string {
  let cleaned = text.replace(FENCED_CODE_RE, (_match, code: string) => `\n${code.trim()}\n`);
  cleaned = cleaned.replace(MARKDOWN_IMAGE_RE, (_match, alt: string, url: string) => {
    const label = alt.trim() || "image";
    return keepLinks ? `${label}: ${url}` : label;
  });
  cleaned = cleaned.replace(MARKDOWN_LINK_RE, (_match, label: string, url: string) => {
    const trimmedLabel = label.trim();
    if (!trimmedLabel) {
      return keepLinks ? url : "";
    }
    return keepLinks ? `${trimmedLabel}: ${url}` : trimmedLabel;
  });
  cleaned = cleaned.replace(INLINE_CODE_RE, "$1");
  cleaned = cleaned.replace(HEADING_RE, "");
  cleaned = cleaned.replace(BLOCKQUOTE_RE, "");
  cleaned = cleaned.replace(TASK_LIST_RE, "- ");
  cleaned = cleaned.replace(UNORDERED_LIST_RE, "- ");
  cleaned = cleaned.replace(STRONG_EM_RE, "$2");
  cleaned = cleaned.replace(STRIKETHROUGH_RE, "$1");
  cleaned = cleaned.replace(EMPHASIS_RE, "$1$3");
  return cleaned;
}

function normalizeReadableWhitespace(text: string): string {
  return text
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n[ \t]+/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

export function sanitizeWecomReplyText(text: string, keepLinks: boolean): string {
  const raw = text ?? "";
  if (!raw.trim()) {
    return "";
  }

  // 先在原始文本上剥离来源尾注，避免 Markdown 降级时丢失来源块结构。
  let cleaned = keepLinks ? raw : stripTrailingCitationFooter(raw);
  cleaned = normalizeForSanitizing(cleaned);
  cleaned = renderMarkdownAsReadableText(cleaned, keepLinks);
  if (!keepLinks) {
    cleaned = cleaned.replace(ANGLE_BRACKET_URL_RE, "");
    cleaned = cleaned.replace(URL_RE, "");
  }
  return normalizeReadableWhitespace(cleaned);
}

export function splitWecomTextByChars(
  text: string,
  maxChars = DEFAULT_WECOM_TEXT_MAX_CHARS,
): string[] {
  const raw = (text ?? "").trim();
  if (!raw) {
    return [];
  }
  const safeMaxChars = Math.max(1, Math.floor(maxChars));
  const parts: string[] = [];
  let current = "";
  let currentChars = 0;

  // 按 Unicode 字符计数分片，确保每片不超过 maxChars。
  for (const char of raw) {
    current += char;
    currentChars += 1;
    if (currentChars >= safeMaxChars) {
      parts.push(current);
      current = "";
      currentChars = 0;
    }
  }

  if (current) {
    parts.push(current);
  }
  return parts;
}
