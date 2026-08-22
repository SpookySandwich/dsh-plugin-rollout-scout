# dsh-plugin-rollout-scout

[English](README.en.md) | 简体中文

[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-0.1.1--rc.2-4b8dff)](https://github.com/deepseek-ai/deepseek-harness)
[![stars](https://img.shields.io/github/stars/SpookySandwich/dsh-plugin-rollout-scout?style=flat&label=stars)](https://github.com/SpookySandwich/dsh-plugin-rollout-scout/stargazers)

服务商有时会灰度发布新的对话模型，你分到哪一个全看运气。灰度侦察会用你自己的账号开启一批临时会话，**在思维链流式输出的同时**读取它，并按「推理是怎么写的」打分——读起来像你手上这个旧模型的立刻中止，不像的留下来。

它是基于措辞的启发式小工具，不是权威判据。它做的每件事你都可以手动完成：开一个新会话、扫一眼思维链、关掉。

![控制台](https://raw.githubusercontent.com/SpookySandwich/dsh-plugin-rollout-scout/master/assets/console-zh.png)

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

段落开头写满 48 个字符就会打分，即使模型从不换行。后出现的 `Let me` **会推翻** 先前的保留。

灰度链路常常用一个 **小模型总结思维链**。总结模型经常以 `We need to…` 开头（所以段首 `we` 只记负分，不直接判死），写出 **规整、一段一段的长段落**，并且 **输出一阵、卡住、再输出一阵**。这三条都是新链路的正面证据。旧模型不规律——整段糊成一块，或夹着很短的 `Let me` 行。

正向开头是第一人称**单数**的计划语气——`I'm`、`I am`、`I've`、`I have`、`I need`、`I think`、`I also`、`I will`，以及位于开头的 `For`。负向开头是 `Let me` / `Let's`，以及开头里出现的**任何**第一人称复数（`we`、`we need`、`we will`、`we'll` …）。灰度模型用 “I”，不用 “we”。加一的先验让证据稀少时分数停在 50% 附近，不会因为一个词就给出自信判断：

| 证据 | 置信度 | 判定 |
| --- | --- | --- |
| 暂无 | 50% | 继续观察 |
| 1 正 / 10 负 | 15% | 丢弃 |
| 5 正 / 0 负 | 86% | 保留 |

低于 `低于此分即丢弃`（0.35）丢弃，高于 `高于此分即保留`（0.7）保留，但都要先累计到 `最少开头数`（4）。若连续开了十段一个正向开头都没有，则放弃；思维链 **以中文为主**（字母中 80% 以上为汉字）则直接丢弃——英文推理里引用一句中文提示词不算。

分类器有基于人工标注样本的测试，此外还覆盖了接口防护、发起失败时的行为，以及删除会话的规则：

```bash
npm test
```

## 控制台

**灰度侦察** 位于侧边栏底部、「设置」旁边，点开就是上图的整屏控制台。它注册在 `sidebar.footer.action` 座位上，因此与外壳自带的条目样式一致；侧边栏收起为窄栏时，它也会收成一个图标。

**左栏** —— 探测提示词、模型（默认 V4-Pro / High）、并发数、存放目录、评分阈值，以及开关：命中强匹配时自动暂停、思维链以中文为主时丢弃、从磁盘删除旧模型会话。

**右栏** —— 已发起 / 进行中 / 已保留 / 已丢弃 / 最高分，下方队列按发起顺序排列、不随分数跳动。每行带分数条、命中短语与思维链预览。点击整张卡片打开会话，会话继续跑。鼠标放在卡片上视为需要它：淡出过程中移上去会救回来，点进去也不会停。

**开始** 会变为 **暂停**（只停止发起新探测，进行中的各自跑完判定），再变为 **继续**。**强制停止** 会中止所有进行中的会话。

判旧的探测先淡出约 3 秒（卡片底边一条细线收掉），期间会话还在跑；淡完才取消。鼠标放上去或点进去会留下。

**清空已结束** 会从列表移除已完成的探测，并删除这些会话文件。**删除全部会话** 会清空该目录下所有探测（包括已经从列表清掉的），并把编号从 1 重新计。

两者都不会动仍在流式输出的探测。暂停只是停止发起，进行中的探测仍在跑，所以此时 **删除全部会话** 会要求你先 **强制停止**，以免删掉正在写入的会话文件。存放目录不能是主目录、磁盘根目录，也不能位于 `~/.dsh` 之内——删除以该目录为范围，这些位置会把无关会话卷进去。

若连续三个探测连启动都失败（服务不可达、目录不可写等），运行会自行停止并报出错误，而不是一直重复同一个失败。点 **继续** 可以重试。

运行状态在宿主端，因此关掉控制台后仍会继续——侧边栏那一行的图标上带一个状态小点（侦察中呼吸闪烁、暂停为灰、命中转绿），宽栏里还会显示进行中的数量、命中后带绿色角标，悬停可看已试数量与目前最高置信度。收成窄栏后只剩这个小点可看，所以它长在图标上而不是文字里。

## 安装

```bash
dsh plugin --profile web add github:SpookySandwich/dsh-plugin-rollout-scout
```

安装后请重启 DSH：宿主端随服务器加载。界面跟随 DSH 显示语言（中文 / English）。

`web` 是 profile 名称，请换成你实际使用的那个。独立版启动的是 `web`，DSH Desktop 用的是 `desktop`。`~/.dsh/profiles/` 下就是你现有的 profile，安装结果落在对应 profile 的 `package.json` 里。

尚未发布到 npm，因此从仓库安装。`lib/client.js` 是构建产物，但已**提交进仓库**，所以安装时无需任何构建步骤——`dsh plugin add` 底层是 pnpm，默认不会执行依赖的生命周期脚本。若你修改了 `plugin.client.js`，请运行 `npm run build` 重新生成（`npm test` 也会顺带生成），并把结果一并提交。

## 工作原理

- 宿主端提供 `/rollout-scout` 接口，用 `ctx.agents.create`（不带 seed）把每个探测创建为全新会话，并通过 `installModelSelection` 设置模型与思考强度。
- 订阅该 agent 作用域内的 `session/event`，从 `assistant/chunk` 读取 `reasoning-delta`（流式思维链），每收到一块就重新分类。
- 判为旧模型时调用 `agent.cancel` 中止该轮；判为灰度则放行至 `turn/end`。流式过程中最后一段会被暂时忽略（开头可能只写了一半），turn 结束后再用完整文本重新分类。
- 探测会话创建在你指定的目录下（作为一个工作区），判为旧模型的会话可选择从磁盘删除。
- `/rollout-scout` 监听在本地端口上，因此按本地接口的方式做了防护：写操作必须带 `application/json` 内容类型（这会强制浏览器发起 CORS 预检，而预检永远不会被放行），跨源的 `Origin` 一律拒绝。你恰好打开的某个网页无法借此发起探测或删除数据。

## 兼容性

入口占用 `sidebar.footer.action` 座位（list 类型，会与其它底部操作并排，而不是把谁挤掉），控制台本体渲染在全局 `shell.overlay` 层。两者都不属于会话作用域，因此不与任何会话内插件冲突。需要侧边栏声明了该座位的 DSH 版本；否则控制台将没有入口。与 [dsh-plugin-smooth-stream](https://github.com/SpookySandwich/dsh-plugin-smooth-stream)、[dsh-plugin-smooth-motion](https://github.com/SpookySandwich/dsh-plugin-smooth-motion)、[dsh-plugin-message-tree](https://github.com/SpookySandwich/dsh-plugin-message-tree) 同族。

## 关于额度

每个探测都是一次真实的对话轮次，消耗你自己的额度。被丢弃的通常一两秒内就中止，但只要不停止，运行中的任务会一直发起新探测。并发数与各项阈值都可自行调整。

## 许可

MIT © SpookySandwich
