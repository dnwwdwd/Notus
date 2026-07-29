function getAgentImagePreviewUrl(file = {}) {
  const confirmedUrl = String(file?.preview_url || '').trim();
  if (confirmedUrl) return confirmedUrl;

  const conversationId = Number(file?.conversation_id || file?.conversationId || 0);
  const storedName = String(file?.stored_name || file?.storedName || '').trim();
  if (storedName && Number.isInteger(conversationId) && conversationId > 0) {
    return `/api/agent/images/${encodeURIComponent(storedName)}?conversation_id=${encodeURIComponent(conversationId)}`;
  }

  // 仅在图片尚未落库前使用浏览器临时对象 URL；session_created 后必须优先使用
  // 服务端回传的受控 URL，避免队列清理时 revokeObjectURL 让历史缩略图失效。
  return String(file?.previewUrl || '').trim();
}

module.exports = {
  getAgentImagePreviewUrl,
};
