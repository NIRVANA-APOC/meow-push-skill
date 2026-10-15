# MeoW 推送接口参考

上游文档：<https://www.chuckfang.com/MeoW/api_doc.html>（内嵌 OpenAPI 3.1 规范）

本文内容取自该页面的正文、页面内嵌的 `<script id="openapi-spec">` OpenAPI 3.1 文档，
以及一次对生产接口的真实探测。三者冲突之处在文末「已知不一致」中说明。

## 1. 服务地址

| 协议 | Base URL |
| --- | --- |
| HTTPS（推荐） | `https://api.chuckfang.com` |
| HTTP | `http://api.chuckfang.com` |

所有中文参数都需要 URL 编码。消息内容会出现在 URL 路径（GET）或请求体（POST）中，
使用 HTTP 明文时内容不加密，因此 CLI 默认拒绝 `http://`，需显式加 `--allow-http`。

## 2. 三个路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/{nickname}/{title}/{msg}` | 含标题 |
| GET | `/{nickname}/{msg}` | 省略标题，服务端按 `MeoW` 处理 |
| POST | `/{nickname}/{title}` | 唯一的 POST 路由；`title` 可选 |

`nickname` 不允许包含斜杠 `/`。

CLI 只使用上述已文档化的路由：POST 一律走 `/{nickname}/{title}`，标题省略时在**本地**按文档
默认值补上 `MeoW`，因此不会落到未文档化的单段 POST 路径。这样既保持在文档化路由上，也让请求
完全确定；「显式传 `MeoW`」与「省略路径 title」是否在服务端完全等价，官方文档并未声明，未实测。

## 3. 参数

### 路径参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `nickname` | 是 | 用户昵称，不含 `/` |
| `title` | 否 | 消息标题，省略时默认 `MeoW` |
| `msg` | GET 必填 | 消息内容（POST 时改为请求体字段） |

### 查询参数

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `url` | String | — | 跳转链接，需 URL 编码。CLI 另要求它是绝对的 `http(s)://` URL、不含空格或控制字符，并发送规范化后的 `href`（相对路径与其他 scheme 会被本地拒绝） |
| `imgUrl` | String | — | 通知图标 URL，建议 216×216 PNG，需 URL 编码。约束同 `url` |
| `msgType` | String | `text` | `text` 纯文本 / `html` 由 App 渲染 HTML |
| `htmlHeight` | Number | `200` | 仅在 `msgType=html` 时生效，单位像素。CLI 限定为 1..1000000，避免超大整数被序列化成 `1e+21` 这类指数形式 |

### CLI 的额外本地约束

这些不是接口要求，而是 CLI 为了让「预览 / 校验 / 实际发出」三者一致而加的：

- 昵称与标题不能是 `.` 或 `..`；`--method get` 时消息内容也不能。WHATWG URL 解析器会把这类
  路径段直接删掉（连 `%2E%2E` 也会被当成 `..`），否则预览显示的地址与实际请求的地址会不同。
- 取值以 `-` 开头时须写 `--flag=value`，否则解析器判定为「缺少取值」。这样
  `send --title --dry-run` 会报错，而不是把 `--dry-run` 当成标题去真实推送。
- `--timeout` 限定 1..4294967295 毫秒（`AbortSignal.timeout` 的上限）。超限属于本地参数错误，
  退出码 1，**不会**被误报成「结果不确定」。

`msgType` 与 `htmlHeight` **始终是查询参数**，不是 JSON 字段。这是最容易被写错的地方。

### POST 请求体

支持 `application/json`、`application/x-www-form-urlencoded`、`multipart/form-data`、
`text/plain`。

- JSON 只需 `msg`；表单与 multipart 的 schema 把 `title` 和 `msg` 都标为必填。
- `text/plain` 时请求体即消息原文，标题只能走路径，`url`/`imgUrl` 只能走查询串。
- 字段优先级：Body `title` > 路径 `title` > 默认 `MeoW`；
  Body `imgUrl` > 查询 `imgUrl`。

CLI 的 `--format json|form` 会同时发送路径标题与 body 标题（值相同），以兼容两种 schema。

## 4. 响应格式

**HTTP 状态码恒为 `200`**，业务结果只体现在 JSON 的 `status` 字段：

```json
{ "status": 200, "data": true, "msg": "发送成功" }
```

| `status` | 含义 | CLI 退出码 |
| --- | --- | --- |
| `200` | 操作成功 | 0 |
| `400` | 标题或消息参数错误 | 3 |
| `403` | 内容策略禁止发送（敏感词） | 3 |
| `404` | 昵称未注册 | 3 |
| `429` | 发送或 IP 频率超限 | 4 |
| `500` | 服务器错误 | 2 |

### 判定规则

注意：OpenAPI 的 `PushResult` schema 只正式声明了 `status` 与 `msg` 两个字段，`data` 只出现在
`examples` 中（成功示例为 `{"status":200,"data":true,"msg":"发送成功"}`）。因此 `data:true`
是**服务端已受理**的证据，而不是设备已收到通知的证据——连 API 根路径都会返回
`data:true` + 「发送成功」。CLI 的报告措辞遵守这个限度。

