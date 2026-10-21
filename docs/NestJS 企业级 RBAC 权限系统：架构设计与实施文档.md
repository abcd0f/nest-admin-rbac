# NestJS 企业级 RBAC 权限系统：架构设计与实施文档

版本 v1.3 · 2026-10-21 · 技术栈：NestJS 12 + Prisma 7 + PostgreSQL + 单个共享 Redis 服务 · 单租户

## 1. 目标、范围与设计原则

**目标**：交付一套可直接投产的后台权限底座，覆盖用户、部门、职位、角色、菜单五个核心实体，提供功能权限、接口权限、数据权限与操作审计四项能力。

**不在范围内**：多租户、ABAC 规则引擎、SSO/OAuth 登录（架构上预留扩展点，本期不实现）。

**设计原则**

1. 后端是唯一的权限裁决方，前端的菜单与按钮控制只用于体验，不能当安全边界。
2. 权限不进 Token，Token 只证明身份；权限在服务端按需计算并缓存，变更即时生效。
3. 部门、职位属于组织维度，只通过「数据范围」间接影响权限，不直接挂菜单。
4. 鉴权横切化：用装饰器加全局守卫声明，业务代码里不出现 if (isAdmin) 这类判断。
5. 默认需要登录：匿名接口必须显式标注 @Public()；管理类接口必须声明权限标识。
6. 每条权限规则都要有单元测试，先写测试再实现（见第 12 章）。

### 1.1 当前仓库基线（2026-10-21）

本文同时描述现有工程和计划建设的 RBAC 系统。除本节及明确标记为「现有」的内容外，第 4 至第 14 章中的权限、认证和业务能力均为目标设计，不代表已经实现。实施时先以代码为准，并在每个 Phase 完成后更新本节和阶段状态。

| 范围           | 当前状态                                                                                                                                                                               | 代码位置                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Nest 应用      | NestJS 12、TypeScript strict、ESM、Nest CLI 多项目 monorepo；HTTP 使用 Fastify                                                                                                         | `apps/gateway`、`nest-cli.json`、`tsconfig.json`                             |
| 已有库         | cache、common、config、core、crypto、database、logger、swagger                                                                                                                         | `libs/*`                                                                     |
| 网关业务       | 仅有欢迎接口及 `system/user` 模块骨架；用户创建、详情、更新、删除仍是占位实现，列表调用 Prisma 分页                                                                                    | `apps/gateway/src/app.controller.ts`、`apps/gateway/src/modules/system/user` |
| 数据库         | Prisma 7、PostgreSQL adapter；schema 采用 `prisma/schema.prisma` 加 `prisma/models/*.prisma`，当前只有 `User` 模型和一条初始化迁移；数据库是否已应用迁移需在目标环境另行核对           | `prisma/`、`libs/database/src/prisma.service.ts`                             |
| Redis          | 一个 Redis endpoint 与 `RedisConnection` 已实现；通过 `redis.enabled` 控制，`config/default.yaml` 当前为 `true`；`CacheService` 只提供可降级业务缓存，认证会话、权限快照和限流尚未接入 | `libs/cache`、`config/*.yaml`                                                |
| 密码与报文加密 | Argon2id 密码哈希和 AES/RSA API 加解密已有实现；尚无登录认证服务                                                                                                                       | `libs/crypto`                                                                |
| HTTP 横切能力  | 全局限流、异常过滤器、成功响应拦截器、Swagger 已接入；限流使用默认进程内存存储                                                                                                         | `libs/core`、`libs/swagger`、`apps/gateway/src/app.module.ts`                |
| RBAC 业务      | Auth、Permission、Dept、Post、Role、Menu、Monitor、数据范围、审计日志、seed 均未实现                                                                                                   | 待建设                                                                       |
| 验证           | Vitest 单测及 e2e 配置已存在，覆盖当前基础库与网关骨架；没有 RBAC 场景测试                                                                                                             | `vitest.config*.ts`、`test/`、各库 `*.spec.ts`                               |

**本次调整的解释口径**：本文后续的表结构、接口清单、权限链路和 Phase 1–10 是拟实施的设计契约；不是现有 API 或数据库的描述。现有项目没有前端代码，本文件只约定后端接口与未来前端对接方式。

## 2. 技术选型

| 领域       | 选型                                | 说明                                                                                                                      |
| ---------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 运行时     | Node.js 22.22.0                     | 当前 `.node-version` 指定版本；部署时按实际依赖的 engines 校验兼容性                                                      |
| 框架       | NestJS 12 + TypeScript 6 strict     | 项目使用 `type: module`、`module/moduleResolution: nodenext`；相对导入带 `.js` 后缀；沿用 Nest CLI 多项目结构             |
| ORM        | Prisma 7 + PostgreSQL               | generator 用 prisma-client 并显式指定 output；连接 URL 配在 prisma.config.ts；必须经 @prisma/adapter-pg 驱动适配器连接    |
| Redis      | 单个共享 Redis 服务                 | 复用 `libs/cache` 的 Redis endpoint 与连接；补充强一致原子命令和 Throttler 存储适配器；按键前缀隔离业务，不按用途拆 Redis |
| 认证       | 计划：@nestjs/jwt + Passport JWT    | 当前未安装；落地时一并核对 `@nestjs/passport`、`passport`、`passport-jwt` 及所需类型依赖                                  |
| 密码       | libs/crypto：Argon2id               | 复用 `PasswordHashService.hashPassword()` / `verifyPassword()`，不再套一层同义 PasswordService                            |
| 校验       | class-validator + class-transformer | DTO 已有校验装饰器；全局 `ValidationPipe` 尚未注册，目标启用 transform、whitelist、forbidNonWhitelisted                   |
| 配置       | @nestjs/config + libs/config        | 分层 YAML、配置域解析及启动校验已实现；当前不是 class-validator 配置类方案，不需要为此重做                                |
| 请求上下文 | 计划：nestjs-cls                    | 当前未安装；用于后续传递用户与数据范围，已有日志上下文无需因此重写                                                        |
| 事件       | 计划：@nestjs/event-emitter         | 当前未安装；在事务提交后通知权限缓存失效，需等待处理完成并明确失败行为                                                    |
| 日志       | libs/logger                         | Pino 请求日志、跨 await 的请求关联、脱敏和文件轮转已有实现；请求 ID 响应头尚未实现                                        |
| 文档       | libs/swagger                        | 沿用现有模块                                                                                                              |
| 限流       | @nestjs/throttler                   | 全局限流已实现，当前使用进程内存存储；多进程共享额度及登录专用策略尚未实现                                                |
| 测试       | Vitest + Supertest                  | vitest.config.ts 跑单测，vitest.config.e2e.ts 跑 e2e；装饰器元数据沿用现有配置                                            |
| 包管理     | pnpm                                | 根 `package.json` 统一维护依赖；已有 `pnpm-workspace.yaml`，应用/库不是各自拥有 package.json 的独立包                     |

## 3. 总体架构（目标设计）

### 3.1 请求管线

```
Client ──HTTP + Bearer JWT──►
  Middleware(requestId)
   → JwtAuthGuard       认证：验签、检查会话是否存在
   → PermissionGuard    鉴权：读权限快照，匹配 @RequirePermissions
   → Interceptors       DataScope 上下文、OperLog 审计、统一响应
   → ValidationPipe     DTO 校验
   → Controller → Service → PrismaService → PostgreSQL

PermissionService ──读写──► Redis(权限快照) ──未命中──► PostgreSQL
```

### 3.2 模块划分

| 模块                                       | 职责                                                    | 落位                                                 |
| ------------------------------------------ | ------------------------------------------------------- | ---------------------------------------------------- |
| 基础库（已有）                             | Prisma、Redis、配置、日志、异常过滤器、响应拦截器、限流 | `libs/database`、`cache`、`config`、`logger`、`core` |
| AuthModule（待建）                         | 登录、登出、刷新、验证码、当前用户信息与路由            | 计划：`apps/gateway/src/modules/auth`                |
| PermissionModule（待建）                   | 权限快照计算与缓存、守卫、数据范围构造器                | 计划新增 `libs/permission`，由 gateway 注册          |
| User（骨架）及 Dept/Post/Role/Menu（待建） | 用户 CRUD 占位；其余实体及关联维护待建                  | `apps/gateway/src/modules/system`                    |
| LogModule（待建）                          | 登录日志、操作日志、在线用户                            | 计划：`apps/gateway/src/modules/monitor`             |
| 密码哈希（已有）                           | Argon2id 哈希与校验                                     | `libs/crypto`                                        |

**依赖规则**：业务模块按需使用公共库和权限服务；当前 `UserService` 已直接注入全局 `PrismaService`，无需为 RBAC 强制增加 Repository 抽象层。`DatabaseModule`、`CryptoModule`、`AppConfigModule` 是全局模块；`CacheModule` 只导出 `CacheService`，使用它的模块需要显式导入。业务模块之间禁止循环依赖，角色、菜单、部门变更不能让基础库反向依赖业务应用。

### 3.3 当前目录结构

