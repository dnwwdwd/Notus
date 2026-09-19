const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 名称、类型、权限及文件内容都参与校验，删除文件或改变软链接同样使产物失效。
function contentDigest(directory) {
  const hash = crypto.createHash('sha256');
  function visit(relative) {
    const target = path.join(directory, relative);
    const stat = fs.lstatSync(target);
    hash.update(JSON.stringify([relative, stat.mode, stat.isFile() ? stat.size : null]));
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target).sort()) visit(path.join(relative, entry));
    } else if (stat.isSymbolicLink()) {
      hash.update(JSON.stringify(fs.readlinkSync(target)));
    } else if (stat.isFile()) {
      hash.update(fs.readFileSync(target));
    } else {
      throw new Error(`不支持的构建产物类型：${relative}`);
    }
  }
  visit('');
  return hash.digest('hex');
}

if (require.main === module) {
  console.log(contentDigest(process.argv[2]));
}
module.exports = { contentDigest };
