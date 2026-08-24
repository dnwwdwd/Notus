const assert = require('assert');
const {
  imageStorageProfileKey,
  isImageStorageProfileConfigured,
  readImageStorageProfile,
} = require('../lib/imageStorageProfiles');

function runTests() {
  const stored = {
    [imageStorageProfileKey('cos', 'bucket')]: 'cos-1250000000',
    [imageStorageProfileKey('cos', 'region')]: 'ap-guangzhou',
    [imageStorageProfileKey('cos', 'prefix')]: 'notus/images',
    [imageStorageProfileKey('cos', 'public_base_url')]: 'https://cos.example.com',
    [imageStorageProfileKey('cos', 'access_key_id')]: 'cos-id',
    [imageStorageProfileKey('cos', 'secret_access_key')]: 'cos-secret',
    [imageStorageProfileKey('oss', 'bucket')]: 'oss-images',
    [imageStorageProfileKey('oss', 'region')]: 'oss-cn-hangzhou',
    [imageStorageProfileKey('oss', 'public_base_url')]: 'https://oss.example.com',
    [imageStorageProfileKey('oss', 'access_key_id')]: 'oss-id',
    [imageStorageProfileKey('oss', 'secret_access_key')]: 'oss-secret',
  };

  const cos = readImageStorageProfile(stored, 'cos');
  const oss = readImageStorageProfile(stored, 'oss');
  const r2 = readImageStorageProfile(stored, 'r2');
  assert.strictEqual(cos.bucket, 'cos-1250000000');
  assert.strictEqual(oss.bucket, 'oss-images');
  assert.strictEqual(isImageStorageProfileConfigured(cos), true);
  assert.strictEqual(isImageStorageProfileConfigured(oss), true);
  assert.strictEqual(isImageStorageProfileConfigured(r2), false);

  const legacyR2 = readImageStorageProfile({}, 'r2', {
    provider: 'r2',
    bucket: 'r2-images',
    endpoint: 'https://account.r2.cloudflarestorage.com',
    publicBaseUrl: 'https://r2.example.com',
    accessKeyId: 'r2-id',
    secretAccessKey: 'r2-secret',
  });
  assert.strictEqual(isImageStorageProfileConfigured(legacyR2), true);

  const migratedCos = {
    [imageStorageProfileKey('cos', 'bucket')]: 'legacy-cos-1250000000',
    [imageStorageProfileKey('cos', 'region')]: 'ap-guangzhou',
    [imageStorageProfileKey('cos', 'prefix')]: 'notus/images',
    [imageStorageProfileKey('cos', 'public_base_url')]: 'https://cos.example.com',
    [imageStorageProfileKey('cos', 'access_key_id')]: 'legacy-cos-id',
    [imageStorageProfileKey('cos', 'secret_access_key')]: 'legacy-cos-secret',
  };
  const switchedProfiles = {
    ...migratedCos,
    [imageStorageProfileKey('oss', 'bucket')]: 'oss-images',
    [imageStorageProfileKey('oss', 'region')]: 'oss-cn-hangzhou',
    [imageStorageProfileKey('oss', 'public_base_url')]: 'https://oss.example.com',
    [imageStorageProfileKey('oss', 'access_key_id')]: 'oss-id',
    [imageStorageProfileKey('oss', 'secret_access_key')]: 'oss-secret',
  };
  assert.strictEqual(isImageStorageProfileConfigured(readImageStorageProfile(switchedProfiles, 'cos')), true);
  assert.strictEqual(isImageStorageProfileConfigured(readImageStorageProfile(switchedProfiles, 'oss')), true);

  delete switchedProfiles[imageStorageProfileKey('cos', 'secret_access_key')];
  const clearedCos = readImageStorageProfile(switchedProfiles, 'cos', {
    provider: 'cos',
    secretAccessKey: 'old-secret-must-not-return',
  });
  assert.strictEqual(clearedCos.secret_access_key, '');
  assert.strictEqual(isImageStorageProfileConfigured(clearedCos), false);
  console.log('image storage profile tests passed');
}

runTests();