```text
apps/gateway/src/
  main.ts                 # Fastify 启动、端口、全局 API 前缀、Swagger
  app.module.ts           # 组装配置、日志、缓存、加密、Core、Swagger、System、Database
  app.controller.ts       # GET /<api-prefix>/，RawResponse 原始字符串
  modules/system/
    system.module.ts      # 当前为全局模块，仅导入 UserModule
    user/                 # 用户 DTO、控制器、服务、响应 DTO；服务仍有占位方法
libs/
  common/                 # Fastify adapter、分页 DTO/转换器、业务码、通用常量
  config/                 # YAML 加载、配置域解析与校验（app/database/redis/logger/swagger/throttler 等）
  core/                   # 全局异常过滤器、响应拦截器、限流守卫、基础装饰器/异常
  database/               # PrismaPg 客户端、DatabaseService、分页 helper、生成客户端
  cache/                  # cache-manager/Keyv Redis store、连接生命周期、CacheService
  crypto/                 # Argon2id、API AES/RSA、加解密 guard/装饰器
  logger/                 # Pino/Nest logger bridge、控制台与文件轮转
  swagger/                # Swagger 配置与启动服务
prisma/
  schema.prisma           # generator 与 datasource
  models/user.prisma      # 当前唯一模型 User
  migrations/             # 当前唯一初始化迁移
config/
  default.yaml            # 共享默认配置（当前 redis.enabled 与 api-decrypt.enabled 均为 true）
  development.yaml        # 开发端口 6688、数据库连接和 SQL 日志覆盖
  production.yaml         # 生产端口 80、Swagger 默认关闭
test/                     # gateway、Redis、API 加密 e2e 及测试辅助
```

`@app/*` 路径别名在 `tsconfig.json` 中声明；各库入口由 `libs/*/src/index.ts` 导出。新增 RBAC 库或业务模块时应同步更新 `tsconfig.json`、`nest-cli.json` 和本结构说明。

### 3.4 当前启动与配置约定

- `pnpm start:dev` 启动 `gateway`，开发端口来自 `config/development.yaml` 的 `6688`；生产脚本执行 `dist/apps/gateway/src/main.js`，生产端口为 `80`。
- `main.ts` 使用 `createFastifyAdapter()`，设置 `app.api-prefix`（默认 `api`），因此根接口实际为 `GET /api/`，Swagger 默认地址为 `/api/docs`。
- `AppModule` 的导入顺序是配置、日志、缓存、加密、Core、Swagger、System、Database；`AppConfigModule` 在启动时先解析并校验配置域。
- `default.yaml` 当前把 `redis.enabled` 和 `api-decrypt.enabled` 都设为 `true`。没有本地 Redis 或有效的 RSA 密钥时，可在未入库的环境覆盖文件中关闭对应能力；RBAC 认证、会话及共享限流启用的环境必须提供 Redis。
- RBAC 认证与共享限流上线后，Redis 是运行依赖：生产与多实例部署均指向一个共享 Redis 服务。开发环境或不启用 RBAC 的测试可按现有配置关闭连接；不能为会话、权限缓存、限流分别配置 Redis 地址或启动独立实例。
- `@nestjs/throttler` 当前按客户端 IP 和处理方法做进程内计数，默认 60 秒 100 次；它不是 Redis 限流。多实例部署前必须补充共享存储方案。
- 当前 `UserController` 没有声明 `@Public()` 或认证守卫，所有现有路由都不能被视为已完成的登录保护；认证模块上线后再统一收紧默认访问策略。

### 3.5 单 Redis 复用方案（目标设计）

部署一个 Redis 服务和一个 Redis endpoint，供 gateway 的缓存、会话、权限快照与限流共用。Redis 数据库编号或逻辑 key 前缀可以隔离命名空间，但不代表需要额外 Redis 实例；禁止在 Auth、Permission 或 Core 模块中自行 `new Redis()`，也不要为不同用途配置不同 host、port 或密码。

现有 `libs/cache/src/redis.connection.ts` 已集中管理一个 `ioredis` 客户端，`RedisStore` 复用它。Phase 2 应调整 CacheModule 的 provider/export 边界，使业务模块可注入同一个 `RedisConnection`，并由它提供底层客户端；CacheService 继续封装可降级业务缓存。另在 `libs/cache` 增加强一致命令服务/存储适配器，封装带 TTL 的读写、INCR、SET NX、Lua/事务和 SCAN 分批删除；它们调用同一个客户端，不另建连接。不要把认证会话或限流塞进 `CacheService` 的降级语义中。

统一采用 `nest-admin:` 作为业务键根前缀，按用途细分 `cache:`、`auth:session:`、`auth:perm:`、`auth:login:`、`auth:captcha:`、`throttler:`。Keyv 的 `redis.key-prefix` 只用于通用缓存命名空间，避免它与强一致键前缀重复拼接。键名及 TTL 见 6.4。

会话写入/续期必须设置到期时间；refresh 轮换、重放检测及用户会话索引更新用 Lua 或等价原子事务，避免并发刷新产生两条有效凭据。限流存储适配器实现 `@nestjs/throttler` 所需接口，用原子计数和过期时间共享各 gateway 实例的额度。权限快照只是缓存，未命中或版本落后时从 PostgreSQL 重算；写入/失效应在数据库事务提交后执行。Redis 不可用时，会话校验和 refresh 必须失败关闭；权限缓存不可用时可尝试从数据库重算，但受保护请求仍因无法校验权威会话而拒绝。登录、验证码等安全敏感限流在存储不可用时拒绝请求；普通 API 限流应返回服务不可用，或明确标记为仅进程内降级且不保证多实例总额度。

Redis 配置保持单一 `redis.*` 连接配置。生产环境通过部署密钥注入凭据并启用 TLS（如服务要求）；连接池/重试参数按现有 `RedisConnection` 策略配置。若需高可用，使用 Redis 服务自身的托管高可用/哨兵/集群方案和同一个逻辑 endpoint，不按业务职责拆分实例。

## 4. 数据模型

### 4.1 实体关系

```
Dept(树) 1──N User N──M Post            (sys_user_post)
                 User N──M Role          (sys_user_role)
                          Role N──M Menu(树)   (sys_role_menu)
                          Role N──M Dept       (sys_role_dept，仅自定义数据范围使用)
```

目标共 11 张表：实体表 5 张（sys_user、sys_dept、sys_post、sys_role、sys_menu），关联表 4 张，日志表 2 张。当前仓库中的 schema 与初始化迁移只定义 `sys_user`，尚无 RBAC 关联、组织或日志表；本次没有连接数据库确认部署状态。

### 4.2 Prisma Schema

以下是 RBAC 的目标模型草案。现有 `User` 已使用 snake_case 映射、Char(1) 状态位及审计字段，但还没有 `deptId` 或任何实体关系。初始化迁移含 `create_dept`，当前 `user.prisma` 却没有该字段，响应 DTO 仍保留 `createDept?: string`；需要在 Phase 1 核对这三者的语义与迁移历史，不能将创建部门直接当成用户所属部门。实施时基于当前 schema 做增量变更，不能把下方示例当成现有 schema 的副本。沿用多文件组织：`prisma/schema.prisma` 放 generator 与 datasource，各实体模型放在 `prisma/models/`。**以下模型为节省篇幅省略了审计字段，实现时 Dept、Post、Role、Menu 都要补全这 5 个字段**：createBy、createTime、updateBy、updateTime、remark（定义同现有 User）。

