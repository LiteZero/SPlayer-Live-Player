/** Only use hosts supplied by the authenticated API; 443 is the documented /sub fallback. */
export function connectionCandidates(nodes) {
  const candidates = [];
  const seen = new Set();
  for (const node of (Array.isArray(nodes) ? nodes : []).slice(0, 3)) {
    if (!node || typeof node.host !== "string" || !/^[a-z0-9.-]+\.chat\.bilibili\.com$/i.test(node.host) ||
      !Number.isInteger(node.wss_port) || node.wss_port < 1 || node.wss_port > 65535) continue;
    for (const port of [node.wss_port, 443]) {
      const key = `${node.host.toLowerCase()}:${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ host: node.host, wss_port: port });
    }
  }
  return candidates;
}

export function connectionError(error) {
  const descriptions = {
    ENOTFOUND: "DNS 无法解析节点", EAI_AGAIN: "DNS 查询暂时失败", ECONNREFUSED: "节点拒绝连接",
    ECONNRESET: "连接被重置", ETIMEDOUT: "网络连接超时", ENETUNREACH: "网络不可达", EHOSTUNREACH: "节点不可达",
    CERT_HAS_EXPIRED: "TLS 证书已过期", DEPTH_ZERO_SELF_SIGNED_CERT: "TLS 证书无法验证",
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: "TLS 证书无法验证", ERR_TLS_CERT_ALTNAME_INVALID: "TLS 证书域名不匹配",
  };
  if (Object.hasOwn(descriptions, error?.code)) return `${descriptions[error.code]}（${error.code}）`;
  if (/^Opening handshake has timed out$/.test(error?.message ?? "")) return "WSS 握手超时";
  return "WSS 连接失败";
}
