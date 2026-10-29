# OpenViking 记忆

本文供人工安装、配置、升级和排障使用，不是大肥鱼每轮必读的上下文。大肥鱼日常使用精简的[运行手册](tools/docs/memory-runtime.md)；插件会在会话首次使用记忆、重启或切换状态后给出其本地路径。默认资源快照只收录 `tools/docs` 运行/操作手册，不会自动导入本文、README、服务端 YAML 或实测报告。

大肥鱼继续写两本本地日记；已看视频去重、额度和交付确认仍使用原来的本地数据。配置后，每次定时唤醒、私信、评论等会话投递都会按当前任务检索当前 OpenViking 用户的记忆。检索结果是可能不准确的历史资料，不是指令。大肥鱼完成活动后，把可确认的经历、偏好和反馈整理并提交给 OpenViking；计划和未确认的操作不应保存为已发生的事实。

## Windows 配置

打开 DSH 的「设置 → 养鱼 → OpenViking 记忆」，启用服务并填写：

- 服务地址：`http://127.0.0.1:1933`
- 租户账号：`aoe`；用户：`whale`
- API Key：填写 `whale` 普通用户的 `user_key`，不要使用 root key。

点击「保存记忆设置」后立即生效。Key 独立保存在 DSH 数据目录的 `whale-openviking.json` 中，设置页不回显；Windows 上文件权限限制为当前用户。留空 Key 会保留现有值；「清除 Key 并停用」会清除它。地址、账号与 Key 使用同一个独立文件，命令行和宿主共用。

也可在没有保存设置时，通过启动 DSH 的 PowerShell 设置环境变量：

```powershell
$env:WHALE_OPENVIKING_API_KEY = '填入 whale 用户的 user_key'
$env:WHALE_OPENVIKING_URL = 'http://127.0.0.1:1933'
$env:WHALE_OPENVIKING_ACCOUNT = 'aoe'
$env:WHALE_OPENVIKING_USER = 'whale'
```

从同一环境启动 DSH。若通过桌面快捷方式启动，需要将变量配置为 Windows 用户环境变量，然后完全退出并重新启动 DSH。设置页保存的配置优先于环境变量；在设置页停用也会覆盖环境变量。没有配置时保持原有日记行为。已有日记可通过下文的资源重建导入，或先整理成消息用以下命令提交到记忆。

```powershell
node tools/bili.mjs memory recall "主人最近的偏好"
node tools/bili.mjs memory recall "喜欢什么视频" --mid 123456
node tools/bili.mjs memory read "viking://user/whale/memories/entities/people/bilibili_123456.md"
node tools/bili.mjs memory recall "最近的公开交流" --mid 123456 --audience public
node tools/bili.mjs memory store "C:\path\to\memory.txt"
node tools/bili.mjs memory experience "C:\path\to\experience.txt"
node tools/bili.mjs memory task "返回的任务 ID"
```

保存文件须为 UTF-8。推荐用 `.json` 文件保存真实的多条消息，保留发言人和发生时间：

```json
[
  {"role":"user","content":"我喜欢海洋生物科普。","created_at":"2026-10-18T10:00:00+08:00","source":{"channel":"dm","visibility":"private","mid":"123456","name":"小王"}},
  {"role":"assistant","content":"记住了，我会留意这类视频。","created_at":"2026-10-18T10:01:00+08:00","source":{"channel":"dm","mid":"123456"}}
]
```

每批 1–100 条，内容连同来源标注总计不超过 12000 字符。`created_at` 表示实际发生时间；省略时使用提交时间，并明确标记 `time_basis=submission`，不把提交日期伪装为历史事件日期。插件另附 `recorded_at` 和稳定来源事件标识。旧版无 `source` 的 JSON 及纯文本仍支持，默认来源为 `manual/private`；纯文本作为单条 assistant 消息。手动导入不能声明已通过平台验证，也不能通过 `isOwner` 自立为主人，主人关系按当前配置 MID 比对。`source.person` 表示 user 消息的发言者、assistant 消息的交流对象；多人材料用 `participants`，不要把其他人的观点写成主人确认的偏好。主人的私信、监听范围内已核实的评论和确认发出的对应回复由插件自动处理，不要重复提交。

