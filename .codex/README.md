# `.codex/` —— Codex 接入层

## 这个目录是什么

让 Codex 能**正确、按需、低成本**消费 `docs/` 里三份长文档的接入层。

三份文档合计约 3200 行，全塞进上下文既浪费 token 又会稀释重点。这里的做法是：**根目录 `AGENTS.md` 做路由，本目录做索引与任务模板**，Codex 只在需要时读具体章节。

## 目录结构

```text
.codex/
├── README.md              本文件：目录说明与使用方式
├── docs-index.md          文档索引：每份文档读哪几章、什么时候读、哪些别读
└── prompts/               可复用的任务提示词
    ├── new-module.md      新增业务模块
    ├── add-endpoint.md    在已有模块加接口
    ├── fix-bug.md         修 bug
    └── arch-review.md     架构评审 / 自查
```

## 怎么让 Codex 用上

**关键事实：Codex 自动加载的是仓库根目录的 `AGENTS.md`，不是这个目录。**

所以接入链路是：

```text
Codex 启动
  └─ 自动读取 /AGENTS.md          ← 路由表：项目速览 + 10 条硬约束 + 文档路由
       └─ 指向 .codex/docs-index.md   ← 索引：精确到章节号
            └─ 指向 docs/*.md          ← 正文
       └─ 指向 .codex/prompts/*.md     ← 任务模板
```

**不需要任何配置。** 只要 `AGENTS.md` 在根目录，Codex 就会读。

## 三种使用方式

### 方式 1：直接提需求（推荐）

```bash
codex "实现角色管理模块的增删改查"
```

Codex 会读 `AGENTS.md` → 按路由表读架构文档第 2/3/6/15 章 → 照 P1 骨架实现。

### 方式 2：指定模板

```bash
codex "按 .codex/prompts/new-module.md 实现 dept 模块，字段参考 RBAC 文档 4.2 节的 SysDept"
```

模板里已经写死了「先读哪几章、做完必须跑什么、汇报格式」，比自由发挥稳定。

### 方式 3：只让它读文档做分析

```bash
codex "读 docs/企业级架构规范与扩展指南.md 第 3 章，列出当前代码里所有违反依赖矩阵的地方"
```

## 维护规则

- **`docs/` 变了，同步更新 `docs-index.md`**（章节号会漂）。
- **新增文档时**：在 `docs-index.md` 加一行，在 `AGENTS.md` 第 1 节的路由表里加一行（如果它属于某类任务的必读）。
- **`AGENTS.md` 保持精简**。它每次都会被加载，超过 250 行就开始稀释注意力。细节放本目录或 `docs/`。
- **prompts 里的章节号**同样需要跟随文档更新。

## 为什么不用 `.cursorrules` / `CLAUDE.md`

不同工具的约定不同，但 `AGENTS.md` 是跨工具的事实标准（Codex、Cursor、Aider、Zed 都认）。
需要兼容其他工具时，加一行软链或短文件转发到 `AGENTS.md`，不要复制内容——复制必然漂移。

## 可选增强（未创建，需要时再加）

Codex 也会读取**子目录**下的 `AGENTS.md`，就近生效。如果发现它频繁违反某一层的规则，可以加：

| 文件 | 内容 |
| --- | --- |
| `libs/AGENTS.md` | 平台层规则：禁止 import apps、内核库不许有 `@Injectable()`、库间用深路径导入 |
| `apps/gateway/src/modules/AGENTS.md` | 领域层规则：Controller 不碰 Prisma、出参必须过 Response DTO、错误用 BusinessException |

**不要一上来就建**——先观察 Codex 实际犯什么错，针对性补，否则只是把 `AGENTS.md` 的内容复制三份。
