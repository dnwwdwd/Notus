function mediaIdentityKeys(item = {}) {
  const keys = [];
  const id = String(item?.id || '').trim();
  if (id) keys.push(`id:${id}`);
  const storedName = String(item?.stored_name || item?.storedName || '').trim();
  if (storedName) keys.push(`stored:${storedName}`);
  return keys;
}

function isImageMedia(item = {}) {
  const name = String(item?.name || item?.file_name || item?.filename || '').toLowerCase();
  const type = String(item?.type || item?.contentType || '').split(';')[0].trim().toLowerCase();
  return item?.media_kind === 'image' || item?.source_kind === 'image' || type.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/.test(name);
}

function mergeAgentMedia({ attachments = [], mediaItems = [], images = [] } = {}) {
  const items = [];
  const indexes = new Map();
  let sequence = 0;

  const append = (item) => {
    if (!item || typeof item !== 'object') return;
    const identityKeys = mediaIdentityKeys(item);
    const existingIndex = identityKeys.map((key) => indexes.get(key)).find((index) => index !== undefined);
    if (existingIndex !== undefined) {
      const index = existingIndex;
      items[index].item = { ...items[index].item, ...item };
      mediaIdentityKeys(items[index].item).forEach((key) => indexes.set(key, index));
      return;
    }
    identityKeys.forEach((key) => indexes.set(key, items.length));
    items.push({ item: { ...item }, sequence: sequence++ });
  };

  (Array.isArray(mediaItems) ? mediaItems : []).forEach(append);
  (Array.isArray(attachments) ? attachments : []).forEach(append);
  (Array.isArray(images) ? images : []).forEach(append);

  const ordered = items.sort((left, right) => {
    const leftOrder = Number(left.item?.upload_order);
    const rightOrder = Number(right.item?.upload_order);
    const leftHasOrder = Number.isFinite(leftOrder);
    const rightHasOrder = Number.isFinite(rightOrder);
    if (leftHasOrder && rightHasOrder && leftOrder !== rightOrder) return leftOrder - rightOrder;
    if (leftHasOrder !== rightHasOrder) return leftHasOrder ? -1 : 1;
    return left.sequence - right.sequence;
  }).map(({ item }) => item);

  return {
    attachments: ordered.filter((item) => !isImageMedia(item)),
    images: ordered.filter(isImageMedia),
  };
}

module.exports = { mergeAgentMedia };
