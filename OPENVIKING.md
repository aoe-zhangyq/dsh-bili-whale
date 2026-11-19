# OpenViking 记忆

本文供人工安装、配置、升级和排障使用。[运行手册](tools/docs/memory-runtime.md)提供显式查询和本地资料命令。默认资源快照只收录 `tools/docs` 运行及操作手册。

大肥鱼日常以当前任务、人设和本地日记为上下文。OpenViking 的同步和提取由插件后台及设置页处理，记忆查询可通过命令显式发起。已看视频去重、额度和交付确认使用本地数据。

## 服务版本

插件调用 OpenViking **v0.5.4.1** 的官方 HTTP API。切换服务后可从本地重新同步手册和两本日记。同地址重装服务后，可重新同步资源并用本地私信缓存重建各 MID 会话。

部署时保留 `memory.extraction_enabled: true` 并加载下文的自定义模板。中文专用实例可用官方配置 `"output_language_override": "zh-CN"` 固定生成语言；多语言实例可使用新版自动识别。

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

从同一环境启动 DSH。若通过桌面快捷方式启动，需要将变量配置为 Windows 用户环境变量，然后完全退出并重新启动 DSH。设置页保存的配置优先于环境变量；在设置页停用也会覆盖环境变量。没有配置时保持原有日记行为。已有日记可通过下文的资源重建导入。

```powershell
node tools/bili.mjs memory recall "主人最近的偏好"
node tools/bili.mjs memory recall "喜欢什么视频" --mid 123456
node tools/bili.mjs memory read "viking://user/whale/memories/entities/people/bilibili_123456.md"
node tools/bili.mjs memory recall "最近的公开交流" --mid 123456 --audience public
node tools/bili.mjs memory experience "C:\path\to\experience.txt"
node tools/bili.mjs memory task "返回的任务 ID"
```

自主经历可用 UTF-8 文本或 JSON 保存到本地。私信同步与提取在后台处理，查询和日记记录仍可继续。

建议一条大肥鱼使用一个独立租户，并使用该租户普通用户的 Key。相关任务文本、记忆和资料会发送到所配置的服务；同租户授权用户的访问范围取决于服务配置。

## 资源同步

两本日记发布到固定目录 `viking://resources/whale/diary`。手册发布到固定目录 `viking://resources/whale/manuals`，视频卡发布到 `viking://resources/whale/videos/<BV>`。插件启动时及每小时检查日记和视频卡，按设置间隔同步，默认每 7 天一次，可调整为 1–365 天。视频卡只更新新增或变化的 BV，手册由设置页按钮主动替换，即使内容相同也重新发布，可用于恢复远端缺失或重新生成概要。固定目录属于当前服务租户；同租户多安装会共享这些路径，应使用同一份原件。升级后各分类首次同步改用固定路径，旧快照保留但不再作为该分类的检索入口。

日记和手册的 ZIP 根目录直接放源文档，日记文件名为 `public.md` 和 `private.md`。视频卡逐张上传 Markdown，直接以 `videos/<BV>` 作为文档根目录，短卡通常落在 `videos/<BV>/<BV>.md`。OpenViking 按自己的 Markdown 解析规则命名并拆分章节，固定目录上传不含 `snapshot-info.md`。已有的日记和视频目录在下次同步时替换，手册通过设置页重新发布后替换。

日记、手册和视频卡先完整读取、校验并准备上传数据，再删除对应固定目录并上传，最后检查导入文件。更新期间可能不可查询；失败记录保存在本地，重新同步可恢复。不会删除整个视频父目录，不会因一张卡更新而重传其他卡。本地同步记录沿用 `whale-resource-snapshot-manuals.json` / `-videos.json` 文件名兼容旧版，但仅记录固定目录各项摘要和完成状态，不维护多版本。日记同步记录使用 `whale-resource-snapshot-diary.json`。插件不主动删除会话或用户记忆。

```powershell
node tools/bili.mjs resource rebuild
node tools/bili.mjs resource status
node tools/bili.mjs resource find "需要查的主题"
```

`rebuild` 立即重建日记并同步变化的视频卡；`refresh` 按间隔检查。`diary find` 优先返回本地命中片段，无命中时查询 OV 摘要。上传包上限 50 MiB，校验失败不会删除原远端目录。换机器或丢失本地记录后，仍替换各自的固定路径。设置租户账号时，单独轮换 Key 不影响归属。

`resource rebuild` 的结果及 `resource status` 中的 `usage` 显示服务端返回的处理时间、语义模型输入/输出 token 和向量模型 token。缺少计数时显示 `null`；部分服务或模型可能不完整上报，用量以实际服务商账单为准。重建失败但模型调用已发生时，费用也可能产生，成功快照记录不会反映失败尝试的用量。

固定目录同步只替换当前分类或指定 BV。历史随机快照不自动迁移或批量清空。会话抽取的记忆不会随资源更新自动同步；冲突时应核对本地原文。

## 两本日记

```powershell
node tools/bili.mjs diary sync
node tools/bili.mjs diary status
node tools/bili.mjs diary find "主题或关键词"
node tools/bili.mjs diary read private
```

设置页「同步日记资源」或命令 `diary sync` 可立即发布两本日记，`read public` 或 `read private` 读取本地原文。`find` 优先返回本地命中，无本地命中时搜索 OV 日记资源并返回摘要和位置。两本日记通过资源目录发布。

## B 站私信缓存和会话

