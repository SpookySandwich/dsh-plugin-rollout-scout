# dsh-plugin-rollout-scout

[English](README.en.md) | 简体中文

[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-0.1.0--rc.7-4b8dff)](https://github.com/deepseek-ai/deepseek-harness)
[![stars](https://img.shields.io/github/stars/SpookySandwich/dsh-plugin-rollout-scout?style=flat&label=stars)](https://github.com/SpookySandwich/dsh-plugin-rollout-scout/stargazers)

服务商有时会灰度发布新的对话模型，你分到哪一个全看运气。灰度侦察会用你自己的账号开启一批临时会话，**在思维链流式输出的同时**读取它，并按「推理是怎么写的」打分——读起来像你手上这个旧模型的立刻中止，不像的留下来。

它是基于措辞的启发式小工具，不是权威判据。它做的每件事你都可以手动完成：开一个新会话、扫一眼思维链、关掉。

## 判定方式

信号在于 **每个段落是怎么开头的**，而不是某个短语在全文出现了多少次。若按全文累计，「Let me」会单纯因为篇幅变长而越积越多，一段本来很好的长思维链最终也会被判为差。只看开头，度量才稳定。

每段只读前 48 个字符。而关键短语往往并不在第 0 个字符：

> **The directory is empty. Let me create** a 3D cyberpunk scene.
> **To avoid conflicts, I'll keep** I18n.cs edits under one change.

有两个决定性信号，且刻意 **不对称**：

| 信号 | 效果 |
| --- | --- |
| 任意段落以 `Let me` 开头 | 旧模型——立即中止该轮 |
| **整条思维链** 以 `I'll` 开头 | 灰度模型——放行跑完并保留 |

`I'll` 只有出现在最开头才算证据：旧模型也会在 **中间某段** 写「I'll create a single HTML file…」，然后隔几段又说「Let me build…」。把每个 `I'll` 都当证据会造成误判。

两者都没触发时，其余开头进入评分：

```
置信度 = (正向开头数 + 1) / (已分类开头数 + 2)
```

正向开头是第一人称的计划语气——`I'm`、`I am`、`I've`、`I have`、`I need`、`I think`、`I also`、`I will`，以及位于开头的 `For`。负向开头是 `Let's`、`We need`、`We should` 等。加一的先验让证据稀少时分数停在 50% 附近，不会因为一个词就给出自信判断：

| 证据 | 置信度 | 判定 |
| --- | --- | --- |
| 暂无 | 50% | 继续观察 |
| 1 正 / 10 负 | 15% | 丢弃 |
| 5 正 / 0 负 | 86% | 保留 |

低于 `低于此分即丢弃`（0.35）丢弃，高于 `高于此分即保留`（0.7）保留，但都要先累计到 `最少开头数`（4）。若连续开了十段一个正向开头都没有，则放弃；思维链 **以中文为主**（字母中 80% 以上为汉字）则直接丢弃——英文推理里引用一句中文提示词不算。

分类器有基于人工标注样本的测试：

```bash
npm test
```

## 控制台

窗口右下角有一枚胶囊按钮，点开是整屏控制台。

**左栏** —— 探测提示词、模型（默认 V4-Pro / High）、并发数、存放目录、评分阈值，以及三个开关：命中强匹配时自动暂停、思维链以中文为主时丢弃、从磁盘删除旧模型会话。

**右栏** —— 已发起 / 进行中 / 已保留 / 已丢弃 / 最高分，下方是 **按置信度排序** 的队列（高分在上），分数变化时行会动画滑到新位置。每行带分数条（标出两条阈值线）、命中的短语与思维链预览。点击任意一行即可打开该会话。

**开始** 会变为 **暂停**（只停止发起新探测，进行中的各自跑完判定），再变为 **继续**。**强制停止** 会中止所有进行中的会话。被丢弃的探测会淡出队列，但仍计入统计。

运行状态在宿主端，因此关掉控制台后仍会继续——胶囊会显示进行中与已试数量，命中后变绿并带角标，悬停可看目前最高置信度。

## 安装

```bash
dsh plugin --profile web add dsh-plugin-rollout-scout
```

安装后请重启 DSH：宿主端随服务器加载。界面跟随 DSH 显示语言（中文 / English）。

## 工作原理

- 宿主端提供 `/rollout-scout` 接口，用 `ctx.agents.create`（不带 seed）把每个探测创建为全新会话，并通过 `installModelSelection` 设置模型与思考强度。
- 订阅该 agent 作用域内的 `session/event`，从 `assistant/chunk` 读取 `reasoning-delta`（流式思维链），每收到一块就重新分类。
- 判为旧模型时调用 `agent.cancel` 中止该轮；判为灰度则放行至 `turn/end`。流式过程中最后一段会被暂时忽略（开头可能只写了一半），turn 结束后再用完整文本重新分类。
- 探测会话创建在你指定的目录下（作为一个工作区），判为旧模型的会话可选择从磁盘删除。

## 兼容性

界面挂在全局 `shell.overlay` 层，不与任何会话内插件冲突。与 [dsh-plugin-smooth-stream](https://github.com/SpookySandwich/dsh-plugin-smooth-stream)、[dsh-plugin-smooth-motion](https://github.com/SpookySandwich/dsh-plugin-smooth-motion)、[dsh-plugin-message-tree](https://github.com/SpookySandwich/dsh-plugin-message-tree) 同族。

## 关于额度

每个探测都是一次真实的对话轮次，消耗你自己的额度。被丢弃的通常一两秒内就中止，但只要不停止，运行中的任务会一直发起新探测。并发数与各项阈值都可自行调整。

## 许可

MIT © SpookySandwich