- `status === 200` 且 `data === true` → **服务端已受理**（且要求 HTTP 状态 < 400；
  若 HTTP 出现 4xx/5xx 却带着业务 `200`，说明响应可能来自中间层，判为不确定）。
- `status === 200` 但缺少 `data` 字段 → 按文档语义视为已受理，但标记 `confirmed: false`，
  措辞用「已提交」而非「已受理确认」。
- `status === 200` 且 `data === false` → 语义不一致（`data:false` 是 4xx 业务码的正常失败信封，
  200 却说失败），退出码 `5`，按失败处理且不要重发。
- 响应不是 JSON、不是对象（`[]`、`null`、`42`）、缺少 `status`、HTTP 层出现 3xx/5xx/429
  → 结果不确定（退出码 `2` / `4`），**不要自动重发**。
- `status` 与 `data` 为数字字符串或 `"true"` / `"false"` 字符串时按等价值解析，避免因序列化差异误判。

### 机器可读的失败原因

`--json` 输出的 `reason` 是稳定字段，用于区分同一退出码下的具体情形：
`business_400`、`business_403`、`business_404`、`business_429`、`business_500`、
`http_rate_limited`、`http_server_error`、`http_status_conflict`、`redirect_not_followed`、
`timeout`、`network_error`、`non_json_response`、`unrecognised_envelope`、
`missing_business_status`、`no_response_body`、`status_200_data_false`、
`success_without_data_field`。用法错误的输出只有 `outcome: "usage_error"`、`exitCode: 1`
和 `error`，不含 `envelope` / `confirmed`。

### 重定向

CLI 显式使用 `redirect: 'manual'`，**不跟随** 3xx：推送不可幂等，跟随 301/302/303 既可能重复
投递，也可能按规范把 POST 降级为 GET 而丢失请求体。收到 3xx 时以退出码 `2` +
`redirect_not_followed` 结束，并提示改用最终 API 地址。

## 5. 频率与 IP 限制

非会员上限：**3 秒 1 条、每分钟 15 条、每小时 60 条、每天 1000 条**，超出返回 `429`。

文档明确提示：不要通过多人共享的公共出口 IP 请求推送接口。同一 IP 向多个昵称发送推送
可能被判定为攻击行为；可信 IP 可联系开发者申请加入白名单。

实测：受限出口 IP 上，连 API 根路径都会返回
`{"status":429,"data":false,"msg":"IP限制，请联系开发者"}`。
`meow-push doctor --probe` 就是据此识别 IP 限制的。

应对方式只有「使用可信的独立 IP」或「申请白名单」——不要用代理或轮换出口绕过。

## 6. 已知不一致（实测优先）

| 来源 | 内容 | 采信 |
| --- | --- | --- |
| 页面示例（GET/POST 示例块） | `{"status":200,"message":"推送成功"}` | 否，字段名与真实响应不符 |
| 页面「响应格式」小节 | `{"status":状态码,"msg":"结果描述"}` | 部分：缺 `data` |
| 内嵌 OpenAPI 示例 | `{"status":200,"data":true,"msg":"发送成功"}` | 是 |
| 生产实测 | `{"status":429,"data":false,"msg":"IP限制，请联系开发者"}` | 是，权威 |

因此 CLI 同时接受 `msg` 与 `message` 两种字段名，并以 `data` 是否存在区分
「已受理且带确认字段」与「已受理但未带确认字段」。

## 7. 使用 CLI 构造请求

```bash
CLI="node /path/to/meow-skill/scripts/meow-push.mjs"

# 预览（零副作用）
$CLI preview --to JohnDoe --title 系统通知 --msg "构建已完成"

# 文本推送，机器可读结果
$CLI send --to JohnDoe --title 系统通知 --msg "构建已完成" --json

# HTML 推送 + 跳转链接 + 自定义图标
$CLI send --to JohnDoe --type html --html-height 300 \
  --title 系统通知 --msg '<b>有新消息</b>' \
  --url https://example.com --img-url https://example.com/icon.png --json

# GET 形式（内容进路径，仅适合短消息）
$CLI send --to JohnDoe --msg "hi" --method get --json

# schema：参数、退出码、业务码的机器可读描述
$CLI schema
```

### 生成的请求长什么样

```http
POST /JohnDoe/系统通知?msgType=html&htmlHeight=300 HTTP/1.1
Host: api.chuckfang.com
Accept: application/json
Content-Type: application/json; charset=utf-8

{"title":"系统通知","msg":"<b>有新消息</b>","url":"https://example.com"}
```

路径段与查询值都按 RFC 3986 unreserved 集合严格百分号编码（`encodeURIComponent` 保留的
`!'()*` 也会被转义），空格编码为 `%20` 而不是 `+`，避免部分解析器把 `+` 当成字面加号。
