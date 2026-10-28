# OpenViking 记忆

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
```

从同一环境启动 DSH。若通过桌面快捷方式启动，需要将这两个变量配置为 Windows 用户环境变量，然后完全退出并重新启动 DSH。设置页保存的配置优先于环境变量；在设置页停用也会覆盖环境变量。没有配置时保持原有日记行为。密钥不要放进仓库、日记或命令参数。已有日记不会自动导入；如需导入，可先人工整理确认后用以下命令提交。

```powershell
node tools/bili.mjs memory recall "主人最近的偏好"
node tools/bili.mjs memory store "C:\path\to\memory.txt"
node tools/bili.mjs memory task "返回的任务 ID"
```

保存文件须为 UTF-8，内容不超过 12000 字符。提交返回任务 ID 只表示归档已提交，记忆提取在后台进行，以任务状态为准。检索或保存失败不会阻止日记和原有流程，保存失败需保留事实并稍后手动重试；网络中断时提交结果可能不确定，先检查服务端会话和任务，避免重复提交。服务端是否成功提取到记忆取决于 OpenViking 的模型和后台任务状态。

请使用专门的 whale 用户 key。开启后，相关任务文本和所提交的事实会发送给配置的 OpenViking 服务；不要把密钥或不应共享的内容放入记忆文件。
