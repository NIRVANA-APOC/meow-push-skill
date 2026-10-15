---
name: meow-push
argument-hint: "[--to <昵称> --msg <内容> | doctor | schema]"
description: >-
  通过 api.chuckfang.com 向指定 MeoW 昵称推送文本或 HTML 消息，内置零依赖的 meow-push CLI。
  当用户要求「推送 / 通知 / 发消息 / 提醒到 MeoW」、给出 MeoW 昵称并希望收到通知、
  要求把任务结果或构建状态推送到手机、或要求生成并实际发送 MeoW 推送请求时使用；
  也用于解释 MeoW 推送响应、排查 400/403/404/429 失败原因。
  仅用于 MeoW（api.chuckfang.com）渠道；其他消息服务（Telegram、Server 酱、邮件、Slack 等）不要使用本技能。
---

# MeoW 消息推送

通过 MeoW HTTP API 向一个已注册的 MeoW 昵称推送一条文本或 HTML 消息。本技能自带
`meow-push` CLI（TypeScript 编写，零运行时依赖，需要 Node.js ≥ 20），负责参数校验、
URL 编码、请求构造、响应判定与退出码映射。**不要手写 curl 或拼 URL**，用 CLI。

面向接口细节、错误码含义或排查线上响应时，先读 `references/api.md`。

## 0. 调用 CLI

CLI 位于本技能目录下。下文所有 `meow-push` 都指：

```bash
node "${CLAUDE_SKILL_DIR}/scripts/meow-push.mjs"
```

若上面的变量未被替换，把它换成本技能的资源目录绝对路径——也就是包含本 `SKILL.md` 的那个目录
（harness 通常会把该技能的资源目录一并告知你）。
CLI 优先使用已编译的 `dist/`，此时 Node ≥ 20 即可；若 `dist/` 缺失，则需要 Node ≥ 22.18
才能免构建直接运行 `src/`（否则请先在该目录执行 `npm install && npm run build`）。

## 1. 发送前必须确认的两件事

推送不可撤销、不可幂等，所以**发送前**必须拿到：

1. **接收者昵称**——必须是目标用户已在 MeoW 注册的昵称。
   - 从用户当前的话里取；从项目配置或长期记忆中取也只有在指向明确时才可接受。
   - **不要猜、不要从无关上下文里挑一个昵称、不要用占位符试发。**昵称不确定就问用户。
   - 昵称是否已注册**无法预先校验**：只能靠一次真实推送的 `404` 才知道，而这次尝试本身
     就是一次推送请求。因此拼写必须由用户确认，不要靠试发来「探测」昵称。
   - 昵称中不能有 `/`，CLI 会在本地直接拒绝。
2. **消息内容**——用户给的原文即最终内容，不要擅自改写、翻译、加署名或加 emoji。

只有用户明确要求「发送 / 推送 / 通知 / 提醒我」时才真正调用 `send`。
只是让你**预览请求**、**给出接口示例**或**解释响应**时，用 `preview`（或 `send -n` / `send --dry-run`），
它不发出任何网络请求，并且**总是以退出码 0 结束**——预览成功不代表推送成功。

## 2. 标准流程

```bash
# 1) 先看清楚将要发出什么（零副作用）
node "${CLAUDE_SKILL_DIR}/scripts/meow-push.mjs" preview \
  --to "<昵称>" --title "<标题>" --msg "<内容>"

# 2) 确认无误后实际推送，并用 --json 拿到机器可读结果
node "${CLAUDE_SKILL_DIR}/scripts/meow-push.mjs" send \
  --to "<昵称>" --title "<标题>" --msg "<内容>" --json
```

内容较长或含引号、换行、HTML 时，写进临时文件再传，避免 shell 转义问题：

```bash
node "${CLAUDE_SKILL_DIR}/scripts/meow-push.mjs" send \
  --to "<昵称>" --title "构建通知" --msg-file ./notice.html --type html --json
```

`--type html` 时用 `--html-height <像素>` 指定 App 内渲染高度（默认 200，允许 1..1000000）。
CLI 会把 `msgType` 与 `htmlHeight` 放在查询串、把标题与正文放进请求体——这是接口要求，
不要试图把它们塞进 JSON body。

`--url` 与 `--img-url` 必须是绝对的 `http(s)://` 链接且不含空格或控制字符，CLI 会本地拒绝并
按 URL 规范发送规范化后的值。省略 `--title` 时 CLI 会在本地填入文档默认值 `MeoW`
（不是让服务端补默认值）。

两条容易踩的本地规则：

- **取值以 `-` 开头时必须写成 `--标志=取值`。**例如要发送内容 `--dry-run`，要写
  `--msg=--dry-run`。否则 CLI 会判定「缺少取值」并报错——这是刻意的：`send --title --dry-run`
  若把 `--dry-run` 当作标题，就会变成一次真实推送。
- **昵称、标题不能是 `.` 或 `..`**（GET 时消息内容也不能）：URL 解析器会把这类路径段删掉，
  使实际发出的地址与预览不一致。

## 3. 按退出码决定下一步

`send` 的退出码就是结论，不要靠读文案判断：

