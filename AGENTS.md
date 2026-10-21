# AGENTS.md

> Codex 在本仓库工作时**自动加载**本文件。
> 本文件是**路由表**，不是百科全书 —— 不要在没读文档的情况下直接改代码。
> 详细内容在 `docs/`，任务模板在 `.codex/prompts/`。

---

## 0. 项目速览

**NestJS 12 + Fastify 5 + Prisma 7 + PostgreSQL** 的模块化单体后端。

```text
apps/gateway      唯一可运行应用（HTTP 入口，端口 6688 开发 / 80 生产）
libs/*            8 个基础设施库，通过 @app/* 别名引用
prisma/           数据契约（多文件 schema + 迁移）
config/           三层 YAML 配置
```

**当前状态**：基础设施完整且生产级，业务层几乎是空的（只有 `user` 模块，5 个接口里 4 个是占位）。
**不要把 `libs/*` 当成半成品重写。**

---

## 1. 先读哪份文档（按任务类型）

| 你要做的事 | 必读 | 可选 |
| --- | --- | --- |
| **任何代码改动** | `docs/企业级架构规范与扩展指南.md` 第 2、3、4 章（分层 / 依赖矩阵 / 横切落位） | 第 5 章（契约不变式） |
| 新增业务模块 / 接口 | 上面 + 第 6 章（模块规范）+ 第 15 章 P1（完整代码骨架） | 第 14 章（反模式） |
| 改配置 | 第 7 章 + `docs/项目文件地图与架构说明.md` 第 5 节 | 第 15 章 P2 |
| 改数据模型 / 迁移 | 第 8 章 + 第 15 章 P5 | RBAC 文档 4.2（目标 schema） |
| 改缓存 / Redis | 第 9 章 | 文件地图 7.6 |
| 改加密 / 认证 | 第 10 章 + `libs/crypto/README.md` | RBAC 文档第 6 章 |
| 修 bug | 第 13.3 章（注释风格）+ 第 17.4 章（评审清单） | — |
| 架构评审 | 第 14 章（反模式）+ 第 17 章（守护） | — |
| 想知道某个文件干什么 | `docs/项目文件地图与架构说明.md` 第 7 节（逐文件职责表） | — |

**三份文档的权威边界（冲突时按此优先级）：**

1. `docs/企业级架构规范与扩展指南.md` —— **架构宪法**，分层与依赖规则最高优先级
2. `docs/项目文件地图与架构说明.md` —— **现状事实**，文件职责以此为准
3. `docs/NestJS 企业级 RBAC 权限系统：架构设计与实施文档.md` —— **目标设计**，多数功能尚未实现，不要当成已有能力

完整索引见 `.codex/docs-index.md`。

---

## 2. 十条硬约束（违反即失败，不是建议）

1. **相对导入必须带 `.js` 后缀**。`import { X } from './x.js'`。严格 ESM（`type: module` + `module: nodenext`），漏了直接编译失败。
2. **纯类型导出用 `export type`**。`isolatedModules: true`。
3. **禁止 `libs/*` 里 import `apps/*`**。依赖只能向下。违反即架构破坏。
4. **出参必须过 Response DTO**，且每个输出字段都要 `@Expose()`。`toDto()` 用了 `excludeExtraneousValues: true`，漏标的字段会**静默消失**。
5. **业务失败用 `BusinessException`**，不用 `throw new Error()`。错误码从模块段位分配（`1001xx` user、`1002xx` role…），**不要往 `BUSINESS_CODE` 里加业务码**。
6. **不要手拼 `{ code, data, message }`**。直接 `return data`，`ResponseInterceptor` 负责包装。
7. **列表查询必须走 `paginate()`**，且软删除条件显式写 `where: { delFlag: '0' }`（当前没有自动软删除扩展）。
8. **不要手改 `libs/database/src/generated/**`**。改 `.prisma` 后跑 `pnpm db:generate`。
9. **禁止 `any`、`console.log`**。用 `unknown` + 类型收窄；日志用注入的 `PinoLogger`。
10. **新增配置项必须写 YAML 注释**（单位/范围/默认值/何时改），这是仓库的强制约定。

---

## 3. 当前陷阱（不知道会写出错误代码）

