const { completeToolChat } = require('./llm');
const { getImageInputBlocks, makeConversationImageReference } = require('./conversationImages');
const { saveAttachment } = require('./parsedAttachmentStore');

const IMAGE_RECOGNITION_MAX_OUTPUT_TOKENS = 1400;

function readTextContent(content = []) {
  return (Array.isArray(content) ? content : [])
    .filter((block) => block?.type === 'text')
    .map((block) => String(block.text || '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function buildImageRecognitionSource(messageId, images = []) {
  const names = (Array.isArray(images) ? images : [])
    .map((image) => String(image?.name || '').trim())
    .filter(Boolean)
    .slice(0, 3);
  return `图片识别结果 #${Number(messageId) || 'unknown'} · ${names.join('、') || '未命名图片'}`;
}

async function recognizeConversationImages({ conversationId, messageId, images = [], llmConfig, signal = null } = {}) {
  const blocks = getImageInputBlocks(images, { messageId });
  if (blocks.length === 0) return null;
  const response = await completeToolChat({
    system: '你是图片识别器。只输出用户后续任务可直接引用的图片事实摘要。',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '请识别以下图片。按图片顺序输出简洁、可复用的中文事实摘要：主体、可读文字、界面状态、数据或需要注意的细节。看不清时明确写“无法辨认”，不要臆测、寒暄或提出建议。' },
        ...blocks.flatMap((image, index) => ([
          { type: 'text', text: `图片 ${index + 1}${image?.name ? `（${image.name}）` : ''}：` },
          image,
        ])),
      ],
    }],
    tools: [],
    llmConfig,
    taskType: 'agent_image_recognition',
    temperature: 0,
    maxOutputTokens: IMAGE_RECOGNITION_MAX_OUTPUT_TOKENS,
    signal,
  });
  const text = readTextContent(response.content);
  if (!text) {
    const error = new Error('图片识别模型没有返回可保存的文字结果');
    error.code = 'IMAGE_RECOGNITION_EMPTY';
    throw error;
  }
  const imageRefs = (Array.isArray(images) ? images : []).map((image) => (
    image?.image_ref || makeConversationImageReference(messageId, image?.id)
  )).filter(Boolean);
  const source = buildImageRecognitionSource(messageId, images);
  saveAttachment(conversationId, {
    source,
    type: 'image_recognition',
    status: 'success',
    text,
    metadata: {
      message_id: Number(messageId) || null,
      image_refs: imageRefs,
      image_names: (Array.isArray(images) ? images : []).map((image) => String(image?.name || '')).filter(Boolean),
    },
  });
  return { source, text, imageRefs, usage: response.usage || null };
}

module.exports = {
  buildImageRecognitionSource,
  recognizeConversationImages,
};
