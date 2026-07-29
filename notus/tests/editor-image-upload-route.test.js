const assert = require('assert');
const fs = require('fs');
const path = require('path');

const routePath = path.resolve(__dirname, '../pages/api/files/[id]/images.js');
const source = fs.readFileSync(routePath, 'utf8');

assert.ok(
  source.includes("const { getEffectiveConfig } = require('../../../../lib/config');"),
  '编辑器图片上传路由必须导入 getEffectiveConfig，以创建临时上传目录。',
);
assert.ok(source.includes("path.resolve(getEffectiveConfig().sessionDir, 'editor-images')"));

console.log('editor image upload route tests passed');
