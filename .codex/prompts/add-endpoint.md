# 任务模板：在已有模块里加接口

> 用法：
> ```bash
> codex "按 .codex/prompts/add-endpoint.md 给 user 模块加 <接口描述>"
> ```

## 角色

你是本仓库的高级后端工程师。目标模块已存在，你只**追加**一个接口，不重构、不"顺手优化"。

## 第一步：读文档（精简版）

```
docs/企业级架构规范与扩展指南.md
  ├─ 6.1  Controller 规范
  ├─ 6.2  Service 规范
  ├─ 6.3  DTO 三分类 + Response DTO 四条铁律
  └─ 5.5  契约演进规则          ← 判断这次改动是否破坏兼容
```

然后读目标模块的全部源码（controller / service / dto / error），**照它的现有写法来**，不要引入新模式。

## 第二步：判断改动性质

| 情况 | 做法 |
| --- | --- |
| 只是新增一个路由 | 直接加，无需改 Module |
| 需要新的 Service 方法 | 加方法，不改现有方法的签名 |
| 需要新的 DTO | 加 class，不改现有 DTO 的字段 |
| 需要改现有 Response DTO | ⚠️ 只允许**新增字段**。删除/改名/改类型属破坏性变更，先停下来问 |
| 需要新错误码 | 从模块已占用的段位内递增，检查没被用过 |

## 第三步：实现

**Controller** —— 保持薄：

```ts
/**
 * <接口摘要，会生成 Swagger summary>
 * @remarks <补充说明，会生成描述>
 */
@Get('xxx')
xxx(@Query() query: QueryXxxDto): Promise<PageResponseDto<ResponseXxxDto>> {
  return this.xxxService.xxx(query);
}
```

- 返回值**必须**声明具体类型（Swagger 靠它生成响应模型）
- 不写 `try/catch`
- 不碰 Prisma
- 不拼 `{ code, data, message }`

**Service** —— 用例编排：

- 不注入 `@Req()` / `ExecutionContext`
- 返回 Response DTO，不返回 Prisma 模型
- 业务失败 `throw new BusinessException(XXX_ERROR)`
- 涉及多表写入时用 `DatabaseService.transaction(tx => ...)`，回调内只用 `tx`
- 缓存失效放在事务提交**之后**

**DTO**：

- 入参用 `CreateXxxDto` / `UpdateXxxDto`（`PartialType`）
- 查询用 `QueryXxxDto extends PageQueryDto`
- 出参用 `ResponseXxxDto`，每个字段 `@Expose()`

## 硬性约束

| # | 约束 |
| --- | --- |
| 1 | 相对导入带 `.js` 后缀 |
| 2 | Response DTO 每个输出字段 `@Expose()` |
| 3 | BigInt → `@Type(() => String)`；Date → `@DateFormat(undefined, { toClassOnly: true })` |
| 4 | 敏感字段 `@Exclude()` + `@ApiHideProperty()` |
| 5 | 业务错误用 `BusinessException` |
| 6 | 列表走 `paginate()`，软删除显式写 `delFlag: '0'` |
| 7 | 不改动本任务范围外的代码 |
| 8 | 中文 JSDoc 注释，不写 `@ApiProperty()` |

## 第四步：验证

```bash
pnpm lint && pnpm build && pnpm test
```

涉及新路由时补一个 e2e 断言响应信封（参考 `test/app.e2e-spec.ts` 的写法）。

## 汇报格式

```markdown
## 改动文件
- <路径>：<新增/修改了什么>

## 契约影响
- 新增字段/路由：<列出>
- 是否破坏兼容：<否 / 是，说明>

## 验证结果
（贴实际输出）

## 遗留问题
```

## 禁止

- ❌ 顺手重命名已有方法、调整已有 DTO 字段顺序
- ❌ 把 Controller 拆成"更优雅"的结构
- ❌ 给现有 Service 加缓存（除非需求明确要求）
- ❌ 修改本任务没提到的文件