| 退出码 | 含义 | 你应该做什么 |
| --- | --- | --- |
| `0` | 服务端已受理 | 告诉用户已推送。若 `--json` 里 `confirmed` 为 `false`，说明信封未带 `data:true` 确认字段，措辞用「已提交」而不是「已受理确认」 |
| `1` | 本地参数错误，**没有发出任何请求** | 按 stderr 提示修正参数后重试，通常是昵称或内容缺失 |
| `2` | 结果不确定（网络错误 / 超时 / 重定向 / 5xx / HTTP 状态与业务状态冲突 / 响应无法解析） | **绝对不要自动重发**。告诉用户结果未知、可能已送达，由用户决定是否再发 |
| `3` | 被拒绝（400 参数错误 / 403 敏感词 / 404 昵称未注册） | 相同参数重试不会成功。404 就回去和用户核对昵称；403 就说明内容被策略拦截 |
| `4` | 触发频率或 IP 限制（429） | **不要循环重试**。说明服务端返回的限制文案，必要时提示用户更换可信出口 IP |
| `5` | 语义不一致（业务码 `200` 却带 `data=false`） | 按失败处理，不要重发，请用户确认是否收到通知 |

即便退出码为 `0`、`confirmed` 为 `true`，也只表示**服务端接受了这次推送**，不代表用户设备
一定弹出了通知；向用户描述时保持这个限度。

失败时如实说明业务状态码和服务端 `msg`，**不要声称已送达**。

需要区分同一退出码下的具体原因时，读 `--json` 输出里的稳定机器字段 `reason`：

| `reason` | 对应情形 |
| --- | --- |
| `business_400` / `business_403` / `business_404` | 退出码 3 的三种具体拒绝原因 |
| `business_429` / `http_rate_limited` | 业务层 / HTTP 层的限流 |
| `business_500` / `http_server_error` | 服务端错误 |
| `timeout` / `network_error` | 超时 / 网络故障 |
| `redirect_not_followed` | 收到 3xx；重定向不被跟随（见第 6 节） |
| `http_status_conflict` | HTTP 4xx 却带着业务 `200`，响应可能来自中间层 |
| `non_json_response` / `unrecognised_envelope` / `missing_business_status` / `no_response_body` | 响应无法解析成 API 信封 |
| `status_200_data_false` | 退出码 5 的语义不一致 |
| `success_without_data_field` | 退出码 0，但信封未带 `data` 确认字段 |

用法错误（退出码 1）的 `--json` 只有 `ok:false`、`outcome:"usage_error"`、`exitCode:1` 和 `error`，
没有 `envelope` / `confirmed` 字段——不要假定它们存在。

## 4. 频率与 IP 限制（重要）

- 非会员上限：**3 秒 1 条、每分钟 15 条、每小时 60 条、每天 1000 条**，超出返回 `429`。
  批量通知必须由用户明确要求，并放慢节奏；不要写循环连发。
- 换成 `--method get` 或换 POST 的 `--format` **不会**绕过限流——限额按发送者与 IP 计算，
  与请求写法无关。
- 不要使用多人共享的公共出口 IP。同一 IP 向多个昵称推送可能被 MeoW 判定为攻击行为，
  服务端会直接返回 `429 IP限制，请联系开发者`。此时**不要**建议用代理、换 IP 或轮换出口来绕过；
  应提示用户改用可信的独立 IP，或联系开发者申请白名单。
- CLI 遇到 `429` 不会重试，直接以退出码 `4` 结束。

## 5. 自检与排错

```bash
# 环境自检，不发送任何消息
node "${CLAUDE_SKILL_DIR}/scripts/meow-push.mjs" doctor

# 额外探测连通性与出口 IP 是否被限制（只请求 API 根路径，不会推送）
node "${CLAUDE_SKILL_DIR}/scripts/meow-push.mjs" doctor --probe

# 查看全部参数、退出码与接口约定的机器可读描述
node "${CLAUDE_SKILL_DIR}/scripts/meow-push.mjs" schema
```

注意：`doctor --probe` 只有在报告 `[ok]` 时才说明已连通并读到可解析的 API 信封；若根路径返回
HTML、空体或 404，它会以退出码 `2` 明确告知「IP 限制未知」，不会假装连通。
它**不能证明昵称已注册**，也不能证明一次真实推送会成功。

## 6. 边界与已知风险

- 只支持 `text` 与 `html` 两种显示类型，**不支持 Markdown**；需要排版就自己写 HTML 并用
  `--type html`。
- 一次调用只发一条消息、只发给一个昵称。多个收件人要多次调用，并遵守第 4 节的频率限制。
- 本技能只面向 MeoW 渠道。用户要发到其他平台时，不要用本技能，也不要把 MeoW 当作兜底。
- 不要为了「确保成功」而把同一条消息发两遍；推送没有幂等键。
- **`--method get` 会把消息正文放进 URL 路径**，因而可能留在代理、网关日志或 shell 历史里，
  且 URL 长度有上限。除非用户明确要求 GET，否则用默认的 POST；长内容尤其要用 POST。
- **CLI 不跟随重定向。** 推送不可幂等，跟随 301/302/303 可能重复投递或丢失请求体；收到 3xx 时
  以退出码 `2` 结束并提示改用最终地址。因此 `--base-url` 应直接指向可用的 API 地址。
- 除非用户要求，不要展示内部请求细节；用户要的是集成代码时，给可复制的请求示例而不是实际发送。
