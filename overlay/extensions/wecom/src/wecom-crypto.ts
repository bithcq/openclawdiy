/**
 * 文件功能：企业微信回调签名校验与 AES 解密。
 * 主要类/函数：buildWecomSignature/verifyWecomSignature 负责签名；decryptWecomPayload 负责解密。
 * 关键依赖或环境变量：WECOM_TOKEN、WECOM_AES_KEY、WECOM_CORP_ID。
 */

import crypto from "node:crypto";

function decodeAesKey(aesKey: string): Buffer {
  const trimmed = aesKey.trim();
  if (!trimmed) {
    throw new Error("WECOM_AES_KEY is empty");
  }
  const key = Buffer.from(`${trimmed}=`, "base64");
  if (key.length !== 32) {
    throw new Error("WECOM_AES_KEY decoded length must be 32 bytes");
  }
  return key;
}

function pkcs7Unpad(payload: Buffer): Buffer {
  if (payload.length === 0) {
    throw new Error("decrypted payload is empty");
  }
  const pad = payload[payload.length - 1];
  if (!pad || pad < 1 || pad > 32) {
    throw new Error("invalid PKCS7 padding");
  }
  return payload.subarray(0, payload.length - pad);
}

export function buildWecomSignature(params: {
  token: string;
  timestamp: string;
  nonce: string;
  payload: string;
}): string {
  const { token, timestamp, nonce, payload } = params;
  const list = [token, timestamp, nonce, payload].sort();
  return crypto.createHash("sha1").update(list.join(""), "utf8").digest("hex");
}

export function verifyWecomSignature(params: {
  token: string;
  timestamp: string;
  nonce: string;
  payload: string;
  msgSignature: string;
}): boolean {
  const { token, timestamp, nonce, payload, msgSignature } = params;
  if (!token || !timestamp || !nonce || !payload || !msgSignature) {
    return false;
  }
  const expected = buildWecomSignature({ token, timestamp, nonce, payload });
  return expected === msgSignature;
}

export function decryptWecomPayload(params: {
  aesKey: string;
  encrypted: string;
  receiveId?: string;
}): string {
  const { aesKey, encrypted, receiveId } = params;
  const key = decodeAesKey(aesKey);
  const iv = key.subarray(0, 16);

  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  const encryptedBuffer = Buffer.from(encrypted, "base64");
  const decrypted = Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);
  const plain = pkcs7Unpad(decrypted);

  if (plain.length < 20) {
    throw new Error("decrypted payload length is invalid");
  }

  const xmlLength = plain.subarray(16, 20).readUInt32BE(0);
  const xmlEnd = 20 + xmlLength;
  if (xmlEnd > plain.length) {
    throw new Error("decrypted xml length is invalid");
  }

  const xmlText = plain.subarray(20, xmlEnd).toString("utf8");
  const actualReceiveId = plain.subarray(xmlEnd).toString("utf8");
  if (receiveId?.trim() && actualReceiveId !== receiveId) {
    throw new Error("receive_id mismatch");
  }
  return xmlText;
}
