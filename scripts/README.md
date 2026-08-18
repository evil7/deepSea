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
pnpm search:plugins -- --min-stars 5        # 只收 star >= 5
pnpm search:plugins -- --sort updated        # 按更新时间排序（默认 stars）
pnpm search:plugins -- --limit 200           # 每查询最多收 200 条
pnpm search:plugins -- --out data/repos.json # 自定义输出路径
pnpm search:plugins -- --deep                # 每查询分页拉全量
pnpm search:plugins -- --topics-only         # 只跑 topic 搜索
pnpm search:plugins -- -v                    # 打印每轮查询进度
```

### 输出

- 默认写入 `scripts/output/deepseek-harness-repos.json`
- 字段：`full_name / html_url / description / language / stargazers_count /
  forks_count / open_issues_count / created_at / pushed_at / updated_at /
  topics / license / archived / is_official / sources`（来源：keyword | topic）

### 搜索覆盖

- **关键词**（name/description）：`deepseek-harness`、`deepseek harness` 等
- **Topics**：`dsh`、`dsh-plugin`、`dsh-plugins`、`dsh-patch`、`dsh-skill`、
  `deepseek-harness`、`deepseek-harness-plugin`、`cordis-plugin`、
  `plugin-marketplace`、`plugin-store`
- 官方库 `deepseek-ai/deepseek-harness` 置顶并标记 `is_official: true`

### 注意事项

- GitHub Search API **不支持 `topic:a OR topic:b` 合并查询**（返回空），脚本逐 topic 查询
- 无 token 时 10 个 topic 查询会触发 403/429 限流，脚本会自动停止并提示设置 token