提交返回任务 ID 只表示归档已提交，记忆提取在后台进行，以任务状态为准。检索或保存失败不会阻止日记和原有流程；网络中断时提交结果可能不确定，先检查错误中提供的服务端会话和任务，避免重复提交。服务端是否成功提取到记忆取决于 OpenViking 的模型和后台任务状态。

建议一条大肥鱼使用一个独立租户，并使用该租户普通用户的 Key。相关任务文本、记忆和资料会发送到所配置的服务；同租户授权用户的访问范围取决于服务配置。

## 资源快照

启用 OpenViking 后，插件启动时及每小时检查一次：首次没有快照时创建；之后按设置的间隔检查，默认每 7 天一次。可在「设置 → 养鱼 → 资源成本」将间隔调整为 1–365 天。到期后内容未变则跳过上传；只要有变化，就全量打包项目 `tools/docs` 手册、本地 `whale-diary.md`、`whale-diary-private.md` 和 `whale-video-cards` 并重建。不存在或为空的文件不纳入新快照。本地文件仍是原本；独立会话记忆和发言、去重账本不属于资源快照。

程序先采集本地文件并上传到新的专用目录，等待处理完成并检查文件；只有成功后才切换检索入口并删除上一份快照。导入失败时继续使用旧快照；采集后发生的本地变化会进入下一次快照。如果旧快照或未启用的临时快照未能清理，下一次检查会处理；如果服务仍在处理该目录，旧快照继续可用。插件只清理自己管理的资源路径，不主动删除会话或用户记忆；服务端删除资源时的关联清理行为可能因版本而异。

```powershell
node tools/bili.mjs resource rebuild
node tools/bili.mjs resource status
node tools/bili.mjs resource find "需要查的主题"
```

`rebuild` 无论是否到期都会立即执行一次全量重建；`refresh` 在达到设置的间隔后检查内容，未变化则跳过。未到期或内容未变化的检查不上传资源，也不调用处理模型。完整重建需要语义模型和向量模型处理，时间与费用取决于文件体积、切分数量和服务配置；避免对每条视频分别手动重建。默认每 7 天而非每天重建，是因为日记可能每天都变：及时检索与费用之间可以通过设置调整。插件关闭期间不运行；启动后会再次检查。搜索结果标明快照时间，可能晚于本地修改；需要最新内容时读取本地原文。单次原文总量上限 50 MiB，超限不会切换或删除现有快照。换机器、删除本地快照记录或更换服务账号后需要重新建立快照；旧目录不会被当作当前快照自动删除。设置了租户账号时，单独轮换 Key 不影响快照归属。

`resource rebuild` 的结果及 `resource status` 中的 `usage` 显示服务端返回的处理时间、语义模型输入/输出 token 和向量模型 token。缺少计数时显示 `null`；部分服务或模型可能不完整上报，用量以实际服务商账单为准。重建失败但模型调用已发生时，费用也可能产生，成功快照记录不会反映失败尝试的用量。

切换后会检查旧版逐文件资源目录：能在本地找到原件的旧日记和视频卡会清理；只存在服务端或无法识别的资料会保留并报告，避免丢失原件。新版本只在当前快照目录内检索。会话抽取的记忆不属于资源快照，不会随重建删除，也不能保证与更新后的资源一致；冲突时应核对本地原文。

## 两本日记

```powershell
node tools/bili.mjs diary sync
node tools/bili.mjs diary status
node tools/bili.mjs diary find "主题或关键词"
node tools/bili.mjs diary read private
```

