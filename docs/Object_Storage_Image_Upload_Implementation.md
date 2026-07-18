# 对象存储图片上传实施文档

> 更新时间：2026-07-16
> 适用范围：文件工作区富文本编辑器图片上传，以及 Agent 对话图片写入笔记。

## 1. 目标与边界

Notus 支持两种图片存储位置：本地资源目录与对象存储。对象存储首期支持腾讯云 COS、阿里云 OSS、Cloudflare R2。图片由 Next.js API Route 上传，浏览器只向 Notus 提交 `FormData`，不保存也不接触云端密钥。

编辑器上传接口只在请求期间保存临时文件，成功或失败后都会清理。Agent 对话图片则保存到会话临时目录，并按消息元数据长期保留；它们在应用笔记时才复制到本地资源目录或对象存储。已有本地图片、外链图片和历史 Markdown 不自动迁移。删除 Markdown 引用不会删除云对象，避免内容哈希去重后的误删。

## 2. 官方开发文档与客户端

- 腾讯云 COS：[`cos-nodejs-sdk-v5` 快速入门](https://cloud.tencent.com/document/product/436/8629) 与 [上传对象](https://cloud.tencent.com/document/product/436/7749)。配置 `SecretId`、`SecretKey`、Bucket（包含 AppId）和 Region。
- 阿里云 OSS：[Node.js SDK](https://help.aliyun.com/zh/oss/developer-reference/oss-sdk-for-node-js) 与 [`ali-oss` SDK 文档](https://github.com/ali-sdk/ali-oss)。配置 `accessKeyId`、`accessKeySecret`、bucket、region；可按需覆盖 endpoint。
- Cloudflare R2：[S3 API 兼容性](https://developers.cloudflare.com/r2/api/s3/api/) 与 [AWS SDK for JavaScript v3](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/)。配置 S3 API Access Key、Secret、bucket、`https://<ACCOUNT_ID>.r2.cloudflarestorage.com` endpoint，region 固定为 `auto`。

实现使用三家官方客户端：`cos-nodejs-sdk-v5`、`ali-oss`、`@aws-sdk/client-s3`。`lib/objectStorage.js` 提供统一配置校验、对象键生成、公开 URL 生成和上传函数；业务代码不手写签名或请求鉴权。

## 3. 设置模型与安全

`GET /api/settings` 返回脱敏字段：

```json
{
  "images": {
    "storage_mode": "local | object_storage",
    "object_storage": {
      "provider": "cos | oss | r2",
      "bucket": "...",
      "region": "...",
      "endpoint": "...",
      "prefix": "notus/images",
      "public_base_url": "https://images.example.com",
      "access_key_id_set": true,
      "secret_access_key_set": true
    }
  }
}
```

`PUT /api/settings` 可写入配置和密钥；密钥为空时保持当前值，`clear_access_key_id`、`clear_secret_access_key` 显式删除已保存密钥。密钥不写日志、不返回前端。对象存储模式保存前会校验 provider、Bucket、公开 URL、认证信息，以及 COS/OSS Region、R2 Endpoint。

部署环境也可通过 `IMAGE_STORAGE_MODE` 与 `OBJECT_STORAGE_*` 环境变量提供默认配置；图床页保存后的 SQLite settings 优先。示例变量见 `notus/.env.local.example`。

建议创建最小权限凭据：只允许目标 Bucket 和指定前缀的写入。公开域名仅开放读取；不开放匿名写入。公开访问基础 URL 可以是服务商默认公开域名、CDN 域名或自定义域名，不能是带过期时间的预签名 URL。

## 4. 上传链路

1. 富文本编辑器从剪贴板或文件选择框取得图片，并请求 `POST /api/files/:id/images`；Agent 会话图片由 `/api/agent/images/upload` 临时保存。
2. 编辑器 API 校验文件存在、`image/*` MIME 与 15MB 上限。Agent 在用户应用图片预览时按会话受控引用读取临时文件，不接受客户端传入路径。
3. 两条链路都调用 `lib/imageStorage.js:persistImageBuffer()`。本地模式写入 `assets/images` 并返回相对 Markdown 路径。
4. 云端模式计算 SHA-256，生成 `<prefix>/<YYYY>/<MM>/<sha256>.<ext>`，使用 provider 官方 SDK 上传，同时写入 `Content-Type` 与 `Cache-Control: public, max-age=31536000, immutable`。
5. 编辑器上传后立即返回 `src`。Agent 图片在预览阶段保留会话引用，文件冲突校验通过后才存储并替换为相对路径或公开 URL。

对象存储失败统一返回可读错误。粘贴图片与工具栏选图都保留编辑状态，显示错误提示，不自动保存本地副本。

## 5. 验证清单

- 本地模式：粘贴、工具栏选图、Agent 图片应用、相对路径写入和图片预览回归。
- COS、OSS、R2：分别使用真实测试 Bucket 验证上传、公开 URL、`Content-Type`、缓存头和同内容图片对象键稳定性。
- 异常：错误密钥、无写权限、错误 Bucket、网络失败、超过 15MB、非图片文件、会话图片失效和文件 stale；确认 Markdown 不插入图片，编辑器请求临时文件被删除，Agent 会话图片仍按会话保留。
- 安全：设置读取不含明文 Access Key/Secret；日志不输出密钥。
- 构建：`npm run test:object-storage`、`npm run test:platform`、`npm run lint`、`npm run build`。
