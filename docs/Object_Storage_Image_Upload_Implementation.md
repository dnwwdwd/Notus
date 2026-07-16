# 对象存储图片上传实施文档

> 更新时间：2026-07-11
> 适用范围：文件工作区富文本编辑器的粘贴图片和工具栏选图。

## 1. 目标与边界

Notus 支持两种图片存储位置：本地资源目录与对象存储。对象存储首期支持腾讯云 COS、阿里云 OSS、Cloudflare R2。图片由 Next.js API Route 上传，浏览器只向 Notus 提交 `FormData`，不保存也不接触云端密钥。

云端模式仅保存请求期间的临时文件。上传成功后，Markdown 直接使用公开 URL；上传失败时 Markdown 不产生图片节点。已有本地图片、外链图片和历史 Markdown 不自动迁移。删除 Markdown 引用不会删除云对象，避免内容哈希去重后的误删。

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

1. 富文本编辑器从剪贴板或文件选择框取得图片，并请求 `POST /api/files/:id/images`。
2. API Route 校验文件存在、`image/*` MIME 与 15MB 上限，随后读取临时文件。
3. 本地模式调用既有 `storeLocalImageBuffer`，写入 `assets/images` 并返回相对 Markdown 路径。
4. 云端模式计算 SHA-256，生成 `<prefix>/<YYYY>/<MM>/<sha256>.<ext>`，使用 provider 官方 SDK 上传，同时写入 `Content-Type` 与 `Cache-Control: public, max-age=31536000, immutable`。
5. API 返回公开 URL 作为 `src`。编辑器按现有接口插入图片节点；远程 URL 可继续被现有图片缓存和索引链路按需读取。

对象存储失败统一返回可读错误。粘贴图片与工具栏选图都保留编辑状态，显示错误提示，不自动保存本地副本。

## 5. 验证清单

- 本地模式：粘贴、工具栏选图、相对路径写入和图片预览回归。
- COS、OSS、R2：分别使用真实测试 Bucket 验证上传、公开 URL、`Content-Type`、缓存头和同内容图片对象键稳定性。
- 异常：错误密钥、无写权限、错误 Bucket、网络失败、超过 15MB、非图片文件；确认 Markdown 不插入图片且临时文件被删除。
- 安全：设置读取不含明文 Access Key/Secret；日志不输出密钥。
- 构建：`npm run test:object-storage`、`npm run test:platform`、`npm run lint`、`npm run build`。