| 陷阱 | 后果 | 应对 |
| --- | --- | --- |
| **没有全局 ValidationPipe** | `@Body()` 拿到的是原始 plain object，class-validator 装饰器**全部不执行**，`PageQueryDto` 默认值也不生效 | 不要假设校验会生效。要么显式 `plainToInstance`，要么先补 Pipe（见架构文档 ADR-009） |
| **`prisma/migrations` 未被 git 跟踪** | `.gitignore` 有一行裸 `migrations` | 新增迁移后 `git add -f prisma/migrations/` |
| **`config/default.yaml` 含真实 RSA 密钥** | 只能当开发密钥 | 不要新增真实凭据到入库文件 |
| **`FIELD_ENCRYPTION_KEY` 硬编码在源码** | 不安全 | 生产必须外置，别扩散这个用法 |
| **`SystemModule` 误标 `@Global()`** | 依赖隐式化 | 新模块别学，见架构文档 3.5 |
| **限流是进程内内存计数** | 多实例不共享额度 | 不要基于它做安全假设 |
| **BigInt 不能直接 JSON 序列化** | `JSON.stringify` 抛错 | 出参 DTO 加 `@Type(() => String)` |
| **Date 输出会差 8 小时** | 时区错 | 出参 DTO 加 `@DateFormat(undefined, { toClassOnly: true })` |

---

## 4. 常用命令

```bash
pnpm start:dev              # 开发启动（watch），端口 6688
pnpm build                  # nest build gateway，同时验证 ESM 导入后缀
pnpm lint                   # ESLint --fix（antfu config）
pnpm test                   # Vitest 单测（**/*.spec.ts）
pnpm test:e2e               # Vitest e2e（**/*.e2e-spec.ts），需要 PostgreSQL
pnpm db:generate            # 改完 .prisma 必跑
pnpm db:migrate --name xxx  # 必须在仓库根目录执行
```

---

## 5. 完成任务的定义（Definition of Done）

改完代码必须**实际执行**并在汇报里贴出结果，不能只说"应该没问题"：

```bash
pnpm lint && pnpm build && pnpm test
```

涉及接口或数据层的改动，再加 `pnpm test:e2e`。

**汇报格式**：
1. 改了什么文件（路径 + 一句话）
2. 为什么这样改（对应架构文档哪条规则）
3. 验证命令的实际输出
4. 未解决的遗留问题（不要隐瞒）

**禁止**：把"已实现"当"已验证"。没跑过测试不要说通过。

---

## 6. 代码风格（本仓库特征鲜明，照抄现有代码）

| 项 | 规范 |
| --- | --- |
| 缩进 / 引号 / 分号 | 2 空格 / 单引号 / **必须带分号** |
| 文件命名 | kebab-case + 类型后缀：`user.controller.ts`、`base.dto.ts` |
| DTO 文件名 | **必须以 `.dto.ts` 结尾**，否则 Swagger 编译插件不提取注释 |
| 注释语言 | **中文**，写「为什么」和「边界」，不写「是什么」 |
| Swagger | 写 JSDoc 注释（`/** 用户名称 */` + `@example`），**禁止手写 `@ApiProperty()`** |
| DTO 导入 | 必须**值导入**，`import type` 会擦除运行时模型导致文档为空 |

注释范本（`libs/database/src/database.module.ts`）：**一句话说是什么 → 为什么这样设计 → 代价是什么 / 什么情况下应该改**。

---

## 7. 禁止清单

- ❌ 重写 `libs/*` 的现有实现（它们是有意设计的，理由写在注释里）
- ❌ 引入新依赖而不说明理由
- ❌ 修改已应用的迁移文件
- ❌ 把业务逻辑写进 Controller 或 `DatabaseService`
- ❌ 在 Service 里注入 `@Req()` / `ExecutionContext`
- ❌ 跨模块直接查别人的表
- ❌ 用 `forwardRef` 解决循环依赖（说明设计错了）
- ❌ 未经要求就"顺手优化"范围外的代码（发现问题只报告）
- ❌ 改动 `docs/` 里的既有文档来"让代码符合文档"（应该反过来）

---

## 8. 任务模板

`.codex/prompts/` 下有可直接复用的任务提示词：

| 文件 | 用途 |
| --- | --- |
| `new-module.md` | 新增一个业务模块（含完整 9 步） |
| `add-endpoint.md` | 在已有模块里加接口 |
| `fix-bug.md` | 修 bug（先写复现测试） |
| `arch-review.md` | 架构评审 / 自查 |

用法：把模板内容连同具体需求一起交给 Codex，或直接说「按 `.codex/prompts/new-module.md` 实现 X 模块」。