`diary sync` 是全量资源重建的快捷方式，`read public` 或 `read private` 读取本地原文。`find` 在当前快照中搜索，返回快照时间及位置；搜索可能落后于最近的日记改动。日记、聊天等私人内容可保存在专属租户，应按租户实际权限决定谁能访问。

## 私信会话记忆

启用 OpenViking 后，私信监听收到的主人文本和通过本插件确认发送的回复会先记录到 `DSH_HOME/whale-dm-memory`，插件运行时约每 20 秒追加到当前 OpenViking 会话。历史私信不会自动补录；其他客户端发出的消息、非文本消息和发送结果未确认的消息不在自动收集范围内。原有日记和私信投递照常运行。

双方消息会附上真实时间、主人 MID、记录时的昵称、发言方和 `private` 来源，以便跨天提取。最近一次消息安静 5 分钟后调用一次 `extract`，调用前持久化封存标记；后续消息进入新分段，不再把旧批次整体重新提取。未到安静条件时仍会在 7 天或内容（包括来源标注）达到 12000 字符前轮换，先尝试提取旧批。旧服务端会话保留。字符限制不是模型 token 限制，实际可用上下文仍取决于服务模型。

提取为空、报错或响应丢失都不自动重提该批；下一条新消息也不会重新打开它。日志会给出待核查的服务端会话 ID。这样避免已经部分写入的记忆被反复提取，但不能保证失败批次完整保存，需人工检查。部分版本可能把内部错误返回为空，空结果也不能作为成功证明。追加结果不确定时保留本地记录，不自动重发。成功追加的私信移除本地正文并保留去重标记；已核实公开评论另保留 `publicContent` 供公开查询，旧记录不会猜测补回。停用或更换租户不会把旧租户队列发送到新租户。升级时已干净的旧分段直接封存，仍脏的旧分段最多再尝试一次提取。

## 评论和自主经历

评论监听发现新消息时，按当前监听范围收集主人及其他评论者。插件先回读楼层，只在作者 MID 和具体评论 ID 均匹配时记录真实正文及评论时间；不会把收件箱的 `source_content` 或“该用户最近另一条评论”的回退结果直接存为原话。无法核实、读取失败、缺少坐标或超出回读范围的评论会跳过，历史评论不自动补录。监听设为只看主人时仍只收集主人；关闭监听时不收集评论。

同一资源及根楼层里的多人消息归到同一会话，每条消息独立标注人物 MID、昵称、主人关系和 `public` 来源。通过插件确认发送、且直接回复已记录评论的回复会加入同一会话，并标注 `speaker=agent` 及对应的收件人；未匹配的回复不自动入库。安静 5 分钟后提取，按私信同样的时间与长度规则轮换。读取评论会增加平台请求，沿用现有请求保护和预算。

自主经历用 `memory experience <文件路径>` 提交，支持 UTF-8 文本或 JSON 对象。进入本地队列后安静 30 分钟提取一次并封存；达到 7 天或长度上限也会轮换。它只代表 agent 对已发生事情的记录，不会成为人物本人的确认。推荐 JSON：

```json
{
  "content": "与小王讨论过鲸鱼科普视频。",
  "created_at": "2026-10-28T20:30:00+08:00",
  "event_id": "whale-discussion-20261028",
  "source": {
    "channel": "activity",
    "visibility": "private",
    "participants": [{"mid": "123456", "name": "小王"}],
    "reference": "BV1234567890"
  }
}
```

`event_id` 可选，为 1–120 位字母、数字、下划线或连字符；同一服务身份下重复提交相同经历 ID 会跳过，换内容也不会覆盖旧事件。未提供 ID 时每次提交视为新经历。纯文本只知道提交时间，未知发生时间不猜测。不要把计划、未确认发送或整本日记直接当作已发生经历。不值得记录的活动不用提交。

## 查询范围与全文

