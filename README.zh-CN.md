# meow-push-skill

**Agent 技能 + 零依赖 TypeScript CLI**：向指定 [MeoW](https://www.chuckfang.com/MeoW/api_doc.html)
昵称推送文本或 HTML 通知。

[![CI](https://github.com/NIRVANA-APOC/meow-push-skill/actions/workflows/ci.yml/badge.svg)](https://github.com/NIRVANA-APOC/meow-push-skill/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

> English docs: [README.md](README.md)

技能文档（[`SKILL.md`](SKILL.md)）告诉 Agent 何时该发、发送前必须确认什么、以及如何诚实地解读
结果；CLI 负责参数校验、URL 编码、请求构造、响应判定与退出码，Agent 不需要手写请求。

```bash
meow-push preview --to JohnDoe --title "构建通知" --msg "构建已完成"
meow-push send    --to JohnDoe --title "构建通知" --msg "构建已完成" --json
```

## 为什么要用 CLI 而不是直接发 HTTP

MeoW 接口本身只是一个 GET/POST，但有三个容易踩的坑：

- **推送不可幂等。** 超时或 5xx 之后，消息是否送达是真的未知。CLI 从不重试、从不跟随重定向，
  并把不确定的结果如实报告为不确定。
- **响应契约有陷阱。** HTTP 状态恒为 `200`，真正的结果在 JSON 里；而且官方文档的示例与真实
  信封并不一致（见 [`references/api.md`](references/api.md)）。
- **限流与出口 IP 策略由服务端强制**，共享的公共出口 IP 可能导致整台主机被限制。

## 安装

本仓库**本身就是技能包**：根目录即 `SKILL.md`。把整个目录复制进任一技能扫描根即可——目录包
必须是 `<根目录>/<任意名字>/SKILL.md`，且只扫描一层：

```bash
git clone https://github.com/NIRVANA-APOC/meow-push-skill.git
cp -r meow-push-skill ~/.dsh/skills/meow-push          # DeepSeek Harness
# cp -r meow-push-skill ~/.claude/skills/meow-push     # Claude Code
```

技能以 frontmatter 里的 `name`（`meow-push`）注册，与所在目录名无关。之后这样调用：

```bash
node "<技能目录>/scripts/meow-push.mjs" send --to JohnDoe --msg "hello" --json
```

无需安装：`dist/` 已随仓库提交，只要有 `node`（≥ 20）就能跑。若 `dist/` 缺失，启动器会在
Node ≥ 22.18 上回退为直接运行 TypeScript 源码。

## 命令

| 命令 | 用途 |
| --- | --- |
| `send` | 推送一条消息。从不重试。 |
| `preview` | 只构造并打印请求，不发送（等价于 `send --dry-run` / `send -n`）。 |
| `doctor` | 本地自检。加 `--probe` 会额外请求 API 根路径，检查连通性与出口 IP 是否受限。不会推送。 |
| `schema` | 以 JSON 输出全部命令、参数与退出码。 |

```bash
meow-push preview --to JohnDoe --title "系统通知" --msg "<b>你好</b>" --type html
meow-push send    --to JohnDoe --title "构建通知" --msg-file ./notice.html --type html --json
meow-push send    --to JohnDoe --msg "hi" --url https://example.com --img-url https://example.com/i.png
meow-push doctor --probe
meow-push schema
```

完整参数列表见 `meow-push help`。

## 退出码

退出码就是给 Agent 的契约，不需要解析文案。

| 码 | 含义 | Agent 应该做什么 |
| --- | --- | --- |
| `0` | 服务端已受理；`--json` 的 `confirmed` 表示信封是否带 `data: true` | 报告已推送；`confirmed:false` 时只说「已提交」 |
| `1` | 本地参数错误，**没有发出任何请求** | 修正参数后重试 |
| `2` | 结果不确定：网络错误 / 超时 / 重定向 / 5xx / HTTP 与业务状态冲突 / 响应无法解析 | **绝不自动重发**，告诉用户结果未知 |
| `3` | 被拒绝：业务码 `400` / `403` / `404` | 相同参数重试无意义 |
| `4` | 频率或 IP 受限（`429`） | 不要循环重试 |
| `5` | 语义冲突：业务码 `200` 却带 `data: false` | 按失败处理，不要重发 |

`--json` 还会给出稳定的 `reason` 字段（`business_404`、`timeout`、`redirect_not_followed` 等），
用于区分共用同一退出码的具体情形。完整表格见 [`SKILL.md`](SKILL.md)。

## 响应判定

只有业务码 `status === 200` 才算受理，且 CLI 绝不超过服务端实际表达的含义：

| 服务端响应 | CLI 报告 |
| --- | --- |
| `{"status":200,"data":true,"msg":"发送成功"}` | 已受理，`confirmed: true` |
| `{"status":200,"msg":"…"}`（无 `data`） | 已受理但未确认，`confirmed: false` |
| `{"status":200,"data":false}` | 退出码 `5`，语义冲突 |
| `{"status":404,…}` | 退出码 `3`，昵称未注册 |
| 非 JSON / 空体 / 无法解析 | 退出码 `2`，未知，绝不重放 |

## 目录结构

```
SKILL.md                     面向 Agent 的技能契约（技能入口）
README.md / README.zh-CN.md  英文 / 中文说明
CHANGELOG.md                 版本变更
LICENSE                      MIT
references/api.md            离线接口参考 + 文档与实测差异
references/openapi.json      上游 OpenAPI 3.1 规范（原样导出）
src/                         TypeScript 源码
  main.ts                    可执行入口
  cli.ts                     命令分发、参数表、输出、退出码映射
  client.ts                  请求构造、HTTP、响应分类
  args.ts                    解析器（一张参数表同时驱动 --help 与 schema）
  errors.ts, types.ts        错误类型、共享类型与退出码
dist/                        编译产物（已提交，开箱即用，无需构建）
scripts/meow-push.mjs        启动器：优先 dist/，回退到 TS 源码
scripts/mock-server.mjs      本地 MeoW API 模拟服务
scripts/test.mjs             68 个端到端用例，不触网
scripts/scan-secrets.mjs     防止把私人信息发布出去
scripts/check-dist-sync.mjs  校验已提交的 dist/ 与 src/ 一致
```

## 开发

```bash
npm ci
npm run verify     # typecheck → build → dist-sync → 测试 → 敏感信息扫描
```

单独运行：`npm run typecheck`、`npm run build`、`npm test`、`npm run check:dist-sync`、
`npm run scan:secrets`。

`npm test` 会在随机端口启动内置 mock API，并在进程内驱动真实 CLI。它不需要网络、凭证或已注册
昵称，因此在任何环境都能安全运行。覆盖请求构造、严格 RFC 3986 编码、各种响应信封形状、全部
六个退出码、21 个本地校验用例（每个都断言**零请求**），以及「preview 永不发送」「每条 send
路径恰好一个请求」这两条保证。

手工对着 mock 调试：

```bash
npm run mock                                    # 终端 1
node scripts/meow-push.mjs send --to demo --msg hi \
  --base-url http://127.0.0.1:8787 --allow-http # 终端 2
```

## 设计原则

- **绝不冒重复投递的风险。** 不自动重试、不跟随重定向、每次调用只发一个请求；不确定就报告为
  不确定。
- **只用文档化路由。** `POST /{nickname}/{title}`；标题省略时在本地补文档默认值 `MeoW`。
- **`msgType` 与 `htmlHeight` 是查询参数**，绝不放进 JSON body。
- **严格 RFC 3986 编码**：只保留 unreserved 字符，空格用 `%20` 而不是 `+`。
- **预览即所发。** URL 解析器会改写的路径段（`.`、`..`）直接拒绝，`--url` 会被规范化后再发送。
- **不做静默的成功承诺。** `data: true` 只表示服务端受理，不代表设备已收到。
- **默认拒绝明文 HTTP**（需显式 `--allow-http`），因为消息内容会随请求外发。

## 验证状态

- 68/68 自动化用例通过；CI 在 Node 20、22、24 上运行。
- `references/openapi.json` 已与线上页面内嵌的 OpenAPI 文档逐项对比，完全一致。
- 响应分类与退出码映射已在真实的 `api.chuckfang.com` 上验证。
- **未验证一次真实的成功推送**：上游服务限制了开发期间可用的出口 IP，任何请求都返回
  `429 IP限制，请联系开发者`。因此成功路径由内置 mock 覆盖，失败路径由真实探测
  （`meow-push doctor --probe`）验证。详见 [`references/api.md`](references/api.md) 第 5 节。

## 许可

[MIT](LICENSE)
