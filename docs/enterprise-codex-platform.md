# 企业级 Codex 统一分发平台 —— 分析与设计方案

> 目标：让公司所有员工都能用上 OpenAI Codex，但**只能通过公司提供的产品来用**；员工**离职后立刻失效**；公司还能**把自己的"技能/规范/工具"下发到员工的 Codex 上**。
>
> 本文先拆解你发的那段演示视频里的产品到底做了什么、和 `sub2api`（sub2 中转站）是什么关系，再给出可落地的架构与路线图。

---

## 1. 视频里那套东西到底是什么（功能拆解）

根据视频旁白，它由三层组成：

**① 服务端 —— 一个"中转站"（这层就是 sub2 那类东西）**
- 买一台远程服务器，办公网能直连它，它能访问 ChatGPT/OpenAI。
- 在这台服务器上用 **OAuth 登录**若干 ChatGPT/Codex 订阅账号（"做一个 OAuth 的登录"）。
- 把这些账号的能力**以 API 的方式分发出去**（"通过 API 的方式把它分配出来"）。
- 员工端登录 Codex 时选 **"Sign in with another way / 用其他方式登录"**，粘贴中转站签发的 **API Key**；
  在 `~/.codex` 里改两个文件：`auth.json` 放 **API Key**、`config.toml` 放 **Base URL**。有这两样 Codex 就能用了。

**② 客户端 —— 一个自研桌面 App（这层不是 sub2api，是他们自己套的壳）**
- 用**飞书（Lark）SSO** 登录客户端。
- 登录后**自动为你生成 API Key**，并**自动帮你把 Codex 装好**（"codex 都不必安装了"）。
- 点客户端里的"启动 Codex"时，**自动把 Key + Base URL 注入到 Codex 配置里**。员工什么都不用配，下载客户端→飞书登录→点启动，就能用，还不用操心网络。

**③ 管理后台 —— 服务端 Dashboard**
- 看每个同事的 **Token 用量**，还做了**排行榜**（谁用得多）。
- **离职联动**：员工在飞书被标为"离职"状态后，其访问被自动收回。

---

## 2. 它是不是"封装 sub2 中转站"？——结论

**部分是。访问/计费这一层就是 sub2 这类中转站；其余是他们在中转站之上自己套的客户端壳。**

| 视频里的功能 | 是否是 sub2api（中转站）本身提供 |
|---|---|
| 服务器池化 ChatGPT/Codex 的 OAuth 账号，签发 API Key + Base URL | ✅ 是——这正是中转站的核心 |
| Token 用量统计 / 按人排名 | ✅ 是——sub2api 有 token 级计费与统计 |
| 离职即失效（禁用某人的 Key） | ✅ 是——在网关侧禁用用户/Key 即可 |
| **飞书 SSO 桌面客户端**、自动签发 | ❌ 否——自研客户端，不属于 sub2api |
| **自动安装 Codex + 自动注入配置** | ❌ 否——客户端侧自动化，自研 |
| **飞书"离职"状态 → 自动收回访问** | ❌ 否——飞书 HR 与网关之间的自研打通 |
| **把"我的技能"下发到员工 Codex** | ❌ 否——需要客户端额外写 `AGENTS.md`/prompts/MCP |

一句话：**中转站白送你"离职即断"的一半（在网关把 Key 一禁，Codex 下次请求就 401）；而"一键给员工用 + 下发技能"的另一半完全在那个自研客户端里**——这正是你要自己造的部分。因为 Codex 的配置和"技能"都在客户端本地，**中转站永远无法下发技能**，能写 `config.toml` 的那个客户端，才是能顺手写你 `AGENTS.md` / `prompts/` / MCP 的载体。

> 说明：视频链接（Tencent Video）在本次运行环境的出网策略里被拦截，无法直接看画面；以上是根据你提供的旁白截图 + sub2api 源码/文档核实后的判断。若你能补几张界面截图，可进一步确认它用的中转站是不是**恰好是** sub2api（也可能是同类的 new-api / one-api / CRS）。

---

## 3. sub2api（sub2 中转站）是什么（已核实事实）