```prisma
generator client {
  provider = "prisma-client"
  output   = "../libs/database/src/generated/prisma" // 当前工程的实际生成路径
  engineType             = "client"
  runtime                = "nodejs"
  moduleFormat           = "esm"
  generatedFileExtension = "ts"
  importFileExtension    = "js"
}

datasource db {
  provider = "postgresql"
  // Prisma 7：连接 URL 已移到 prisma.config.ts，见 4.5
}

model User {
  userId      BigInt    @id @default(autoincrement()) @map("user_id")
  deptId      BigInt?   @map("dept_id")
  userName    String    @map("user_name") @db.VarChar(64)
  nickName    String    @map("nick_name") @db.VarChar(100)
  email       String?   @db.VarChar(254)
  phoneNumber String?   @map("phonenumber") @db.VarChar(32)
  sex         String    @default("2") @db.Char(1)
  password    String    @db.VarChar(255)
  status      String    @default("0") @db.Char(1) // 0正常 1停用
  delFlag     String    @default("0") @map("del_flag") @db.Char(1) // 0存在 2删除
  loginIp     String?   @map("login_ip") @db.VarChar(128)
  loginDate   DateTime? @map("login_date") @db.Timestamptz(6)
  createBy    BigInt?   @map("create_by")
  createTime  DateTime  @default(now()) @map("create_time") @db.Timestamptz(6)
  updateBy    BigInt?   @map("update_by")
  updateTime  DateTime? @map("update_time") @db.Timestamptz(6)
  remark      String?   @db.VarChar(500)

  dept  Dept?      @relation(fields: [deptId], references: [deptId])
  roles UserRole[]
  posts UserPost[]

  @@index([deptId])
  @@map("sys_user")
}

model Dept {
  deptId    BigInt  @id @default(autoincrement()) @map("dept_id")
  parentId  BigInt  @default(0) @map("parent_id")
  ancestors String  @default("/") @db.VarChar(512) // 物化路径，含自身，如 /1/5/12/
  deptName  String  @map("dept_name") @db.VarChar(64)
  orderNum  Int     @default(0) @map("order_num")
  leaderId  BigInt? @map("leader_id")
  status    String  @default("0") @db.Char(1)
  delFlag   String  @default("0") @map("del_flag") @db.Char(1)
  // + 审计字段

  users     User[]
  roleDepts RoleDept[]

  @@index([parentId])
  @@index([ancestors])
  @@map("sys_dept")
}

model Post {
  postId   BigInt @id @default(autoincrement()) @map("post_id")
  postCode String @map("post_code") @db.VarChar(64)
  postName String @map("post_name") @db.VarChar(64)
  orderNum Int    @default(0) @map("order_num")
  status   String @default("0") @db.Char(1)
  delFlag  String @default("0") @map("del_flag") @db.Char(1)
  // + 审计字段

  users UserPost[]

  @@map("sys_post")
}

model Role {
  roleId    BigInt @id @default(autoincrement()) @map("role_id")
  roleName  String @map("role_name") @db.VarChar(64)
  roleKey   String @map("role_key") @db.VarChar(64)
  orderNum  Int    @default(0) @map("order_num")
  dataScope String @default("5") @map("data_scope") @db.Char(1) // 1全部 2自定义 3本部门 4本部门及以下 5仅本人 6部门及以下或本人
  status    String @default("0") @db.Char(1)
  delFlag   String @default("0") @map("del_flag") @db.Char(1)
  // + 审计字段

  users UserRole[]
  menus RoleMenu[]
  depts RoleDept[]

  @@map("sys_role")
}

model Menu {
  menuId    BigInt  @id @default(autoincrement()) @map("menu_id")
  parentId  BigInt  @default(0) @map("parent_id")
  menuName  String  @map("menu_name") @db.VarChar(64)
  menuType  String  @map("menu_type") @db.Char(1) // M目录 C菜单 F按钮
  orderNum  Int     @default(0) @map("order_num")
  path      String? @db.VarChar(200)
  component String? @db.VarChar(255)
  query     String? @db.VarChar(255)
  isFrame   String  @default("1") @map("is_frame") @db.Char(1) // 0外链 1内部
  isCache   String  @default("0") @map("is_cache") @db.Char(1) // 0缓存 1不缓存
  visible   String  @default("0") @db.Char(1) // 0显示 1隐藏
  status    String  @default("0") @db.Char(1)
  perms     String? @db.VarChar(100) // 权限标识，如 system:user:add
  icon      String? @db.VarChar(100)
  // + 审计字段

  roles RoleMenu[]

  @@index([parentId])
  @@map("sys_menu")
}

model UserRole {
  userId BigInt @map("user_id")
  roleId BigInt @map("role_id")
  user   User   @relation(fields: [userId], references: [userId], onDelete: Cascade)
  role   Role   @relation(fields: [roleId], references: [roleId], onDelete: Cascade)

  @@id([userId, roleId])
  @@index([roleId])
  @@map("sys_user_role")
}

model UserPost {
  userId BigInt @map("user_id")
  postId BigInt @map("post_id")
  user   User   @relation(fields: [userId], references: [userId], onDelete: Cascade)
  post   Post   @relation(fields: [postId], references: [postId], onDelete: Cascade)

  @@id([userId, postId])
  @@index([postId])
  @@map("sys_user_post")
}

model RoleMenu {
  roleId BigInt @map("role_id")
  menuId BigInt @map("menu_id")
  role   Role   @relation(fields: [roleId], references: [roleId], onDelete: Cascade)
  menu   Menu   @relation(fields: [menuId], references: [menuId], onDelete: Cascade)

  @@id([roleId, menuId])
  @@index([menuId])
  @@map("sys_role_menu")
}

model RoleDept {
  roleId BigInt @map("role_id")
  deptId BigInt @map("dept_id")
  role   Role   @relation(fields: [roleId], references: [roleId], onDelete: Cascade)
  dept   Dept   @relation(fields: [deptId], references: [deptId], onDelete: Cascade)

  @@id([roleId, deptId])
  @@index([deptId])
  @@map("sys_role_dept")
}

model LoginLog {
  infoId    BigInt   @id @default(autoincrement()) @map("info_id")
  userName  String   @map("user_name") @db.VarChar(64)
  ipaddr    String?  @db.VarChar(128)
  userAgent String?  @map("user_agent") @db.VarChar(500)
  status    String   @default("0") @db.Char(1) // 0成功 1失败
  msg       String?  @db.VarChar(255)
  loginTime DateTime @default(now()) @map("login_time") @db.Timestamptz(6)

  @@index([userName])
  @@index([loginTime])
  @@map("sys_login_log")
}

model OperLog {
  operId        BigInt   @id @default(autoincrement()) @map("oper_id")
  title         String?  @db.VarChar(64)
  method        String?  @db.VarChar(200) // 控制器.方法名
  requestMethod String?  @map("request_method") @db.VarChar(10)
  operUserId    BigInt?  @map("oper_user_id")
  operUrl       String?  @map("oper_url") @db.VarChar(255)
  operIp        String?  @map("oper_ip") @db.VarChar(128)
  operParam     String?  @map("oper_param") @db.Text // 已脱敏
  status        String   @default("0") @db.Char(1)
  errorMsg      String?  @map("error_msg") @db.Text
  costTime      Int      @default(0) @map("cost_time")
  operTime      DateTime @default(now()) @map("oper_time") @db.Timestamptz(6)

  @@index([operUserId])
  @@index([operTime])
  @@map("sys_oper_log")
}
```

### 4.3 Prisma 表达不了的约束（迁移时手写 SQL）

以下是目标模型的索引建议，不是当前数据库已有约束。现有初始化迁移没有声明唯一索引。软删除要求「未删除记录」内唯一，Prisma 不支持部分唯一索引，生成目标迁移后再评估并手动追加：

```sql
CREATE UNIQUE INDEX uk_sys_user_name ON sys_user(user_name) WHERE del_flag = '0';
CREATE UNIQUE INDEX uk_sys_role_key  ON sys_role(role_key)  WHERE del_flag = '0';
CREATE UNIQUE INDEX uk_sys_post_code ON sys_post(post_code) WHERE del_flag = '0';
CREATE UNIQUE INDEX uk_sys_menu_perms ON sys_menu(perms) WHERE perms IS NOT NULL AND perms <> '';
```

### 4.4 目标模型关键约定

- **BigInt 序列化**：原生 JSON.stringify 遇到 BigInt 会抛错。当前没有全局 `BigInt.prototype.toJSON`；用户响应 DTO 对 ID 使用 `@Type(() => String)`。RBAC 接口应统一以字符串收发 ID，并在 DTO/服务边界显式转换，避免全局原型副作用。
- **软删除**：目标为删除置 `delFlag = '2'`。当前未实现 Prisma 软删除扩展；设计扩展时须审查 `findUnique` 等操作的语义和唯一约束，避免把扩展描述成已存在能力。
- **部门路径**：ancestors 形如 `/1/5/12/`（含自身）。新建时先插入拿到 id，再在同一事务里更新 ancestors 为「父路径加自身 id 加斜杠」。移动部门时，在事务内用原生 SQL 对所有子孙做前缀替换。
- **菜单类型**：M 目录与 C 菜单参与路由生成；F 按钮只承载 perms；perms 只在 C 与 F 上填写。
- **状态位**：status 0 正常、1 停用；停用的角色、菜单不参与权限计算。

### 4.5 当前 Prisma 7 接入

- 已有 `prisma.config.ts` 读取 `libs/config` 同一套 YAML，设置 schema 路径 `prisma/`、迁移目录和 CLI datasource URL；尚未登记 seed 命令。
- 已通过 `libs/database/src/prisma.service.ts` 的 `PrismaPg` adapter 创建运行时 Prisma Client，连接池及 schema 来自 `libs/config`。
- schema generator 使用 `prisma-client`，output 为 `libs/database/src/generated/prisma`，生成客户端以 ESM TypeScript 方式供代码导入。
- `package.json` 已提供 `db:generate`、`db:migrate`、`db:deploy`、`db:reset`、`db:push` 和 `db:studio`；seed 尚未配置。

## 5. 权限模型（目标设计）

### 5.1 三层权限

| 层级                   | 载体                       | 判定位置                               | 作用                           |
| ---------------------- | -------------------------- | -------------------------------------- | ------------------------------ |
| 功能权限（页面）       | Menu.menuType 为 M 或 C    | GET /auth/routers 加前端动态路由       | 决定用户能看到哪些页面         |
| 操作权限（按钮与接口） | Menu.perms                 | PermissionGuard 加 @RequirePermissions | 决定能否调用接口、是否显示按钮 |
| 数据权限（行级）       | Role.dataScope 加 RoleDept | DataScopeService 生成 Prisma where     | 决定同一接口能查到哪些行       |

