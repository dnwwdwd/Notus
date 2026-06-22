export async function readSse(response, onEvent) {
  if (!response.body) throw new Error('接口没有返回可读取的流');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';
    events.forEach((event) => {
      const line = event.split('\n').find((item) => item.startsWith('data:'));
      if (!line) return;
      onEvent(JSON.parse(line.slice(5)));
    });
  }
  if (buffer.trim()) {
    const line = buffer.split('\n').find((item) => item.startsWith('data:'));
    if (line) onEvent(JSON.parse(line.slice(5)));
  }
}