- 定位：自托管的 **AI API 网关 / 中转站**，把"AI 订阅额度分发管理"。技术栈 Go(Gin/Ent) + Vue3 + PostgreSQL + Redis，**LGPL-3.0**。
- 干的事：把多个**上游订阅/OAuth 账号**（ChatGPT/Codex、Claude、Grok/xAI、Antigravity，或原生 API Key）**池化**在一个 OpenAI/Anthropic 兼容端点后面，再**签发平台自己的 API Key（前缀 `sk-`）**分发给一堆终端用户。
- 附带：鉴权、**Token 级计费/余额**、每用户 + 每账号**并发限制**、限流、**粘性会话智能调度**（`session_id` 粘住同一上游账号，TTL≈3600s，健康度下降会"逃逸"换账号）、**分组隔离（groups）**、管理后台、内置支付（支付宝/微信/Stripe）。
- 对 Codex 是一等公民：网关暴露 OpenAI Responses 端点 `/v1/responses`、`/responses`、`/backend-api/codex/responses`、`/openai/v1/responses`，还有 Codex 风格的 **Responses WebSocket** 桥接；有 `force_codex_cli`、`forced_codex_instructions_template_file`（在网关侧给 Codex 注入顶层 instructions）等开关。
- **Nginx 反代必须加 `underscores_in_headers on;`**，否则 `session_id` 头被丢、多账号粘性会话会坏。
- **它纯粹是服务端网关**：**不会**向员工机器下发任何 Codex 配置、prompts、"技能"、MCP 或预配置 CLI。（经对抗式核验：SUPPORTED）
- **Simple Mode**：`RUN_MODE=simple`（生产需 `SIMPLE_MODE_CONFIRM=true`）隐藏 SaaS/计费，保留 Key 鉴权和并发控制——适合"内部团队共享、不收费"的场景。

---

## 4. 你的产品：两个平面（这是核心心智模型）

把需求拆成两个互相独立的平面，分别选型、分别加固：

### 平面 A —— 访问与计费（中转网关）
负责"谁能用、用多少、连哪个上游、怎么计费、怎么收回"。这层用现成网关即可。

### 平面 B —— 技能/配置分发（客户端 / 运行环境）
负责"帮员工装好 Codex、注入连接配置、下发你的技能/规范/MCP、并把访问锁死在你的产品里"。这层是你要自研的壳（视频里的客户端就是干这个）。

> **强制力真相**：平面 A（网关禁 Key）能保证"离职即失效"；但"**只能通过我的产品用**"这条，光靠网关做不到——因为 `~/.codex/config.toml` 是员工自己机器上的普通文件，可以被改成直连 `api.openai.com`。真正锁死需要**控制运行环境**（下面第 6 节分级）。

---

## 5. Codex 客户端接入的精确配置（你的客户端要自动写这些）

Codex CLI 读 `~/.codex/` 下的两个文件。你的客户端登录成功后自动写入即可：

`~/.codex/config.toml`：
```toml
model = "gpt-5-codex"          # 或 gpt-5 / 你网关支持的模型名
model_provider = "mycompany"

[model_providers.mycompany]
name = "MyCompany Gateway"
base_url = "https://gateway.mycompany.com/openai/v1"   # 指向你的中转站
wire_api = "responses"          # Codex 走 Responses API；中转站支持
env_key = "OPENAI_API_KEY"      # 注意：这里填的是"环境变量名"，不是密钥本身
# 可选：
# http_headers = { X-Company = "yes" }
# query_params = { }
```

密钥的存放（两种，任选其一，视频用的是第一种）：
1. **API Key 模式**：把 `sk-...` 放到 `~/.codex/auth.json`（就是 `codex login --api-key` / "用其他方式登录粘贴 Key" 写的文件），或注入 `OPENAI_API_KEY` 环境变量。→ 视频里"`auth.json` 放 Key、`config.toml` 放 Base URL"就是这条。
2. **env_key 模式**：`config.toml` 里 `env_key = "OPENAI_API_KEY"`，你的客户端启动 Codex 时把该环境变量设成签发的 Key。

> 细节修正（来自核验）：标准用法里 `config.toml` 只放 `base_url` + `env_key`（变量名），**真正的密钥在 `auth.json` 或环境变量**，不是明文写死在 `config.toml`。三者在员工自己机器上都可编辑——这也是为什么"锁死"要靠运行环境，见第 6 节。

---

## 6. "离职即失效" 与 "只能通过我的产品用" 的强制力分级

按强制力从弱到强，成本从低到高：

| 方案 | 怎么防员工绕过 | "离职即断"是否可靠 | 强制力 |
|---|---|---|---|
| **只有中转站 + 发 Key** | 防不住：员工能把 `base_url` 改成直连 OpenAI 用自己的 Key | 断你的 Key 可靠，但他可用自己的账号 | ★☆☆ |
| **中转站 + 自研客户端注入配置**（视频方案） | 默认走你，但技术型员工仍可手改 `config.toml` | 断 Key 后**你的**通道即失效 | ★★☆ |
| **中转站 + 短时效 Token（SSO 换取，几分钟过期）** | 会话几分钟就要凭 SSO 续期，离职后 SSO 一停会话很快死 | **强**：离职→SSO 失效→Token 无法续→分钟级断 | ★★★ |
| **托管运行环境 / 云端 IDE / devcontainer** | 员工只能在你控制的环境里跑 Codex，出网 + 配置都被你锁 | **最强**：删账号→无环境→无 Codex | ★★★★ |
| **公司统一设备 + MDM 托管 dotfiles** | 设备被管控，`~/.codex` 与出网策略由你下发/锁定 | 强，取决于 MDM 严格度 | ★★★★ |