### 5.2 权限标识规范

格式为 `模块:资源:动作`，例如 `system:user:list`、`system:user:add`、`system:user:edit`、`system:user:remove`、`system:user:resetPwd`。

- 一个接口对应一个权限标识，标识同时写入 Menu.perms 并在 @RequirePermissions 中引用。
- 所有标识集中定义在 `permissions.constant.ts`，禁止在代码里散落裸字符串。
- 支持通配：`*:*:*` 表示全部，`system:user:*` 表示该资源全部动作。匹配逻辑是纯函数 `matchPermission(owned, required)`，按冒号分段逐段比较，必须有完整单元测试。

### 5.3 超级管理员

roleKey 为 `admin` 的内置角色。快照中 isSuper 为 true，守卫直接放行，数据范围视为全部。

- 内置角色不可删除、不可停用、不可修改 roleKey。
- userId 为 1 的 admin 用户不可删除、不可停用、不可被移除 admin 角色。
- 任何时刻系统中必须至少保留一个启用状态的超管用户，相关写操作在服务层校验。

### 5.4 多角色合并规则

- **功能与操作权限**：所有启用角色的权限取并集。
- **数据权限取值**：1 全部数据；2 自定义（取 role_dept 中的部门）；3 本部门；4 本部门及以下；5 仅本人；6 部门及以下或本人。
- **数据权限合并**：任一角色为 1 则取全部；否则把各角色的条件用 OR 连接。取值 6 等价于 4 与 5 同时成立，快照中不为它单设字段，只把 deptAndChild 与 self 同时置为 true。

### 5.5 状态联动

- 角色停用或删除：不参与权限计算。
- 菜单停用：该节点及其子节点都不下发。
- 部门停用：不影响其下用户登录，但自定义数据范围中不再包含该部门。
- 用户停用：拒绝登录，并立即清除其全部会话。

### 5.6 授权边界（防越权，Phase 6 实现）

非超管在分配角色或菜单时，只能授予自己已拥有的角色与权限（服务端校验子集关系）；不能修改自己的角色；不能操作数据范围大于自己的用户。

## 6. RBAC 目标请求流程（尚未实现）

### 6.1 登录流程

1. POST /auth/login，先过限流与验证码。
2. 校验用户存在、delFlag 为 0、status 为 0，再用 libs/crypto 的密码哈希校验密码。失败写登录日志；同一用户名连续失败 5 次，锁定 15 分钟（Redis 计数）。
3. 创建会话 sid，写入 Redis，TTL 等于 refresh 有效期。
4. 签发 access token（15 分钟，载荷只含 sub、sid、jti）和 refresh token（7 天，轮换式：每次刷新作废旧 token；若检测到旧 refresh 被重复使用，则判定泄露并清除整条会话）。
5. 更新 loginIp 与 loginDate，写登录日志，预热权限快照。

### 6.2 每次请求的鉴权链路

1. **JwtAuthGuard（全局）**：@Public() 直接跳过；否则验签、校验过期、检查 Redis 中会话是否存在，通过后写入 `request.user = { userId, sid }`。
2. **PermissionGuard（全局）**：读取 @RequirePermissions 与 @RequireRoles 元数据。没有元数据则只要求已登录；有元数据则调用 `PermissionService.getSnapshot(userId)`，isSuper 直接放行，否则执行 matchPermission，不通过抛 403。
3. **DataScopeInterceptor**：对标注了 @DataScope() 的接口，把快照里的数据范围写入 CLS 请求上下文。
4. **Service 层**：调用 `DataScopeService.buildWhere(...)` 得到 Prisma where 片段，用 AND 合并进业务查询（详见第 7 章）。
5. **OperLogInterceptor**：对标注 @Log() 的接口记录脱敏后的参数、耗时与结果。
6. **统一响应与异常过滤器**：当前项目成功体为 `{ code, data, message }`，错误体同样使用 `message` 字段；新接口应沿用该现有契约，不要改成 `{ code, msg, data }`。

### 6.3 权限快照结构

```ts
interface PermissionSnapshot {
  userId: string;
  isSuper: boolean;
  roleKeys: string[];
  perms: string[]; // 并集去重后的权限标识
  deptId: string | null;
  deptPath: string | null; // 主部门 ancestors
  dataScope: {
    all: boolean;
    customDeptIds: string[]; // 各自定义角色的部门并集
    dept: boolean;
    deptAndChild: boolean;
    self: boolean;
  };
  ver: number; // 生成时的全局权限版本
}
```

### 6.4 Redis 键与失效策略

以下键共用同一个 Redis 服务和连接，完整键统一以 `nest-admin:` 开头；该前缀用于命名隔离，不是 Redis 实例划分。

| Key                                      | 内容/用途                      | TTL/处理方式                              |
| ---------------------------------------- | ------------------------------ | ----------------------------------------- |
| `nest-admin:auth:session:{userId}:{sid}` | 会话及 refresh 状态            | 等于 refresh 有效期；每次轮换原子更新     |
| `nest-admin:auth:session:user:{userId}`  | 用户 sid 索引，供强退/登出清理 | 与用户最长会话有效期一致；变更时原子维护  |
| `nest-admin:auth:perm:{userId}`          | 权限快照 JSON                  | 30 分钟                                   |
| `nest-admin:auth:perm:ver`               | 全局权限版本号                 | 持久；初始化时原子创建                    |
| `nest-admin:auth:perm:lock:{userId}`     | 快照重算单飞锁                 | 短 TTL；SET NX 获取，完成后释放           |
| `nest-admin:auth:login:fail:{userName}`  | 登录失败次数                   | 15 分钟；原子递增并只在首次写入时设置 TTL |
| `nest-admin:auth:captcha:{uuid}`         | 验证码答案                     | 2 分钟；校验成功后原子读取并删除          |
| `nest-admin:throttler:{tracker}:{key}`   | `@nestjs/throttler` 计数       | 由限流窗口/封禁时长控制                   |
| `nest-admin:cache:{key}`                 | 普通可降级业务缓存             | 使用 CacheService 提供的 TTL              |

表中前缀是逻辑键。通用缓存实际命名空间由 Keyv 的 `redis.key-prefix` 配置控制；强一致键由 Redis 命令服务显式拼接 `nest-admin:`，两套路径不得重复加前缀。读取快照时，比较 snapshot.ver 与全局权限版本号，落后则重算；重算用 SET NX 加短 TTL 互斥锁做单飞，防止缓存击穿。用户会话索引应与会话键在同一原子脚本中维护，按 sid 删除并清理索引，避免通过 `KEYS` 扫描。

| 变更事件                                                       | 动作                                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 角色的菜单、数据范围、状态变化；菜单增删改；部门路径或状态变化 | INCR `nest-admin:auth:perm:ver`，所有人下次请求重算                             |
| 用户的角色或部门变化                                           | DEL `nest-admin:auth:perm:{userId}`                                             |
| 用户停用、删除、重置密码、被踢下线                             | 按 sid 删除该用户全部 `nest-admin:auth:session:*` 键及快照，并清理用户 sid 索引 |

角色与菜单变更频率低，用全局版本号换取实现简单且不会漏失效。用户量超过十万级时，再改为按角色反查用户做精准失效。

### 6.5 菜单路由生成

GET /auth/routers：取快照，超管取全部启用的 M 与 C 菜单，其他用户取 role_menu 并集；过滤掉 status 为 1 的节点；按 parentId 与 orderNum 构树；返回 `{ name, path, component, hidden, meta: { title, icon, noCache }, children }`。GET /auth/profile 返回用户信息、roleKeys 与 perms。前端据此执行 router.addRoute，并用权限指令（如 v-permission）控制按钮显隐。

## 7. 权限核心实现草案（待建设）

以下代码是给实现者的契约，命名与行为需保持一致，细节可按 NestJS 惯例补全。

### 7.1 装饰器

```ts
export const IS_PUBLIC = 'isPublic';
export const PERMS_KEY = 'perms';
export const PERMS_ANY_KEY = 'permsAny';

export const Public = () => SetMetadata(IS_PUBLIC, true);
// 需要同时满足全部标识（AND）
export const RequirePermissions = (...p: string[]) => SetMetadata(PERMS_KEY, p);
// 满足任一标识即可（OR）
export const RequireAnyPermissions = (...p: string[]) => SetMetadata(PERMS_ANY_KEY, p);
// 注入当前用户：@CurrentUser() user: { userId: string; sid: string }
```

### 7.2 权限匹配（纯函数，必须 100% 覆盖测试）

```ts
export function matchPermission(owned: string, required: string): boolean {
  const o = owned.split(':');
  const r = required.split(':');
  for (let i = 0; i < r.length; i++) {
    if (o[i] === '*') return true; // 通配：该段及之后全部放行
    if (o[i] !== r[i]) return false;
  }
  return o.length === r.length; // 防止 system:user 匹配 system:user:add
}
```

应覆盖的用例：精确匹配、`*:*:*`、`system:user:*`、段数不等、空字符串、大小写（要求区分大小写）。

