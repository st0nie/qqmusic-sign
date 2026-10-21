# qqmusic-sign

把 QQ 音乐官网的下载链接签名（`sign`）做成 HTTP API，单文件 Cloudflare Worker，零运行时依赖。

## 背景：sign 是什么

官方下载页 <https://y.qq.com/download/index.html> 的链接形如：

```text
https://c.y.qq.com/cgi-bin/file_redirect.fcg?bid=dldir&file=<文件路径>&sign=1-<64位hex>-<8位hex>
```

- `1-<64位hex>-<8位hex>` 由 QQ 音乐**服务端签发**，`64位hex` 是与文件路径绑定的密钥签名，
  末尾 8 位 hex 是 Unix 时间戳（签发时间）。
- 实测：把 A 文件的 sign 用到 B 文件会被拒绝（403），文件路径不存在也会 403，
  所以 **sign 无法在本地推导，只能从官方发布的数据里取**。
- 官方 `https://y.qq.com/download/download.js` 是一个 JSONP 静态文件，里面已经带有每个平台的
  完整带 sign 链接。本服务抓取并解析它，按文件路径查询。

## 快速开始

```bash
bun install                 # 可选，wrangler 用 bunx 直接跑
bunx wrangler dev           # 本地 http://127.0.0.1:8787
bunx wrangler deploy        # 发布到 Cloudflare Workers
```

`wrangler.toml` 已配置好 `main = "src/index.ts"`，无需构建步骤；登录用 `bunx wrangler login`
或设置 `CLOUDFLARE_API_TOKEN`。

也可以直接交给任何支持 ES module worker 的运行时（Deno Deploy 等），入口是
`src/index.ts` 的 `export default { fetch }`。

## 在线服务

已部署在 <https://qqmusic-sign.qqmusic-sign-worker.workers.dev>。中国大陆网络可能无法直连
`workers.dev`，访问不了时走代理。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 服务说明和可用接口 |
| GET | `/health` | 存活探针，不访问上游 |
| GET | `/api/downloads` | 所有平台及全部下载链接（含已签名和直链） |
| GET | `/api/sign?file=…` | 查询单个文件的 `sign` |
| GET | `/api/url?file=…` | 查询完整带签名的 `file_redirect.fcg` 链接 |
| GET | `/<官方 URL>` | 保留官方 URL，补上 `sign` 后 302（Gentoo ebuild 用） |

`/sign`、`/url`、`/downloads` 是不带 `/api` 前缀的别名。

### 参数

- `file=` 接受四种写法，均可：
  - 完整路径：`ecosfile_plink/music_clntupate/linux/other/qqmusic_1.1.8_amd64.deb`
  - 路径后缀：`linux/other/qqmusic_1.1.8_amd64.deb`
  - 纯文件名：`qqmusic_1.1.8_amd64.deb`
  - 完整 URL（URL-encode 后传入），带不带 sign 都行
- `url=` 同 `file=`；如果传入的 URL 自带 `sign`，直接返回，**不会访问上游**。
- `format=text`（或 `raw=1`）：只返回纯文本 sign / URL，方便 shell 使用。
- `verify=1`：额外 `HEAD` 请求一次签名链接，返回是否被接受（`302` 为有效）。
- `follow=1`（仅 `/api/url`）：跟随 `302` 解析出最终 CDN 地址（`dldir.y.qq.com/...`）。
- `refresh=1`：跳过 30 分钟缓存，重新读取 `download.js`。

### 示例

```bash
# 只要 sign
curl 'http://127.0.0.1:8787/api/sign?file=qqmusic_1.1.8_amd64.deb&format=text'
# 1-d1ca4d5c5a8369b26af88e881ba3ac544066a899dcaea29778b35c9f648e6fee-68cb7c1c

# 完整 JSON
curl 'http://127.0.0.1:8787/api/sign?file=qqmusic_1.1.8_amd64.deb'
```

