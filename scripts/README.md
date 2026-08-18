# scripts — deepseek-harness 生态数据脚本

用于测试与收集 deepseek-harness 生态的 GitHub 仓库信息（octokit REST 搜索）。

## search-deepseek-repos.mjs

按官方与社区 topic + 关键词搜索所有相关仓库，去重聚合后输出 JSON。

```bash
# 匿名运行（限流 10 req/min，10 个 topic 会顶满；建议带 token）
pnpm search:plugins

# 带 GitHub token（限流 30 req/min，搜索配额 5000/时）
GITHUB_TOKEN=ghp_xxx pnpm search:plugins

# 常用参数
pnpm search:plugins -- --min-stars 0        # 放宽 star 门槛（默认 ≥ 10）
pnpm search:plugins -- --min-age-days 0     # 关闭发布时间门槛（默认 ≥ 5 天）
pnpm search:plugins -- --sort updated        # 按更新时间排序（默认 stars）
pnpm search:plugins -- --limit 200           # 每类型最多 200 条（默认 500）
pnpm search:plugins -- --out data/repos.json # 自定义输出路径
pnpm search:plugins -- --topics-only         # 只跑 topic 搜索
pnpm search:plugins -- --readme              # 额外收录 README 全文命中（更全更耗限流）
pnpm search:plugins -- -v                    # 打印每轮查询进度（含分页命中数/总数）
```

### 默认缓存参数（质量门槛）

- **limit 500/类型**：关键词组与每个 topic 各最多收录 500 条
- **star ≥ 10**：剔除无星/刷星小仓库
- **创建时间距今 ≥ 5 天**：剔除刚新建的垃圾仓库（`--min-age-days 0` 关闭）
- 6 个核心关键词（`deepseek-harness / "deepseek harness" / dsh / "dsh-plugin" /
  "deepseek-harness plugin" / "harness plugin"`）合并为 1 组 OR 查询；追加更多
  关键词时自动按每组 ≤6 term 拆两次查询（至多 12 个）

### 分页与搜索优化（减少请求、防触顶）

- **关键词 OR 合并**：单查询最多 5 个布尔运算符（6 term），脚本自动把
  nameDesc 9 个关键词拆为 2 组 OR 查询（原 9 次请求），readme 4 个 → 1 次
- **topic 无法合并**：GitHub Search 的 OR 只适用于文本，`topic:a OR topic:b`
  返回 422（qualifier 不支持逻辑运算符），topic 保持逐条查询
- **单次最大分页**：每请求 `per_page=100`（GitHub 上限），按 `--limit` 自动
  翻页递归拉取（默认 1000 条，单查询上限），无需 `--deep`
- 分页间 2.1s 节流 + 检查 `x-ratelimit-remaining`，剩余 ≤ 10 次自动停止；
  403/429 限流时保留已收集结果不中断整体
- 多关键词 / topic 聚合去重后即为全量收录；生态插件 2000+ 时多组互补
  远超单查询 1000 条上限

### 搜索覆盖（可定制配置区）

脚本最上方 `① 可定制搜索配置` 区块集中管理收录范围，直接修改即可：

- **官方库** `OFFICIAL_REPOS`：置顶并标记 `is_official: true`
- **Topics** `PLUGIN_TOPICS`：`dsh`、`dsh-plugin`、`dsh-plugins`、`dsh-patch`、
  `dsh-skill`、`deepseek-harness`、`deepseek-harness-plugin`、`cordis`、
  `cordis-plugin`、`plugin-marketplace`、`plugin-store`、`ai-agents`、`agent-harness`
- **关键词全量收录** `KEYWORD_QUERIES`：
  - `nameDesc`（默认）：`deepseek-harness`、`dsh`、`dsh plugin`、`deepseek agent`、
    `harness plugin` 等 9 组 name/description 命中
  - `readme`（`--readme` 开启）：README 全文命中，更全但噪音与限流成本更高

### 输出

- 默认写入 `scripts/output/deepseek-harness-repos.json`
- 字段：`full_name / html_url / description / language / stargazers_count /
  forks_count / open_issues_count / created_at / pushed_at / updated_at /
  topics / license / archived / is_official / sources`（来源：keyword | topic）

### 自动同步（GitHub Action）

`.github/workflows/sync-plugin-seed.yml` 每 6 小时自动运行收录脚本并提交
种子数据更新（也可在 Actions 页面手动触发）。间隔权衡与限额说明见 workflow 注释。

### 注意事项

- GitHub Search API **不支持 `topic:a OR topic:b` 合并查询**（返回空），脚本逐 topic 查询
- 无 token 时 10 个 topic 查询会触发 403/429 限流，脚本会自动停止并提示设置 token