### 7.3 PermissionGuard

```ts
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private permission: PermissionService
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const all = this.reflector.getAllAndOverride<string[]>(PERMS_KEY, targets) ?? [];
    const any = this.reflector.getAllAndOverride<string[]>(PERMS_ANY_KEY, targets) ?? [];
    if (!all.length && !any.length) return true; // 仅要求已登录

    const { userId } = ctx.switchToHttp().getRequest().user;
    const snap = await this.permission.getSnapshot(userId);
    if (snap.isSuper) return true;

    const has = (req: string) => snap.perms.some(o => matchPermission(o, req));
    const ok = all.every(has) && (!any.length || any.some(has));
    if (!ok) throw new ForbiddenException('没有权限访问该资源');
    return true;
  }
}
```

在 apps/gateway 的 AppModule 中以 APP_GUARD 注册，**顺序必须是 JwtAuthGuard 在前、PermissionGuard 在后**。

### 7.4 PermissionService.getSnapshot 的计算步骤

1. 读 Redis `nest-admin:auth:perm:{userId}`，命中且 ver 等于 `nest-admin:auth:perm:ver` 则直接返回。
2. 未命中：获取互斥锁后查库。查出用户及主部门，再查 user_role 关联的、status 为 0 且 delFlag 为 0 的角色。
3. 任一角色 roleKey 为 admin，则 isSuper 为 true，perms 取 `['*:*:*']`，dataScope.all 为 true。
4. 非超管：取 role_menu 关联的菜单，在内存中过滤。过滤规则是菜单自身及其所有祖先的 status 都为 0，且 perms 非空；菜单表体量小，可整表载入内存做祖先链判断。
5. 合并数据范围（见 5.4），写回 Redis 并设置 TTL。
6. 此方法为纯读取，不产生副作用，便于单测时注入假 PrismaService。

### 7.5 数据范围构造器

```ts
interface ScopeOptions {
  deptField?: string;     // 业务表上的部门字段，默认 deptId
  userField?: string;     // 业务表上的创建人字段，默认 userId
  deptRelation?: string;  // 到 Dept 的关系名，默认 dept，用于子树匹配
}

buildWhere(snap: PermissionSnapshot, opt: ScopeOptions = {}): Record<string, unknown> {
  const { deptField = 'deptId', userField = 'userId', deptRelation = 'dept' } = opt;
  const s = snap.dataScope;
  if (snap.isSuper || s.all) return {};

  const or: Record<string, unknown>[] = [];
  if (s.customDeptIds.length) or.push({ [deptField]: { in: s.customDeptIds.map(BigInt) } });
  if (s.dept && snap.deptId) or.push({ [deptField]: BigInt(snap.deptId) });
  if (s.deptAndChild && snap.deptPath)
    or.push({ [deptRelation]: { ancestors: { startsWith: snap.deptPath } } });
  if (s.self) or.push({ [userField]: BigInt(snap.userId) });

  // 没有任何范围时必须返回恒假条件，绝不能返回空对象
  return or.length ? { OR: or } : { [userField]: BigInt(-1) };
}
```

使用规则：

- 数据范围**显式调用**，不做 Prisma 隐式注入。显式更容易测试，也不会在报表等特殊场景里被误伤。
- 查询、详情、修改、删除都要套用。写操作先用带范围条件的 findFirst 确认目标在范围内，再执行变更，避免越权修改（IDOR）。
- 在 User 表上使用 `deptAndChild` 时，deptRelation 就是 User.dept；在没有 dept 关系的业务表上，需要自行加关系或冗余部门路径字段。
- 前缀匹配要走索引：为 sys_dept.ancestors 追加 `varchar_pattern_ops` 索引。

### 7.6 缓存失效事件

Service 在事务提交之后发出事件，PermissionModule 监听并处理：

```ts
this.events.emit('rbac.changed', { scope: 'global' }); // 角色、菜单、部门变更
this.events.emit('rbac.changed', { scope: 'user', userId: '123' }); // 用户角色、部门变更
this.events.emit('rbac.session.revoke', { userId: '123' }); // 停用、删除、重置密码、强退
```

事件必须在事务**提交后**发出，否则可能缓存到旧数据。

### 7.7 现有统一响应与目标认证错误码

当前 `ResponseInterceptor` 成功响应为 `{ code: 0, data, message: '操作成功' }`，`AllExceptionsFilter` 对外统一 `{ code, data: null, message }`，字段校验错误可附带 `errors`。过滤器会把 Prisma P2002 映射为 409、P2025 映射为 404。通用业务码直接使用 HTTP 状态码；模块专属码按现有约定从 100001 起分配，不沿用旧稿的 40101、40102 等编号。access 过期与会话失效的细分码在 Phase 3 的认证常量中确定，并同步前端契约。

| HTTP | code | 含义                          | 前端动作                            |
| ---- | ---- | ----------------------------- | ----------------------------------- |
| 2xx  | 0    | 成功（当前项目约定）          | 正常渲染                            |
| 401  | 401  | access 过期、未登录或会话失效 | 认证模块定义 refresh 与重新登录策略 |
| 403  | 403  | 无权限                        | 提示无权限                          |
| 409  | 409  | 业务冲突，如重复、存在子节点  | 展示 `message`                      |
| 422  | 422  | 参数校验失败                  | 展示字段错误                        |

## 8. 接口清单

以下均为目标 API 契约，当前 gateway 尚未实现这些路由。现有用户骨架路由是 `/<api-prefix>/user` 的 GET、GET `/:id`、POST、PATCH `/:id`、DELETE `/:id`；其中仅列表走数据库分页，其余服务方法返回占位文本。

### 8.1 认证与个人中心（待实现）

| 接口                                  | 权限     | 说明                                          |
| ------------------------------------- | -------- | --------------------------------------------- |
| GET /auth/captcha                     | Public   | 返回 uuid 与图片                              |
| POST /auth/login                      | Public   | 限流，返回 access，refresh 写 HttpOnly Cookie |
| POST /auth/refresh                    | Public   | 轮换 refresh                                  |
| POST /auth/logout                     | 登录即可 | 删除当前会话                                  |
| GET /auth/profile                     | 登录即可 | 用户信息、roleKeys、perms                     |
| GET /auth/routers                     | 登录即可 | 当前用户的菜单路由树                          |
| PUT /auth/profile、PUT /auth/password | 登录即可 | 修改个人资料与密码                            |

### 8.2 系统管理（目标接口）

**路径规范**：资源名用复数，动作词放在资源之后，路径参数一律放在最后一位，不出现 `/:id/动作` 这种形式。例如修改角色状态是 `PUT /system/roles/status/:id`，而不是 `PUT /system/roles/:id/status`。

| 资源     | 接口                                             | 权限标识                            |
| -------- | ------------------------------------------------ | ----------------------------------- |
| 用户     | GET /system/users（分页，带数据范围）            | system:user:list                    |
|          | GET /system/users/:id                            | system:user:query                   |
|          | POST /system/users                               | system:user:add                     |
|          | PUT /system/users/:id（含 roleIds、postIds）     | system:user:edit                    |
|          | PUT /system/users/status/:id                     | system:user:edit                    |
|          | PUT /system/users/password/:id                   | system:user:resetPwd                |
|          | DELETE /system/users/:ids                        | system:user:remove                  |
| 部门     | GET /system/depts（树）                          | system:dept:list                    |
|          | POST、PUT、DELETE /system/depts                  | system:dept:add、edit、remove       |
| 职位     | GET、POST、PUT、DELETE /system/posts             | system:post:list、add、edit、remove |
| 角色     | GET /system/roles                                | system:role:list                    |
|          | POST、PUT、DELETE /system/roles                  | system:role:add、edit、remove       |
|          | PUT /system/roles/status/:id                     | system:role:edit                    |
|          | PUT /system/roles/data-scope/:id                 | system:role:edit                    |
|          | GET /system/roles/menu-ids/:id                   | system:role:query                   |
| 菜单     | GET /system/menus（树）                          | system:menu:list                    |
|          | POST、PUT、DELETE /system/menus                  | system:menu:add、edit、remove       |
| 日志     | GET、DELETE /monitor/login-logs                  | monitor:loginlog:list、remove       |
|          | GET、DELETE /monitor/oper-logs                   | monitor:operlog:list、remove        |
| 在线用户 | GET /monitor/online；DELETE /monitor/online/:sid | monitor:online:list、forceLogout    |

### 8.3 删除与修改的业务约束

- 部门：存在子部门或存在用户时不可删除；移动部门不能移到自己的子孙之下。
- 角色：已分配给用户时不可删除；内置 admin 角色不可改动。
- 菜单：存在子节点或已分配给角色时不可删除。
- 职位：已分配给用户时不可删除。
- 用户：不可删除、停用自己；不可处理 userId 为 1 的超管。

## 9. 目标安全设计与现状差距