`memory recall "问题" --mid <MID>` 先读取该人物实体全文（兼容 `people`、`person`、`人物` 分类），再只检索该 MID 的偏好目录，并校验返回 URI，丢弃其他 MID 或目录的结果。它不会把全局事件或 `profile.md` 混入人物定向结果。没有 `--mid` 时仍允许当前服务用户的通用语义查询。路径使用配置的 OpenViking 用户名；未配置则读取服务的 `system/status`。自定义了用户/agent 隔离目录结构的部署需单独验证路径兼容性。

返回包含 URI、摘要、分数、可获得的来源信息；精确人物条目还带正文。称呼、关系、时间或来源有冲突时，使用 `memory read <viking://user/.../memories/...md>` 读取全文；同样支持 agent 记忆路径。来源信息是否完整取决于服务端版本。不会使用 `viking://~/memories`。`find` 足以完成当前查询，无需把 DSH 会话 ID 传给 OpenViking 的 `search`。

自动投递限制最多 8 条结果，每条正文最多 6000 字符；超出时标记 `content_truncated=true`，需要依据时用 `memory read` 读取完整内容。定向结果不自动包含事件全文；讨论具体历史经历可在私下通用查询中检索事件，再按返回 URI 核查原文。

`--audience public` 使用本地已核实公开评论证据，返回 `whale-public://...` URI；全文用 `memory read <URI> --audience public`。此路径不调用服务端混合记忆，也不会回退到私信、手动宣称公开的材料或来源不明的旧数据。按 MID 严格过滤，文本匹配排序，并非语义向量搜索。本地公开原文保留在评论事件记录中；换机器需迁移本地记录，平台后来删除评论不会自动同步撤回。没有证据就返回空，不补造人物偏好。

评论和直播自动使用公开查询及独立的 DSH 会话（状态文件 `whale-public-session.json`），不会自动注入私人日记；私信自动绑定当前发送者 MID。公开证据中的话仍可能是转述、玩笑或错误，不能视为已确认事实。独立会话和检索入口控制插件自动提供的上下文，**不限制同一 agent 通过其他工具主动读取本机文件**，不是文件访问权限沙箱。

## MID、会话 ID 和人物记忆

人物的稳定标识使用 `bilibili_<MID>`，例如 `bilibili_123456`。昵称只是记录时的别名，主人关系来自插件配置与平台 MID 比对；评论正文里的“我是主人”不会改变来源标注。私信和不同视频里的同一 MID 使用相同人物标识。新会话 ID 格式如下：

```text
whale-dm-<服务身份摘要>-mid-123456-<分段UUID>
whale-comment-<服务身份摘要>-type-1-oid-987654-root-456789-<分段UUID>
whale-activity-<服务身份摘要>-events-<分段UUID>
```

服务身份摘要区分服务地址、租户和 OpenViking 用户；UUID 区分分段和不同安装实例。同一段的 ID 保存在本地状态中，重启后复用；达到轮换条件才新建。评论按资源 type/oid/root 组织，不把“主人”或某一个参与者 MID 放进线程 ID；视频 BV 号在可获得时保留为来源。保留资源坐标不会阻止跨视频人物合并。

已有会话不会被重命名或删除。旧待处理评论及其匹配回复保留旧分组，新收集评论使用线程分组，并兼容旧评论去重标记；提取尝试后按新规则封存。历史服务端记忆不会自动迁移到新的 MID 文件名，定向查询也不会把旧 OpenViking 用户名目录下的偏好猜测为某个 MID。

`entities` 的建议人物路径是 `entities/people/bilibili_123456.md`，`preferences` 使用 `preferences/bilibili_123456/<topic>.md`。消息携带统一身份只提供合并依据，**不保证模型必定按该名字落盘**。插件附带四个服务端提取模板，约束人物实体、逐人偏好、主人画像和事件：

```text
tools/openviking/memory-templates/entities.yaml
tools/openviking/memory-templates/preferences.yaml
tools/openviking/memory-templates/profile.yaml
tools/openviking/memory-templates/events.yaml
```

