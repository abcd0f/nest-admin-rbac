# 任务模板：新增业务模块

> 用法：
> ```bash
> codex "按 .codex/prompts/new-module.md 实现 <模块名> 模块，<补充业务需求>"
> ```

## 角色

你是本仓库的高级后端工程师。仓库是 NestJS 12 + Fastify + Prisma 7 的模块化单体，已有完整的基础设施库。
你的任务是**在既有架构内新增一个业务模块**，不是重新设计。

## 第一步：读文档（不要跳过）

按顺序读，**只读这些**：

```
1. docs/企业级架构规范与扩展指南.md
   ├─ 2.3  L3 领域模块的内部结构
   ├─ 3.2  库间依赖矩阵
   ├─ 3.4  业务模块之间的依赖
   ├─ 4.    横切关注点落位
   ├─ 5.4  业务码分段规划
   ├─ 6.    业务模块设计规范（全章）
   ├─ 14.   分层反模式清单
   └─ 15. P1 新增一个业务模块      ← 完整代码骨架，直接照抄结构
2. docs/项目文件地图与架构说明.md
   └─ 7.1 节（apps/gateway/src 逐文件说明）← 看 user 模块怎么写的
3. 源码参考（必读，作为风格基准）
   ├─ apps/gateway/src/modules/system/user/   全目录
   └─ libs/common/src/dto/base.dto.ts         PageQueryDto
```

## 第二步：确认边界

开工前先输出一段简短的设计说明，**等我确认再写代码**：

```
模块名：<xxx>
归属：apps/gateway/src/modules/system/<xxx>/
表：<表名>（是否已存在于 prisma/models/？否 → 先走 P5 建模型）
接口清单：
  GET    /api/<xxx>          分页查询
  GET    /api/<xxx>/:id      详情
  POST   /api/<xxx>          创建
  PATCH  /api/<xxx>/:id      修改
  DELETE /api/<xxx>/:id      删除（软删除）
错误码段位：<从架构文档 5.4 的段位表取，不要复用已占用的段>
跨模块依赖：<无 / 单向依赖 xxx 模块的 Service>
是否需要缓存：<否 / 是，缓存键与 TTL>
```

## 第三步：实现（严格按此顺序）

1. `dto/<xxx>.dto.ts` —— `CreateXxxDto` / `UpdateXxxDto`（`PartialType`）/ `QueryXxxDto extends PageQueryDto`
2. `dto/response.dto.ts` —— `ResponseXxxDto`
3. `<xxx>.error.ts` —— 领域错误，`as const satisfies BusinessErrorDefinition`
4. `<xxx>.service.ts` —— 用例编排
5. `<xxx>.controller.ts` —— 薄控制器
6. `<xxx>.module.ts` —— 装配
7. `system.module.ts` —— 加一行 import
8. 模型（若需要）→ 走 `.codex/prompts/` 对应的数据模型流程

## 硬性约束（违反即失败）

| # | 约束 |
| --- | --- |
| 1 | 相对导入**必须**带 `.js` 后缀 |
| 2 | DTO 文件名**必须**以 `.dto.ts` 结尾（Swagger 插件依赖） |
| 3 | Response DTO 每个输出字段都要 `@Expose()`，漏了会静默消失 |
| 4 | BigInt 字段加 `@Type(() => String)`，Date 字段加 `@DateFormat(undefined, { toClassOnly: true })` |
| 5 | 敏感字段（password/token）加 `@Exclude()` + `@ApiHideProperty()` |
| 6 | 业务失败用 `BusinessException`，不用 `throw new Error()` |
| 7 | 错误码从模块段位分配，**不要**往 `BUSINESS_CODE` 里加 |
| 8 | 列表走 `paginate()` + `toPageDto()`，软删除条件显式写 `delFlag: '0'` |
| 9 | Controller 里禁止出现 Prisma、禁止 `try/catch`、禁止拼响应体 |
| 10 | Service 里禁止注入 `@Req()` / `ExecutionContext` |
| 11 | 不要写 `@ApiProperty()`，用 JSDoc 注释 |
| 12 | 中文注释，写「为什么」不写「是什么」 |
| 13 | 2 空格缩进、单引号、**必须带分号** |

## 注意

- **当前没有全局 ValidationPipe**，DTO 上的 class-validator 装饰器不会执行。照常写装饰器（为将来补 Pipe 做准备），但**不要假设它会拦住非法输入**。业务层该做的校验照做。
- 不需要 import `DatabaseModule`（它是 `@Global()`）。
- 需要缓存时**必须显式** `imports: [CacheModule]`（它不是全局的）。
- 不要给每个 Service 配一个纯转发的 Repository。默认直接用 `PrismaService`。

## 第四步：验证（必须实际执行）

```bash
pnpm lint && pnpm build && pnpm test
pnpm start:dev     # 然后 curl 至少两个接口，确认响应信封
```

`pnpm build` 是验证 ESM 导入后缀的关键，不能跳过。

## 汇报格式

```markdown
## 改动文件
- <路径>：<一句话>

## 关键设计决策
- <决策>：依据架构文档 <章节号>

## 验证结果
（贴 pnpm lint / build / test 的实际输出，以及 curl 的响应）

## 遗留问题
- <无 / 具体说明>
```

**不要把"已实现"当"已验证"。没跑过不要说通过。**