本节是 RBAC 上线前的目标控制，不应理解为当前服务已具备这些保护。当前特别需要在认证/权限功能上线前补齐：默认受保护路由与 `@Public()`、DTO 运行时校验管线、登录/刷新/会话撤销、路由权限声明、数据范围及操作审计。仓库目前有 Argon2id、API 加解密、全局限流和通用异常处理，但这些能力不能替代身份认证或 RBAC 授权。

| 维度     | 措施                                                                                                                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 密码     | 使用 `libs/crypto` 已有 Argon2id；目标密码策略至少 8 位且含字母和数字（当前 User DTO 校验长度为 6–128，需随认证策略实施调整）；修改或重置后清除该用户全部会话；Prisma 查询默认 omit password，日志中脱敏 |
| Token    | access 15 分钟；refresh 7 天且轮换，重用即判定泄露；Web 端 refresh 放 HttpOnly、Secure、SameSite=Strict 的 Cookie，access 只放内存；密钥长度至少 32 字节，来自环境变量                                   |
| 暴力破解 | Throttler 限流，加失败锁定，加图形验证码，三层叠加                                                                                                                                                       |
| 输入     | ValidationPipe 开启 whitelist 与 forbidNonWhitelisted；原生 SQL 只允许 Prisma.sql 模板，禁止字符串拼接                                                                                                   |
| 越权     | 所有按 id 的读写都经过数据范围校验；DTO 白名单防批量赋值；遵循 5.6 的授权边界                                                                                                                            |
| 传输     | helmet、CORS 白名单、限制请求体大小、生产强制 HTTPS                                                                                                                                                      |
| 审计     | 写操作一律加 @Log；登录日志记录成功与失败；日志接口只提供查询与清理                                                                                                                                      |
| 最小权限 | 新建角色默认无任何菜单，默认数据范围为仅本人；seed 的 admin 初始密码取自环境变量，首次登录强制修改                                                                                                       |
| 并发     | 角色授权在事务内完成「先删后增」，用 createMany；权限变更事件在提交后发出                                                                                                                                |

## 10. 代码落位约定

| 内容                                                                                         | 落位                                                                                                                                                 |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prisma 模型与 seed                                                                           | prisma/schema.prisma（generator 与 datasource）、prisma/models/（各实体模型）、prisma/seed.ts                                                        |
| 权限标识常量                                                                                 | libs/common                                                                                                                                          |
| 装饰器：@Public、@RequirePermissions、@RequireAnyPermissions、@DataScope、@Log、@CurrentUser | libs/core                                                                                                                                            |
| 权限引擎：matchPermission、PermissionService、DataScopeService、PermissionGuard              | 新增 libs/permission，导出全局 PermissionModule                                                                                                      |
| JwtAuthGuard、JwtStrategy、认证服务                                                          | apps/gateway/src/modules/auth                                                                                                                        |
| 用户、部门、职位、角色、菜单                                                                 | apps/gateway/src/modules/system 下对应目录，各含 controller、service、dto                                                                            |
| 登录日志、操作日志、在线用户                                                                 | apps/gateway/src/modules/monitor；OperLogInterceptor 放 libs/core                                                                                    |
| PrismaService、软删除扩展                                                                    | libs/database                                                                                                                                        |
| Redis 原子命令/强一致存储与共享限流适配器                                                    | 在 `libs/cache` 复用 `RedisConnection`；CacheService 保持可降级语义，新增 Redis 命令服务及 Throttler storage adapter；认证、授权缓存、限流共用此连接 |
| 密码哈希                                                                                     | libs/crypto                                                                                                                                          |
| 单测与 e2e                                                                                   | 单测与源码同目录（\*.spec.ts）；e2e 与测试辅助放 test/                                                                                               |

以上是建议落位，与现有约定冲突时以现有工程为准，但依赖方向不能变：apps 依赖 libs，libs 之间不得反向依赖 apps，业务模块之间不得循环依赖。

## 11. 工作计划

### 11.1 给 AI 执行者的统一约定

1. **一个 Phase 一次任务**：每次只实现一个 Phase，完成并验收后再进入下一个，不要跨 Phase 提前实现。
2. **TDD**：先写失败的测试，再写实现，最后重构。纯函数与权限规则必须先有测试。
3. **完成即全绿**：每个 Phase 结束时 `pnpm lint && pnpm test && pnpm test:e2e` 必须全部通过，并对照该 Phase 的完成标准逐条汇报。
4. **契约不可擅改**：第 4 章的表与字段命名、第 5 章的权限标识规范、第 7 章的接口签名、第 10 章的目录结构不得擅自改动；确需调整，先说明理由并等待确认。
5. **依赖克制**：只使用第 2 章列出的依赖，新增依赖前先说明理由。
6. **提交规范**：Conventional Commits，一个 Phase 至少拆成 3 个以上的小提交。

**通用提示词模板**（把 N 换成阶段号）：

> 请阅读本文档第 4 至第 10 章和 11.1 的约定，实现 Phase N 的全部任务。严格遵循 TDD，完成后运行 lint、单测与 e2e，并逐条对照完成标准汇报结果，不要实现其他 Phase 的内容。

### 11.2 阶段总览

预估按「AI 实现加人工评审」的人天计算，总计约 19.5 人天。

| Phase | 名称                 | 依赖    | 预估 | 核心产出                               |
| ----- | -------------------- | ------- | ---- | -------------------------------------- |
| 0     | 现状盘点与脚手架补齐 | 无      | 1    | 补齐健康检查、校验管线缺口             |
| 1     | 数据层               | 0       | 1    | RBAC schema、迁移、seed、软删除扩展    |
| 2     | 基础设施补齐         | 0       | 1    | 在现有 libs 上补齐缺口                 |
| 3     | 认证                 | 1、2    | 2    | 登录、刷新、登出、会话、JwtAuthGuard   |
| 4     | 权限引擎             | 1、2、3 | 3    | 权限快照、守卫、装饰器、缓存失效       |
| 5     | 部门与职位           | 4       | 1.5  | 部门树、路径维护、职位 CRUD            |
| 6     | 菜单与角色           | 4、5    | 2.5  | 菜单树、角色授权、数据范围设置         |
| 7     | 用户管理             | 5、6    | 2    | 用户 CRUD、关联维护、密码管理          |
| 8     | 数据权限             | 7       | 2    | buildWhere、各接口接入、授权边界       |
| 9     | 审计与在线用户       | 3、4    | 1.5  | 操作日志、登录日志、强退               |
| 10    | 加固与交付           | 全部    | 2    | 路由扫描测试、压测、部署说明、文档     |

### 11.3 各阶段任务与完成标准

#### Phase 0 现状盘点与脚手架补齐（部分已完成）

- 核对运行环境：Node.js 20.19+ 或 22.12+、NestJS 12、Prisma 7；确认 apps/gateway 能正常启动，并记录当前工程是 CommonJS 还是 ESM，后续代码风格与之保持一致。
- Prisma 7、`prisma.config.ts`、adapter、生成目录、迁移脚本和 Vitest 配置已经存在；本阶段不重复实现。需要补充的是 seed 命令、数据库/RBAC 配置项及可重复执行的环境说明。
- 当前配置校验由 `libs/config/src/core` 的配置域解析器完成，不是 class-validator 环境变量类。新增 JWT 和管理员初始密码配置时沿用现有 domain 模式，并为缺失配置写测试。
- 当前没有全局 `ValidationPipe`、`GET /health`；补齐前先确认本地数据库测试策略。
- 核对 e2e：`test/app.e2e-spec.ts`、`test/cache.e2e-spec.ts`、`test/crypto.e2e-spec.ts` 已覆盖基础链路，但依赖数据库/Redis 的场景必须明确是否使用本地服务或独立测试实例。

**完成标准**：保留现有启动、Prisma adapter、基础库测试全绿；新增配置缺失测试与 `/health` 冒烟测试后，再将 Phase 0 标为完成。不要把已经存在的 Prisma/Vitest 接入重复记为待办。

#### Phase 1 数据层

- 按 4.2 在 `prisma/models/` 下写入各实体模型（Role.dataScope 共 6 种取值，见 5.4），**补全每张实体表的 5 个审计字段**；生成迁移，追加 4.3 的部分唯一索引与 ancestors 的 `varchar_pattern_ops` 索引。
- 在 libs/common 编写 `permissions.constant.ts`，集中定义全部权限标识（来源于 8.2 的清单）。
- 编写幂等 seed（在 prisma.config.ts 中登记 seed 命令，使用 upsert）：总公司部门（id 为 1，ancestors 为 /1/）、admin 角色（roleKey 为 admin，dataScope 为 1）、admin 用户（id 为 1，密码取自环境变量并经 libs/crypto 哈希）、完整的系统管理与监控菜单（目录、菜单、按钮，perms 与常量一一对应）、admin 角色关联全部菜单。
- 在 libs/database 完善 PrismaService 与软删除 Client Extension（Client 经 PrismaPg 适配器创建，见 4.5）；这部分当前尚未存在，必须单独增加测试。

**完成标准**：目标 schema 完成后，`prisma migrate reset` 后 seed 可重复执行且不报错；有一个脚本或测试校验「菜单 perms 集合与常量文件完全一致」；软删除扩展有单测，覆盖 findMany、findFirst、findUnique、count。当前不能提前宣称这些标准已满足。

