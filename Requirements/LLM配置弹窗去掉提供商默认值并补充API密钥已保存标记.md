# LLM配置弹窗去掉提供商默认值并补充API密钥已保存标记

## 类型

用户体验优化

## 背景

当前 LLM 新增/编辑弹窗虽然已经允许手动修改 provider，但输入框仍会把自动识别结果直接写成默认值。用户清空后，界面又会继续回填自动识别名称，形成“删掉又回来”的体验问题。同时 API Key 已保存状态在弹窗里没有明确标记，用户很难区分“当前为空”还是“后端已经保存、这里只是不回显明文”。

## 需求

1. LLM 新增/编辑弹窗中的 provider 输入框不再自动写入默认值。
2. provider 输入框改为使用 placeholder 提示协议默认厂商：
   - `OpenAI API` 时显示 `OpenAI`
   - `Anthropic` 时显示 `Anthropic`
3. provider 仍允许留空显示；真正保存时如用户未填写，则再按 Base URL 和模型名推断兜底。
4. 当 API Key 已保存时，弹窗中的 API Key 字段需要显示“已保存”标记，并保留“留空不修改”的提示。

## 实现结果

1. `LlmConfigCardsSection` 的 provider 输入框已改为只绑定用户实际输入值，不再回填自动识别结果。
2. provider 改为根据当前兼容协议显示 `OpenAI` / `Anthropic` placeholder；保存时仍使用用户输入，若为空则退回自动推断结果。
3. API Key 字段顶部新增 `已保存` badge；当后端返回 `api_key_set=true` 时，输入框 placeholder 显示为“已保存，留空不修改”。

## 验收

- 新增或编辑 LLM 配置时，provider 输入框初始不再出现自动填入的默认值。
- 用户清空 provider 后，输入框不会因为自动识别再次被回填。
- 不填写 provider 直接保存时，配置仍能按 Base URL / 模型名推断 provider 落库。
- 已保存 API Key 的配置再次编辑时，API Key 字段能看到“已保存”标记。
