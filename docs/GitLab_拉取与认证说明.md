# GitLab 拉取与认证说明

这个项目通过 SSH 从 GitLab 拉取。你这边用的是本机的 `~/.ssh/id_ed25519_gitlab`，GitLab 在 `192.168.18.133:1111`。

## 拉取方式

先确认仓库地址是 SSH 形式：

```bash
git clone ssh://git@192.168.18.133:1111/hejiajun/notus.git
```

如果仓库已经存在，就更新：

```bash
git pull
```

## 认证方式

这里用的是 SSH 公钥认证，不是用户名密码。

本机私钥：

```bash
~/.ssh/id_ed25519_gitlab
```

对应公钥：

```bash
~/.ssh/id_ed25519_gitlab.pub
```

测试是否能认证成功：

```bash
ssh -T -p 1111 git@192.168.18.133
```

如果成功，会看到类似：

```text
Welcome to GitLab, @hejiajun!
```

## 原理

SSH 认证的流程很简单：

1. 本机把私钥发起给 SSH 客户端。
2. 客户端用私钥证明“我有这把钥匙”。
3. GitLab 端保存的是对应的公钥，它拿这个公钥去验证签名。
4. 验证通过，就允许访问仓库。

所以关键不是“有没有装 Git”，而是：

- 端口要对
- 私钥要对
- GitLab 里登记的公钥要对

## 常见错误

- `Permission denied (publickey)`：私钥没被 GitLab 接受，或者用错了 key。
- `Connection closed`：端口不是 SSH 服务，或者转发不对。
- `HTTP 400 Bad Request`：你连到的是 HTTP 入口，不是 SSH 入口。