#### Phase 2 基础设施补齐

- **先盘点再补缺口**：逐项核对 libs/core、common、cache、logger、swagger 的现有能力，输出「已有 / 缺失」清单，只实现缺失部分，已有的不重写。
- main.ts：BigInt 序列化、helmet、CORS 白名单、全局 ValidationPipe、Swagger（带 Bearer 认证，沿用 libs/swagger）。
- 沿用现有统一响应 `{ code, data, message }` 与全局异常过滤器；继续覆盖 Prisma 错误映射（P2002 对应 409，P2025 对应 404），不要引入 `msg` 字段。
- requestId（可复用现有 Pino/ Fastify 请求 ID）写入响应头；若数据范围需要跨 await 上下文，再评估 `nestjs-cls`，不要把它作为当前已有依赖。
- libs/cache：把现有 `RedisConnection` 作为唯一客户端 provider 导出供应用内复用；补齐 SET NX、原子 INCR/TTL、Lua/事务和 SCAN 分批删除（禁止使用 KEYS），并提供 Throttler storage adapter。各服务不得自行创建 Redis 客户端；CacheService 仍只用于可降级业务缓存。
- 沿用现有 `PageQueryDto`（字段为 `page`、`pageSize`，上限 200）与分页返回结构；补充 tree.util（列表转树、查祖先链、查子孙），不要把现有分页契约改成 `pageNum` 或上限 100。

**完成标准**：tree.util 与异常过滤器有单测；共享 Throttler 存储有集成测试，能验证两个应用实例共用同一限额；Redis 强一致命令覆盖原子计数、会话轮换、索引清理及故障返回策略；Swagger 页面可访问；任意接口返回的 BigInt 字段均为字符串。

#### Phase 3 认证

- 认证与用户模块直接注入 `libs/crypto` 已有 `PasswordHashService`；仅在需要不同领域命名时增加薄适配，不重复实现哈希。
- 验证码：生成、存 Redis、校验后即删。
- 登录：校验用户状态、密码、失败锁定、写登录日志、更新 loginIp 与 loginDate、创建会话。
- JwtStrategy 与 JwtAuthGuard（支持 @Public，并检查同一 Redis 中的权威会话状态）；全局注册。Redis 不可用时拒绝认证，不回退为无会话校验。
- refresh 轮换，并实现重用检测；同一 refresh 在 10 秒宽限窗口内并发刷新（多标签页场景）不判定为泄露。
- 登出；Throttler 使用 Phase 2 提供的共享 Redis storage，针对登录与验证码接口配置更严格策略。计数、窗口和封禁状态均在同一 Redis 中，安全敏感限流存储异常时拒绝请求。

**完成标准**：e2e 覆盖以下场景——正确与错误密码、用户停用、连续失败锁定、验证码错误、access 过期、refresh 轮换、旧 refresh 重用后整条会话被清除、登出后旧 token 立即失效。

#### Phase 4 权限引擎（整个系统的核心）

- `matchPermission`、`mergeDataScope` 两个纯函数，先写测试。
- PermissionService.getSnapshot：按 7.4 的步骤实现，包含 Redis 缓存、全局版本号比较、SETNX 单飞。
- PermissionGuard、全部装饰器；AppModule 里按「Jwt 在前、Permission 在后」注册。
- 事件监听：`rbac.changed` 与 `rbac.session.revoke` 的处理。
- GET /auth/profile 与 GET /auth/routers。
- 提供一个仅用于测试的受保护控制器，用来驱动 e2e。

**完成标准**：permission 目录单测覆盖率不低于 95%；e2e 验证——无权限返回 403、超管放行、多角色并集、**修改角色菜单后无需重新登录即时生效**、停用角色后即时失效、父菜单停用后子按钮权限消失、缓存命中时不再查库（用查询计数断言）。

#### Phase 5 部门与职位

- Dept：树查询、新增（事务内先插入再更新 ancestors）、修改、移动（事务内批量更新子孙 ancestors，禁止移到自己的子孙之下）、删除约束（有子部门或有用户则拒绝）、状态变更。变更后发出 global 事件。
- Post：CRUD，已分配用户时不可删除，postCode 在未删除记录内唯一。

**完成标准**：ancestors 计算有单测；e2e 验证移动大子树后所有子孙路径正确、非法移动被拒绝、删除约束生效。

#### Phase 6 菜单与角色

- Menu：CRUD 与树查询；结构校验——F 只能挂在 C 之下，C 只能挂在 M 之下，M 与 C 必须有 path，perms 全局唯一；删除约束见 8.3。
- Role：CRUD、状态切换、分配菜单（事务内先删后增并用 createMany）。约定前端提交的 menuIds 包含半选的父节点，后端再校验父链完整，缺失则自动补全。
- 设置数据范围：dataScope 为 2 时写入 role_dept，其余取值清空 role_dept；取值只允许 1 至 6，其中 6 表示部门及以下或本人。
- 内置 admin 角色保护（见 5.3）。每次变更发出 global 事件。

**完成标准**：e2e 验证授权后 /auth/routers 立即变化；admin 角色不可删除、停用、改 key；非法的菜单父子关系被拒绝。

#### Phase 7 用户管理

- 分页查询：关键词、部门（含子部门）、状态、时间范围；详情返回 roleIds 与 postIds。
- 新增（密码强度、userName 唯一、部门存在）、修改（事务内同步更新关联表）、状态切换、重置密码、删除（软删除，支持批量）。
- 保护规则见 5.3；用户角色或部门变更发出 user 事件；停用、删除、重置密码发出 session.revoke 事件。
- 任何响应与日志中都不得出现 password 字段。

**完成标准**：e2e 覆盖完整的增删改查与保护规则；断言响应中不存在 password；重置密码后该用户旧 token 失效。

#### Phase 8 数据权限

- 实现 `DataScopeService.buildWhere`，为各范围组合与「空范围恒假」编写单测。
- 实现 @DataScope 装饰器与拦截器，把快照写入 CLS。
- 接入用户模块的列表、详情、修改、删除、重置密码；写操作先用带范围条件的 findFirst 确认目标在范围内。
- 实现 5.6 的授权边界校验：只能授予自己拥有的角色，不能修改自己的角色，不能操作范围大于自己的用户。

**完成标准**：e2e 矩阵——6 种数据范围乘以列表、详情、修改、删除四类操作；多角色并集；对范围外的 id 一律返回 404，避免泄露数据是否存在；越权授权被拒绝。

#### Phase 9 审计与在线用户

- @Log 装饰器与 OperLogInterceptor：记录标题、方法、URL、IP、脱敏参数（password、token 等字段替换为星号）、耗时、结果；异步写入，不阻塞响应。
- 登录日志与操作日志的分页查询、批量清理接口。
- 在线用户：扫描会话列表，支持强制下线。

**完成标准**：写操作均产生日志且敏感字段已脱敏；日志写入失败不影响业务响应；强退后目标用户的 token 立即失效。

#### Phase 10 加固与交付

- 路由扫描测试：遍历全部路由，非 Public 且前缀为 /system 或 /monitor 的路由必须声明权限，否则测试失败。
- 压测：用 autocannon 压测受保护接口，缓存命中时鉴权开销 P95 小于 20ms。
- 对照第 9 章安全表逐项验收。
- 部署说明（`node dist/apps/gateway/src/main.js` 直接运行，进程守护方式按目标环境自定）、README、导出 OpenAPI 文件供前端生成类型。

**完成标准**：见第 14 章交付验收清单。

## 12. 测试策略（TDD）

| 层级 | 对象                                                                               | 工具与环境                                                     | 要求                                                                             |
| ---- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 单元 | matchPermission、mergeDataScope、buildWhere、tree.util、ancestors 计算、软删除扩展 | Vitest，无外部依赖                                             | permission 目录覆盖率不低于 95%                                                  |
| 集成 | Service 与真实数据库的交互、事务、唯一约束                                         | Vitest 加独立的 PostgreSQL 实例 | 每个测试文件独立 schema 或事务回滚                                                                              |
| e2e  | 登录到鉴权到业务接口的完整链路                                                     | Supertest 加真实 PostgreSQL 与单个共享 Redis 服务              | 覆盖第 11 章各 Phase 的完成标准；验证会话、权限缓存和限流共用同一 Redis endpoint |
| 契约 | 全路由权限声明检查                                                                 | 遍历 Nest 路由元数据                                           | 缺失声明则失败                                                                   |
| 性能 | 缓存命中时的鉴权开销                                                               | autocannon                                                     | P95 小于 20ms                                                                    |

**测试数据工厂**：提供 `createUser`、`createRole`、`createDept`、`createMenu`、`loginAs` 等辅助函数，e2e 中禁止依赖 seed 以外的隐式数据。

**必测的权限场景清单**

