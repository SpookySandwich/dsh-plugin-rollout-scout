# dsh-plugin-rollout-scout

[English](./README.en.md) | 中文

给 DeepSeek Harness 用的「灰度模型钓鱼器」。当供应商灰度发布更强的对话模型时，它可能只在随机新会话里出现。本插件并发地开启一批短探测会话，**实时**读取它们的思维链，靠措辞特征快速判断：

- 思维链频繁出现 **"Let me"** → 很可能是旧模型，**立即中止并丢弃**该会话（不浪费额度跑完）。
- 频繁出现 **"I'm" / "I need" / "For"** → 很可能是灰度新模型，**放行让它跑完这一轮**并保留下来。

> ⚠️ 这些短语特征是启发式的，并非官方判据，只反映不同模型的思维链风格差异。阈值都可调。

## 界面

右下角有一枚「侦察」胶囊按钮，点开是玻璃质感的控制面板：

- **探测提示词**、**模型**（默认 V4-Pro / High）、**并发数**、**存放目录**。
- 阈值：`"Let me" ×N 即丢弃`、`信号 ×N 即保留`、`最大探测数`。
- 开关：`命中一次后停止`、`自动删除旧模型会话`（会从磁盘删除该会话日志）。
- **开始 / 停止 / 清空**。停止后，进行中的探测会各自跑到自己的判定为止，只是不再发起新的。
- 下方队列实时显示每个探测的状态、`Let me` 次数、信号数、思维链字数与预览；点击任意一条可直接打开该会话。

## 工作原理

- 宿主端提供 `/rollout-scout` 接口，用 `ctx.agents.create`（不带 seed）凭空创建全新会话，用 `installModelSelection` 设置模型与思考强度。
- 订阅该会话作用域内的 `session/event`，读取 `assistant/chunk` 里的 `reasoning-delta`（思维链增量），逐字累计并即时分类。
- 命中旧模型特征时调用 `agent.cancel` 中止当前轮；命中新模型特征时放行至 `turn/end`。
- 所有探测会话都创建在你指定的目录下（作为一个工作区），可选自动删除判为旧模型的会话。

## 安装

```
dsh plugin add dsh-plugin-rollout-scout
```

安装后重启 DSH（宿主端随服务器加载）。

## 兼容性

界面挂在全局 `shell.overlay` 层，不与任何会话内插件冲突；界面跟随 DSH 显示语言。与 [dsh-plugin-smooth-stream](https://github.com/SpookySandwich/dsh-plugin-smooth-stream)、[dsh-plugin-smooth-motion](https://github.com/SpookySandwich/dsh-plugin-smooth-motion)、[dsh-plugin-message-tree](https://github.com/SpookySandwich/dsh-plugin-message-tree) 同族共存。

## 许可

MIT © SpookySandwich