**建议**：内部效率工具起步用"中转站 + 客户端注入 + 短时效 Token"（=视频方案 + 加一层 SSO 短 Token）即可，性价比最高；若涉及敏感代码、要"真正锁死不许外流"，上"**托管 devcontainer / 云端开发环境**"——这也是让"离职即断"绝对可靠的唯一形态（离职→环境没了）。

---

## 7. "给他们的 Codex 装我的技能" 怎么做

**先纠正一个概念**：Codex **没有** Claude Code 那种一等公民的 `skills/` 目录机制。Codex 里"技能/规范/工具"的等价物是三样，你的客户端把它们写到员工机器（或托管环境）即可，并集中管理更新：

1. **`AGENTS.md`（行为规范/技能说明）**——Codex 会读**项目根目录**的 `AGENTS.md` 和**全局 `~/.codex/AGENTS.md`**。把公司的编码规范、内部库用法、工作流"技能"写进去。这是最接近"给 Codex 装技能"的东西。
2. **自定义 prompts（≈ 斜杠命令/技能脚本）**——放 `~/.codex/prompts/*.md`，员工用 `/名字` 触发。把你封装的常用任务（如 `/写单测`、`/合规检查`）做成 prompt 下发。
3. **MCP Server（工具/数据接入）**——`config.toml` 里 `[mcp_servers.NAME]`（`command`/`args`/`env`，或远程 streamable-HTTP MCP）。这是"push 型"最佳载体：**技能逻辑放在你的 MCP 服务端**，员工端只连你的 MCP URL，**你在服务端改一次，所有人立即生效**，不用逐台更新文件。

**下发/更新机制**（你的客户端选其一或组合）：
- 客户端启动时从你的服务端**拉取最新** `AGENTS.md` + `prompts/`，覆盖写入 `~/.codex/`（简单，pull 型）。
- 用**公司 MCP 服务端**集中提供工具与 prompt（push 型，改一处全员生效，最推荐）。
- 托管环境里直接把这套 `~/.codex/` 作为基础镜像的一部分（最干净）。

---

## 8. 合规与风控（务必先看，涉及封号与法律）

三条经过对抗式核验、均 **SUPPORTED** 的结论：

1. **池化个人 ChatGPT/Codex 订阅账号再分发给他人 = 违反 OpenAI/Anthropic 服务条款，且有封号风险。** sub2api 自己的 README 都明确警告"可能违反上游提供商的服务条款""不对封号负责""未授权任何商业化"。OpenAI 条款禁止分享账号凭据、转售/分发服务；Anthropic 明确禁止把消费级 OAuth 凭据用于非第一方产品。视频里"在服务器上 OAuth 登录订阅号再分发"正是这个高风险动作。
2. **合规路径**：给中转网关喂**官方 API Key**——用**你公司自己的 OpenAI Platform API / Azure OpenAI**（按量计费、企业协议），网关只做**代理你自己的 Key**，而不是池化订阅号。这样"离职即断、用量统计、按人配额"这些你都能保留，且不违规、不担心封号。（注意：OpenAI 商务条款也禁止买卖/转移 API Key 给第三方——所以是"代理公司自有 Key/合同"，不是"转卖单个 Key 给多方"。）
3. **给员工看代码/prompt 会经过网关**：若要记录每人 prompt/补全做审计与排名，注意**隐私/合规**（尤其涉及员工个人数据与公司源码），需在制度与技术上明确留存范围与访问权限。

> 结论：**内部效率工具，强烈建议走"官方 API Key + 网关"这条合规路线**，而不是照搬视频里"池化订阅号"的做法。功能一样能做全，风险天差地别。

---

## 9. Build vs Buy（平面 A 网关选型）

