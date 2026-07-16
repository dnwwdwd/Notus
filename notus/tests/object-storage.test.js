const assert = require('assert');
const {
  normalizeObjectStorageConfig,
  normalizePrefix,
  buildObjectKey,
  buildPublicUrl,
} = require('../lib/objectStorage');

function runTests() {
  const cos = normalizeObjectStorageConfig({
    provider: 'cos',
    bucket: 'notus-1250000000',
    region: 'ap-guangzhou',
    prefix: '/notus/images/',
    publicBaseUrl: 'https://images.example.com/',
    accessKeyId: 'id',
    secretAccessKey: 'secret',
  });
  assert.strictEqual(cos.prefix, 'notus/images');
  assert.strictEqual(cos.publicBaseUrl, 'https://images.example.com');

  const r2 = normalizeObjectStorageConfig({
    provider: 'r2',
    bucket: 'notus-images',
    endpoint: 'https://account.r2.cloudflarestorage.com/',
    prefix: 'notus/images',
    publicBaseUrl: 'https://cdn.example.com/notus',
    accessKeyId: 'id',
    secretAccessKey: 'secret',
  });
  assert.strictEqual(r2.endpoint, 'https://account.r2.cloudflarestorage.com');

  const key = buildObjectKey({
    buffer: Buffer.from('image-content'),
    mimeType: 'image/png',
    originalName: 'clipboard.png',
    prefix: 'notus/images',
    now: new Date(Date.UTC(2026, 6, 11)),
  });
  assert.strictEqual(key, 'notus/images/2026/07/d2dfc251c1a7245d4eb7d95e5f815472c6dbcf7ee6690bbd7c1912f477b6c22a.png');
  assert.strictEqual(buildPublicUrl('https://cdn.example.com/notus/', key), `https://cdn.example.com/notus/${key}`);
  assert.throws(() => normalizePrefix('../images'), /对象前缀/);
  assert.throws(() => normalizeObjectStorageConfig({ provider: 'r2', bucket: 'bucket', publicBaseUrl: 'https://cdn.example.com', accessKeyId: 'id', secretAccessKey: 'secret' }), /Endpoint/);
  assert.throws(() => normalizeObjectStorageConfig({ provider: 'cos', bucket: 'bucket', region: 'ap-guangzhou', publicBaseUrl: 'https://cdn.example.com?temporary=true', accessKeyId: 'id', secretAccessKey: 'secret' }), /公开访问基础 URL/);

  console.log('object storage tests passed');
}

runTests();
