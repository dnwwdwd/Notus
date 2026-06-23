export const TOOL_DISPLAY = {
  search_knowledge: '检索知识库',
  read_file: '读取文件',
  create_note: '新建笔记',
  preview_patch_files: '生成修改预览',
  analyze_folder: '分析目录',
  check_links: '检查链接',
};

export function getAgentToolLabel(name = '') {
  return TOOL_DISPLAY[name] || name || '模型回复';
}

export function getAgentLoopReasonLabel(reason = '') {
  const map = {
    goal_achieved: '任务已完成',
    hard_limit_reached: '已达到本次执行轮次上限，可选择继续执行',
    consecutive_tool_failure: '同一工具连续失败，任务已停止',
    deadloop_detected: '检测到重复执行，任务已停止',
    no_progress: '连续未取得有效进展，任务已停止',
    waiting_preview_confirm: '已生成修改预览，等待确认',
    cancelled: '任务已取消',
  };
  return map[reason] || reason || '任务已结束';
}

export function getAgentToolResultSummary(result = null) {
  if (!result || typeof result !== 'object') return '无结果摘要';
  if (result.error) return `${result.error}${result.message ? `：${result.message}` : ''}`;
  if (result.result_count !== undefined) return `命中 ${result.result_count} 条结果`;
  if (result.file_path) return `${result.file_path}${result.char_count ? `，${result.char_count} 字` : ''}`;
  if (result.path) return `${result.created ? '已创建' : '文件'}：${result.path}`;
  if (result.operation_set_id) return `修改预览 #${result.operation_set_id}，${result.patch_count || 0} 个文件`;
  if (result.file_count !== undefined) return `分析 ${result.file_count} 个文件${result.truncated ? '，已截断' : ''}`;
  if (result.orphan_count !== undefined || result.broken_count !== undefined) {
    return `孤立链接 ${result.orphan_count || 0} 个，失效链接 ${result.broken_count || 0} 个`;
  }
  return '工具调用已完成';
}