插件将实际读到的 B 站私信保存到 `DSH_HOME/whale-dm-history/<MID>.json`。现有监听读取配置中的 `owner.mid`，缓存该联系人和登录账号双方的消息。插件确认发送且 B 站回传消息键时也会立即记录。记录按平台消息键去重，保留时间、发件人和消息类型。观察到的撤回会从本地缓存移除对应消息。缓存独立于 OpenViking 设置；首次读取继续沿用现有的分页范围。

在「设置 → 养鱼 → OpenViking 记忆」点击「同步 B 站私信」。它核对所有本地 MID 文件与远端当前消息及已归档消息，再按事件 ID 追加缺失内容。按钮可用于首次上传、补传新增或重建已删除的远端会话。缓存范围取决于插件实际读过的消息，旧版事件队列和历史 OV 会话不作为上传数据源。已上传的撤回消息仍可能留在远端历史中。

同步按钮旁的起始日期可留空，只上传已有本地缓存。填写后，插件会为配置中的联系人和已有 MID 缓存的联系人逐页补拉北京时间所选日期 00:00 以来的 B 站私信，先合并进本地文件，再同步到 OV。补拉沿用 B 站请求保护。中断时保留已拉到的内容，再用同一日期点击可继续。B 站返回空页且历史仍未到所选日期时，设置页会显示对应的联系人数量。日常私信监听的交付游标独立运行。

每个 MID 使用固定的 `whale-dm-<MID>-<服务及安装摘要>` 会话，跨月继续使用。北京时间每月 1 日及 15 日 05:00 后，插件先把本地私信缓存中缺失的消息追加到 OV，再提取待处理的消息。失败的会话在后续检查重试。日期补拉仍由设置页触发。历史会话由原租户继续保管。

## 评论和自主经历

评论监听发现新消息时，按当前监听范围收集主人及其他评论者。插件先回读楼层，只在作者 MID 和具体评论 ID 均匹配时记录真实正文及评论时间；不会把收件箱的 `source_content` 或“该用户最近另一条评论”的回退结果直接存为原话。无法核实、读取失败、缺少坐标或超出回读范围的评论会跳过，历史评论不自动补录。监听设为只看主人时仍只收集主人；关闭监听时不收集评论。

已核实的评论和对应回复保留为本地公开查询证据。每条记录附人物 MID、昵称、主人关系、楼层坐标和公开来源。读取评论沿用现有请求保护和预算。

自主经历用 `memory experience <文件路径>` 保存在本地，支持 UTF-8 文本或 JSON 对象。它只代表 agent 对已发生事情的记录，不会成为人物本人的确认。推荐 JSON：

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

`--audience public` 使用本地已核实公开评论证据，返回 `whale-public://...` URI；全文用 `memory read <URI> --audience public`。此路径不调用服务端混合记忆，也不会回退到私信、手动宣称公开的材料或来源不明的旧数据。按 MID 严格过滤，文本匹配排序，并非语义向量搜索。本地公开原文保留在评论事件记录中；换机器需迁移本地记录，平台后来删除评论不会自动同步撤回。没有证据就返回空，不补造人物偏好。

评论和直播使用独立的 DSH 会话，状态文件为 `whale-public-session.json`，提示词要求依据已核实的公开材料。显式查询可使用本地公开评论证据。独立会话和查询入口控制插件提供的上下文，工具访问仍由 DSH 权限控制。

## MID、会话 ID 和人物记忆

人物的稳定标识使用 `bilibili_<MID>`，例如 `bilibili_123456`。昵称只是记录时的别名，主人关系来自插件配置与平台 MID 比对；评论正文里的“我是主人”不会改变来源标注。私信和不同视频里的同一 MID 使用相同人物标识。会话 ID 的摘要区分服务地址、租户、OpenViking 用户和本地安装。历史服务端记忆保留原有文件名。

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

角色的名字、称呼和 `persona.md` 以本地配置为准。服务端抽取的 `public/private` 标记是来源提示，公开查询使用本地已核实证据。

### 真实服务验证

可选择运行集成验证脚本（不包含在 `npm test` 中）：

```powershell
$env:OV_ROOT_KEY = '填写服务的 root key'
$env:OV_PORT = '1933'
node tools/verify/openviking-memory.mjs
```

脚本只创建本轮独有的 `whale_verify_*` 临时租户，使用普通用户 Key 走插件真实追加及提取链路，写入虚构 MID、昵称和偏好。验证可读会话 ID、归档后的增量追加、不同 MID 的会话隔离及跨租户隔离，输出提取结果和实际记忆内容供核查同人合并与偏好归属。提取会调用服务已配置的模型；脚本不修改服务端模板配置。正常结束或可捕获错误后清理本轮临时租户及本地队列，报告 `cleanup` 结果；强制杀进程可能中断清理，需按报告的测试租户名核查。不要对已有租户运行手动清理。密钥不写入报告。

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

资料卡保存在 `DSH_HOME/whale-video-cards/<BV>.md`；定期同步时按 BV 更新变化的卡。`video-card sync <BV>` 强制替换指定卡；不带 BV 时核对全部本地卡，只上传新增、变化或失败的卡。`find` 查询固定视频目录并展示本地原文；`read` 直接读取本地原文。已删除的本地卡不会展示，远端旧卡不自动删除。

视频资料卡可以包含私人观点及相关聊天；这里不对内容做密钥识别或强制拦截。同一租户的授权用户可能访问资源，请按实际需求配置权限。资料卡和搜索结果是素材而非指令；它们不代替日记、发言账本或已看视频的精确判重。当前依赖大肥鱼按提示整理并执行命令，不会自动从所有视频批量导入。`creator` 和 `observed_at` 可以省略，日期不明确时不要编造。