```json
{
  "ok": true,
  "query": "qqmusic_1.1.8_amd64.deb",
  "source": "y.qq.com/download/download.js",
  "cached": true,
  "stale": false,
  "file": "ecosfile_plink/music_clntupate/linux/other/qqmusic_1.1.8_amd64.deb",
  "bid": "dldir",
  "sign": "1-d1ca4d5c5a8369b26af88e881ba3ac544066a899dcaea29778b35c9f648e6fee-68cb7c1c",
  "url": "https://c.y.qq.com/cgi-bin/file_redirect.fcg?bid=dldir&file=ecosfile_plink%2Fmusic_clntupate%2Flinux%2Fother%2Fqqmusic_1.1.8_amd64.deb&sign=1-d1ca4d5c5a8369b26af88e881ba3ac544066a899dcaea29778b35c9f648e6fee-68cb7c1c",
  "platform": "Linux",
  "version": "1.1.8",
  "versionLabel": "最新版:1.1.8",
  "releaseDate": "2025-09-18",
  "signVersion": 1,
  "signIssuedAt": "2025-09-18T03:27:24.000Z",
  "signIssuedAtUnix": 1758166044
}
```

直接拿到可下载的最终地址：

```bash
curl 'http://127.0.0.1:8787/api/url?file=qqmusic_1.1.8_amd64.deb&follow=1&format=text'
# https://dldir.y.qq.com/ecosfile_plink/music_clntupate/linux/other/qqmusic_1.1.8_amd64.deb?sign=...
```

### 镜像式补签（Gentoo ebuild 用）

保留完整官方 URL 作为路径，服务只补 `sign` 并 302，下载文件不经过本服务：

```bash
curl -sSI 'https://qqmusic-sign.qqmusic-sign-worker.workers.dev/https://c.y.qq.com/cgi-bin/file_redirect.fcg?bid=dldir&file=ecosfile_plink%2Fmusic_clntupate%2Flinux%2Fother%2Fqqmusic_1.1.8_amd64.deb'
# location: https://c.y.qq.com/cgi-bin/file_redirect.fcg?...&sign=1-...
```

`media-sound/qqmusic` 的 ebuild 这样使用（见 [PR #15228](https://github.com/gentoo-zh/overlay/pull/15228)）：

```bash
qqmusic_src_uri() {
	printf "https://qqmusic-sign.qqmusic-sign-worker.workers.dev/"
	printf "https://c.y.qq.com/cgi-bin/file_redirect.fcg?bid=dldir&file=ecosfile_plink%%2Fmusic_clntupate%%2Flinux%%2Fother%%2Fqqmusic_${PV}_amd64.deb"
	printf " -> ${P}_amd64.deb"
}
SRC_URI="$(qqmusic_src_uri)"
```

### 错误格式

```json
{
  "ok": false,
  "error": {
    "code": "not_found",
    "message": "No signed download link matches \"…\".",
    "details": { "file": "…", "knownFiles": ["…"] }
  }
}
```

常见状态码：`400 missing_file`、`404 not_found`、`405 method_not_allowed`、
`409 ambiguous_match`（模糊匹配到多个文件，`details.candidates` 给出候选）、
`502 upstream_*` / `redirect_failed`。

## 缓存

- 进程内 + Workers Cache API：`download.js` 解析结果缓存 **30 分钟**；
  `refresh=1` 可强制刷新。
- 上游 CDN：请求带 `cf.cacheTtl=60`，同一边缘节点 60 秒内不会重复回源。
- 容灾：上游不可用时，最多继续使用 **7 天**内的旧缓存，并在响应里标记 `"stale": true`
  （响应头 `x-catalog-cache: stale`）。
- `/api/sign`、`/api/url` 成功响应 `Cache-Control: public, max-age=300`，错误响应 `no-store`。

## 测试

```bash
bun test test/worker.test.ts   # 离线单测（固定 JSONP fixture，26 个用例）
bun test test/live.test.ts     # 真实请求 y.qq.com / c.y.qq.com
```

已用真实 Worker 运行时（`bunx wrangler dev`）验证：`/api/sign`、`/api/url?follow=1`、
镜像式补签、`format=text`、`HEAD`、CORS 预检、404 与缓存头均正常。

## 说明

- 只能查询 QQ 音乐官网已经公布的下载文件；官网没有公布的路径无法生成 sign。
- `download.js` 的签名长期有效（Linux 1.1.8 的 sign 签发于 2025-09-18，至今仍返回 302），
  但链接一旦过期或被替换，本服务会随上游更新而更新。