- 授权即时生效：修改角色菜单后，用户不重新登录即可获得或失去权限。
- 多角色并集：权限取并集，数据范围按 5.4 合并。
- 状态联动：停用角色、停用父菜单、停用用户后的行为符合 5.5。
- 会话：登出、强退、重置密码、refresh 重用后，旧 token 立即失效。
- 越权：越权读取、修改、删除他人数据均失败，且返回 404；非超管无法给自己提权。
- 保护：admin 用户与角色、最后一个启用的超管无法被破坏。
- 缓存：版本号递增后全员重算；并发重算只查库一次。
- Redis 故障：会话校验与 refresh 失败关闭；登录/验证码限流不能绕过；普通 API 的限流降级行为符合 3.5 的部署约定。
- 共享限流：两个 gateway 实例对相同 tracker/key 计数时遵守同一额度，Redis 键位于 `nest-admin:throttler:` 命名空间。

**验收执行方式**：所有检查在本地开发机执行，不引入 CI 流水线，也不把测试环境固化进仓库。固定顺序为 lint → 单测 → e2e；e2e 依赖的 PostgreSQL 与 Redis 由开发者本地启动，应用配置仍只声明一个 Redis endpoint，测试数据通过独立 schema 与键前缀清理，不为不同功能启动多套 Redis。

## 13. 前端对接要点、风险与演进

### 13.1 前端对接要点

- 登录后依次请求 /auth/profile 与 /auth/routers，用返回的路由树调用 `router.addRoute`，最后追加 404 兜底路由；刷新页面时重新拉取。
- 按钮权限用统一指令或组件，如 `v-permission="'system:user:add'"`，判断依据是 profile 返回的 perms，需支持 `*:*:*` 与通配规则（复用与后端一致的 matchPermission）。
- Token 刷新用「请求队列」模式：遇到 40101 时只发起一次 refresh，其余请求排队，刷新成功后统一重放；refresh 失败则清空状态跳转登录。
- 权限变更对前端不是实时的：后端立即生效，前端在下一次请求遇到 403 或重新进入页面时更新；需要实时的场景可后续增加 SSE 推送「权限已变更」。

### 13.2 风险与对策

| 风险                        | 对策                                             |
| --------------------------- | ------------------------------------------------ |
| BigInt 序列化报错或精度丢失 | 全局 toJSON，接口一律用字符串 ID                 |
| 权限缓存与数据库不一致      | 全局版本号加事务提交后发事件，TTL 兜底           |
| 菜单半选导致路由链断裂      | 后端保存时校验并补全父链                         |
| 超管被误删或误停用          | 服务层硬规则，加最后一个超管保护，加测试         |
| 大部门树移动时锁表时间长    | 单条 SQL 批量前缀替换，放在事务内，低峰执行      |
| 多标签页同时刷新 token      | refresh 重用检测增加 10 秒宽限窗口               |
| 数据范围遗漏某个接口        | 契约测试加代码评审清单，新增列表接口必须声明范围 |

### 13.3 后续演进路线

1. **RBAC1 角色继承**：启用 Role.parentId，快照计算时沿继承链展开。
2. **RBAC2 互斥与基数约束**：增加互斥角色表，在授权校验处拦截。
3. **多租户**：所有表增加 tenantId，并用 Prisma Client Extension 统一注入租户条件，权限缓存键加租户前缀。
4. **ABAC 补充**：对「工作时间内、仅限本人创建」这类条件，在 PermissionGuard 之后增加策略层。
5. **权限变更审批与审计报表**：基于操作日志做权限变更回溯。
6. **字段级权限**：对敏感字段按权限标识做响应裁剪。

## 14. 交付验收清单

- 第 11 章每个 Phase 的完成标准全部满足，lint、单测与 e2e 在本地全绿。
- 第 12 章必测场景清单全部有对应的自动化测试。
- 路由扫描测试通过：没有任何未声明权限的管理类接口。
- 全库搜索确认：不存在明文密码、硬编码密钥、被日志输出的 token。
- permission 目录单测覆盖率不低于 95%，整体不低于 80%。
- 缓存命中时鉴权 P95 小于 20ms，已有压测记录。
- 第 9 章安全表逐项自检并留存记录。
- 按部署说明可在目标环境正常启动，/health 正常，README 与 OpenAPI 文件已提供。

## 15. 阶段修改说明与文档维护约定

本节是后续实施对话的持续约定。开始任何 Phase 前，AI 必须先阅读本文档、检查当前代码与工作区状态，结合第 11 章完成标准确认该阶段的实际缺口；按项目现状实施，不要求用户重复介绍项目背景、技术栈、阶段范围或本文约定。一次对话默认只完成一个 Phase，不跨阶段扩展。用户说“继续”或提出某阶段时，依据本节和下方状态表承接；若当前阶段已完成，则选择状态表中最靠前的未完成阶段。只有遇到会改变既定接口/数据契约的歧义或无法自行解决的阻塞时才向用户澄清。

| 阶段                         | 该阶段要做的事                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase 0 现状盘点与脚手架补齐 | 核实运行环境、启动与部署条件；沿用已有 Prisma 7、配置域、Vitest 和基础库；补齐配置缺失测试、健康检查、验证管线等实际缺口。                                                           |
| Phase 1 数据层               | 增加 RBAC Prisma 模型、迁移、索引、软删除扩展和幂等 seed；落实权限标识常量并验证模型与权限清单。                                                                                     |
| Phase 2 基础设施补齐         | 按现有库能力补缺；完善全局验证、响应/异常边界、序列化、树工具；在 `libs/cache` 复用唯一 Redis 连接，提供原子命令和共享 Throttler 存储，保证会话、权限缓存、限流共用一个 Redis 服务。 |
| Phase 3 认证                 | 实现验证码、登录与失败控制、会话、JWT 守卫、refresh 原子轮换与重放检测、登出；Redis 故障时按本文规定失败关闭。                                                                       |
| Phase 4 权限引擎             | 实现权限匹配、权限快照、守卫与装饰器、缓存版本/失效、菜单路由和数据范围合并基础能力；验证授权变更即时生效。                                                                          |
| Phase 5 部门与职位           | 实现部门树、路径维护、部门移动/删除约束及职位 CRUD，并处理相关权限缓存变更。                                                                                                         |
| Phase 6 菜单与角色           | 实现菜单树和结构约束、角色 CRUD、菜单授权、数据范围配置及内置 admin 保护。                                                                                                           |
| Phase 7 用户管理             | 实现用户查询与 CRUD、角色/职位关联、状态与密码管理、软删除、权限边界及相关会话撤销。                                                                                                 |
| Phase 8 数据权限             | 实现数据范围 where 构造、上下文传递、列表和单条操作接入，以及授权边界校验。                                                                                                          |
| Phase 9 审计与在线用户       | 实现操作/登录日志、脱敏和查询清理；实现在线会话查看与强制下线。                                                                                                                      |
| Phase 10 加固与交付          | 完成路由权限扫描、安全验收、性能测试、部署说明、健康检查、README 和 OpenAPI 交付。                                                                                                   |

### 15.1 阶段状态

| 阶段     | 状态                                     |
| -------- | ---------------------------------------- |
| Phase 0  | 部分已完成，尚待按第 11.3 节完成标准验收 |
| Phase 1  | 未开始                                   |
| Phase 2  | 未开始                                   |
| Phase 3  | 未开始                                   |
| Phase 4  | 未开始                                   |
| Phase 5  | 未开始                                   |
| Phase 6  | 未开始                                   |
| Phase 7  | 未开始                                   |
| Phase 8  | 未开始                                   |
| Phase 9  | 未开始                                   |
| Phase 10 | 未开始                                   |

状态只允许使用“未开始”“进行中”“部分已完成”“已完成”“受阻”，并应在每个 Phase 验收后及时更新。不能仅因代码已写就标记完成；必须满足第 11.3 节该阶段的完成标准，并记录验证结果。若工作被中断，应标记为“进行中”或“部分已完成”，记录已完成与剩余事项，下一次从未完成事项继续。

### 15.2 每个阶段完成后的文档回写

阶段实现与验证通过后，负责实现的 AI 必须在同一变更中更新本文档，再结束该阶段：

1. 更新 15.1 状态表，将该阶段标为“已完成”；若仍有未完成验收项则保持“部分已完成”并列明剩余项。
2. 更新第 1.1 节当前仓库基线，准确记录新增或变化的能力、代码位置及仍未实现的内容。
3. 对照第 11.3 节该阶段任务和完成标准，勾稽实际实现与测试结果；仅当设计契约发生必要变化时才同步修订相关章节，并说明原因，避免文档与代码不一致。
4. 记录运行过的 lint、单测、e2e、构建或其他验收命令及通过/失败结果；未运行的检查明确标为未运行，不得声称通过。
5. 记录阶段偏差、未解决风险和后续事项；若无偏差，也明确写“无”。
6. 更新下一阶段状态为“进行中”仅在其工作确已开始时；否则保持“未开始”。

后续对话不得要求用户再次粘贴上述约定或重述项目背景。AI 应先从本文档的状态表、阶段记录和当前代码推断续接点；用户只需给出新的目标或指出要继续即可。若用户明确要求跳过阶段、修改范围或暂停，则以用户最新指示为准，并同步更新本文档。