| 选项 | 优点 | 缺点 | 适用 |
|---|---|---|---|
| **LiteLLM Proxy**（推荐给企业合规路线） | 开源活跃、原生支持 OpenAI/Azure/多家；虚拟 Key、每 Key 预算/限流/团队、用量看板、审计日志齐全；社区/商业支持 | 偏"官方 API Key 代理"，不做订阅号池化（对你反而是**优点**） | 企业内部、合规、要审计与配额 |
| **sub2api** | 视频同款，Codex/粘性会话/分组/内置支付开箱即用 | 主打**池化订阅号**（违规+封号风险高）、LGPL、作者声明无商业授权 | 想快速复刻视频、但要自担合规风险 |
| **one-api / new-api / veloera** | 中文生态成熟、渠道管理/令牌/额度完善 | 同样偏中转/转售形态，合规需自审 | 已有中文中转经验的团队 |
| **自研最小代理** | 完全可控、只做你要的鉴权+转发+计量 | 从零造轮子，粘性会话/计费要自己实现 | 需求很定制、团队有余力 |

**推荐**：企业内部工具 → **LiteLLM（喂公司自有 OpenAI/Azure Key）** 做平面 A；平面 B 的客户端/技能分发自研。既拿到视频里的全部管理能力，又避开订阅号池化的封号与法律风险。

---

## 10. 推荐参考架构（合规版）

```
员工设备 / 托管devcontainer
  └─ 你的客户端(壳)  ──飞书/企业微信 SSO(OIDC)──►  身份服务(IdP)
        │  1) SSO 通过后向 [Key 服务] 换取"每人一枚、短时效"的网关Key
        │  2) 自动安装/内置 Codex，写入 ~/.codex/config.toml(base_url=你的网关) + auth.json(Key)
        │  3) 拉取/挂载 你的技能：AGENTS.md + prompts/ + 连接公司 MCP
        ▼
  Codex CLI ──Authorization: Bearer <短时效Key>──►  [AI 网关 / LiteLLM]
                                                     │  鉴权→映射到员工身份
                                                     │  每人预算/并发/限流；记录 token 用量
                                                     │  转发到 ▼（用公司自有官方 Key）
                                                     ▼
                                            OpenAI Platform API / Azure OpenAI
  管理后台 ◄── 用量/排名/审计 ── [网关 + 日志/度量存储]
  HR系统(飞书) ── 离职Webhook ──► [Key 服务] 立即吊销该员工所有Key + 停止SSO续期
  公司 MCP 服务端 ◄── Codex 拉取工具/prompt（push型技能，改一处全员生效）
```

关键组件：IdP/SSO（OIDC，接飞书/企业微信）、Key 服务（签发短时效 Key、映射人↔Key、吊销）、AI 网关（LiteLLM）、审计/度量存储、技能仓库或公司 MCP、客户端/托管环境（分发与注入）。

---

## 11. 分阶段落地路线图

**MVP（1–2 周，验证闭环）**
- 起一个 LiteLLM，喂公司自有 OpenAI/Azure Key；给每个员工手发一枚虚拟 Key + Base URL。
- 写一份 SOP（改 `config.toml`/`auth.json`）先让种子用户跑通 Codex。
- 后台能看每人 token 用量。→ 打通"访问 + 计费 + 可吊销"。

**v1（客户端 + SSO + 技能，复刻视频体验）**
- 自研桌面客户端：飞书 SSO 登录 → 调 Key 服务自动签发**短时效** Key → 自动装 Codex、注入 `config.toml`/`auth.json` → 一键启动。
- 下发技能：客户端写入 `~/.codex/AGENTS.md` + `prompts/`，并配好连接**公司 MCP**。
- 飞书离职 Webhook → 自动吊销该员工全部 Key（离职即断）。
- 后台做用量排行榜。

**加固版（锁死 + 合规 + 审计）**
- 对敏感代码团队：改为**托管 devcontainer / 云端 IDE**，Codex 只在你控制的环境里跑（真正"只能通过我的产品用"）。
- 短时效 Token + SSO 续期，出网白名单，审计留存与访问控制，密钥集中托管（KMS/Secrets Manager）。
- 法务复核数据留存与员工隐私边界。

---

## 12. 需要你拍板的关键决策

1. **合规路线**：走"公司官方 API Key + 网关"（推荐，无封号风险）还是照搬视频"池化订阅号"（省钱但违规+可能封号）？
2. **强制力级别**：接受"默认走你、技术员工可绕过"（客户端注入），还是要"真正锁死"（托管 devcontainer）？后者成本高但离职即断绝对可靠。
3. **SSO 来源**：飞书 / 企业微信 / 其他 OIDC？
4. **技能载体**：以 `AGENTS.md`+`prompts` 文件下发为主，还是以**公司 MCP**为主（推荐，集中可控）？
5. **是否自建后台**还是直接用 LiteLLM 自带的用量/审计看板起步。

---

*本文档为分析与设计稿；如需，我可以按第 11 节的 MVP 直接在本仓库里搭出可运行的骨架（LiteLLM 配置 + 客户端注入脚本 + 飞书离职吊销 Webhook + 一套示例 AGENTS.md/prompts/MCP）。*