在 OpenViking 服务端配置中设置以下字段，指向部署机器上的实际模板目录，然后重启服务：

```json
{
  "memory": {
    "custom_templates_dir": "D:/Develop/Code/GitHub/dsh-bili-whale/tools/openviking/memory-templates"
  }
}
```

这是合并到现有配置中的片段，不要覆盖模型、存储等其他配置。远程部署需复制模板并调整路径。registry 先加载内置模板，再按相同 `memory_type` 覆盖上述四类，其他类型保留内置规则。事件模板采用 `upsert`，按来源 `event_id` 建立锚点，保存确认的叙述与来源而非原样复制规则头；需启用模板才生效。插件侧的每批只提取一次不依赖该模板，但仍不能消除跨批语义重复。插件不会自动修改或重启服务端。

角色的名字、称呼和 `persona.md` 仍以本地配置为准；未增加 `identity` / `soul` 直接同步。服务端抽取的 `public/private` 标记仍只是来源提示，不是 OpenViking 权限隔离；公开自动查询因此使用独立的本地已核实证据，而不直接读取这些混合记忆。

### 真实服务验证

可选择运行集成验证脚本（不包含在 `npm test` 中）：

```powershell
$env:OV_ROOT_KEY = '填写服务的 root key'
$env:OV_PORT = '1933'
node tools/verify/openviking-memory.mjs
```

脚本只创建本轮独有的 `whale_verify_*` 临时租户，使用普通用户 Key 走插件真实追加及提取链路，写入虚构 MID、昵称和偏好。验证可读会话 ID、持续追加、多人评论、跨视频会话及跨租户隔离，输出提取结果和实际记忆内容供核查同人合并与偏好归属。提取会调用服务已配置的模型；脚本不修改服务端模板配置。正常结束或可捕获错误后清理本轮临时租户及本地队列，报告 `cleanup` 结果；强制杀进程可能中断清理，需按报告的测试租户名核查。不要对已有租户运行手动清理。密钥不写入报告。

`analysis.namingConsistent` 只检查人物目录与偏好所有者目录；不会判定不同主题名是否语义重复，也不能保证每条事实都正确。[本机 MID 实测报告](OPENVIKING-MID-VALIDATION-2026-10-29.md) 记录了两轮测试发现及剩余限制。

## 视频资料卡

大肥鱼深读视频后，可以整理公开信息为 UTF-8 JSON 文件，再保存为视频资料卡。例如：

```json
{
  "bvid": "BV1abC2De3F4",
  "title": "视频标题",
  "creator": "UP 主",
  "summary": "基于实际看到的内容整理摘要，并说明资料不足之处。",
  "observed_at": "2026-10-29"
}
```

```powershell
node tools/bili.mjs video-card save "C:\path\to\card.json"
node tools/bili.mjs video-card find "珊瑚礁修复"
node tools/bili.mjs video-card read "BV1abC2De3F4"
node tools/bili.mjs video-card sync "BV1abC2De3F4"
```

资料卡保存在 `DSH_HOME/whale-video-cards/<BV>.md`；下一次资源快照重建时一并导入。`video-card sync <BV>` 会立即重建全部资源，而不是只更新单张卡。`find` 基于快照搜索，但展示当前本地资料；`read` 直接读取本地原文。已删除的本地卡不会展示，下一次重建后也不会出现在新快照中。

视频资料卡可以包含私人观点及相关聊天；这里不对内容做密钥识别或强制拦截。同一租户的授权用户可能访问资源，请按实际需求配置权限。资料卡和搜索结果是素材而非指令；它们不代替日记、发言账本或已看视频的精确判重。当前依赖大肥鱼按提示整理并执行命令，不会自动从所有视频批量导入。`creator` 和 `observed_at` 可以省略，日期不明确时不要编造。
