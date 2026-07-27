# Owner Role — Design & Setup Guide

**用途：** 这份文档记录了 "Owner" 这个隐藏最高权限角色的完整设计逻辑、涉及的每一处代码改动、以及从零开始设置到重新分配其他角色权限的完整操作步骤。写这份文档就是为了让你能照着搬到其他 currency 项目（INR / PHP / 等）。

---

## 1. 设计目标（原始需求）

1. 新增一个 **Owner** 角色，永远是系统里权限最高的
2. Owner 能控制全部其他角色的权限
3. **没有任何人**（包括 SuperAdmin）能更改 Owner 的权限
4. Owner 账号**完全隐藏**——不会出现在 Agent Profile 表格、账号列表、任何查询接口里，**除了 Owner 自己能看到自己**
5. SuperAdmin 从此**必须**绑定 Office + IP 白名单才能登录（原本是免检查的）
6. 通用规则：**任何角色都不能管理"等级大于或等于自己"的账号**（同级也不行，只能管严格比自己低的）

## 2. 最终等级体系

```
Owner (4)      — 最高，隐藏，无法通过网站创建/赋予/编辑，不受IP白名单限制
SuperAdmin (3) — 现在也需要 Office + IP 白名单才能登录
Admin (2)
Senior (1)
Agent (0)
```

核心规则只有一条，取代了原本手写的白名单：

> **actor 只能管理 `actor.rank > target.rank` 的账号。同级不能管同级。**

这一条规则自然推导出：SuperAdmin 不能动另一个 SuperAdmin，更不能动 Owner；只有 Owner 能管 SuperAdmin。

---

## 3. 涉及改动的文件清单（共 8 个）

| 文件 | 改动内容 |
|---|---|
| `functions/_shared/accounts.js` | 核心逻辑：`ROLE_RANK`、`ASSIGNABLE_ROLES`、`saveAccount()`、`officeIpCheckPasses()`、`listAccounts()` |
| `functions/api/admin/accounts.js` | 权限判断主逻辑：`canManage()`、`isHiddenTarget()`、save/delete/lock/unlock 全部改用等级比较 |
| `functions/api/auth/login.js` | 登录流程里**独立的**一份 office 检查，同步改 |
| `public/index.html` | 客户端 `ROLE_RANK`、建号/重置密码/Agent Profile 弹窗/锁定按钮/office 显示 |
| `public/accounts-admin.html` | 同样一份客户端 `ROLE_RANK`（这是独立的备用管理页面） |
| `public/threads.html` | 同样一份客户端 `ROLE_RANK`（用于 Recall Chat History 区块的可见性判断） |
| `PROJECT_STATUS.md` | 权限矩阵文档（如果该项目有维护这份文档） |
| （新建）`create-owner-account.js` | 本地跑的脚本，生成写入 Owner 账号的 KV 命令 |

⚠️ **移植前必须做的事**：先在目标项目里搜索 `agent: 0, senior: 1, admin: 2, superadmin: 3` 这个字符串（不带 owner 的版本），**每一处命中都要加上 `, owner: 4`**——这是这次开发中踩到最多次的坑：客户端有好几份独立写死的 `ROLE_RANK`，漏改任何一份，都会导致 Owner 登录后被那个页面当成最低权限 Agent 对待。

```bash
grep -rn "agent: 0, senior: 1, admin: 2, superadmin: 3" --include="*.html" --include="*.js" .
```

---

## 4. 逐文件改动详情

### 4.1 `functions/_shared/accounts.js`

**a) `ROLE_RANK` 加入 owner，并且加一个"可赋予角色"的白名单**

```js
export const ROLE_RANK = { agent: 0, senior: 1, admin: 2, superadmin: 3, owner: 4 };
const VALID_ROLES = Object.keys(ROLE_RANK);
// owner 永远不在这个列表里 —— saveAccount() 靠这个防止任何人被赋予 owner
const ASSIGNABLE_ROLES = VALID_ROLES.filter((r) => r !== "owner");
export function rankOf(role) { return ROLE_RANK[role] ?? ROLE_RANK.agent; }
```

**b) `saveAccount()` 里，role 字段的赋值逻辑改成用 `ASSIGNABLE_ROLES`（不是 `VALID_ROLES`）**

```js
role: role !== undefined
  ? (ASSIGNABLE_ROLES.includes(role) ? role : (existing?.role || "agent"))
  : (existing?.role || "agent"),
```

逻辑说明：如果有人（不管什么等级）传 `role: "owner"`——
- 目标账号已存在 → 保持原有 role 不变（不会被降级，也不会被"提升"成 owner）
- 目标账号不存在（新建）→ 落回 `"agent"`

这样 `saveAccount()` **永远不可能是产生新 owner 的途径**，哪怕上层调用它的代码没做检查。

**c) `officeIpCheckPasses()`：免检查特权从 `superadmin` 换成 `owner`**

```js
export async function officeIpCheckPasses(env, account, request) {
  if (account.role === "owner") return true;   // 原本是 "superadmin"
  if (!account.officeId) return false;
  const office = await getOffice(env, account.officeId);
  const ip = requestIP(request);
  return !!(office && office.allowedIPs.length && office.allowedIPs.includes(ip));
}
```

**d) `listAccounts()`：从数据源头过滤掉 owner，唯一例外是 owner 查自己**

```js
export async function listAccounts(env, { viewerUsername } = {}) {
  const raw = await env.THREADS_KV.get(ACCOUNTS_INDEX_KEY);
  const usernames = raw ? JSON.parse(raw) : [];
  const accounts = await Promise.all(usernames.map((u) => env.THREADS_KV.get(`account:${u}`)));
  return accounts.filter(Boolean).map((a) => JSON.parse(a))
    .filter((a) => a.role !== "owner" || a.username === viewerUsername)
    .map(stripSecret);
}
```

这是**唯一的数据出口**，`anyAdminExists()`、`anySuperAdminExists()`、`GET /api/admin/accounts` 全都走这个函数，所以只改这一处，全站自动生效。`viewerUsername` 不传（默认）就是完全隐藏，包括 owner 查自己也看不到——只有明确传入"当前查询者就是这个用户名"才会放行那一条。

`anyAdminExists()`/`anySuperAdminExists()` 两处内部调用**不需要改**，保持不传参数（安全默认值），这样即使系统里已经有一个隐藏的 Owner，这两个"有没有管理员"的检查依然只看真实的 admin/superadmin 账号，不会被 Owner 的存在干扰。

**e) `getAccount(env, username)` 完全不用改**——这是按用户名精确查找的函数，本来就不该被过滤（不然 Owner 自己都登录不了）。隐藏只发生在"列出所有账号"这个动作上。

---

### 4.2 `functions/api/admin/accounts.js`

**a) 用一个通用函数取代手写白名单**

```js
function canManage(actorRank, targetRank) {
  return actorRank > targetRank;
}

function isHiddenTarget(target, actorRank) {
  return !!target && target.role === "owner" && actorRank < ROLE_RANK.owner;
}
```

**b) 在处理 body 之后、立刻拦截任何想把 role 设成 owner 的请求**

```js
if (body.action === "save" && body.role === "owner") {
  return json({ ok: false, error: "The Owner role cannot be assigned through this interface." }, 403);
}
```

**c) `save` action：拿到 `existingTarget` 之后，先做隐藏判断**

```js
const existingTarget = await getAccount(env, targetUsername);
if (isHiddenTarget(existingTarget, actorRank)) {
  return json({ ok: false, error: "Account not found." }, 404);  // 不是403！避免暴露"存在但没权限"
}
```

**d) 建号时的权限检查，从 `MANAGE_SCOPE[actorRole]` 改成 `canManage()`**

```js
// 创建新账号
if (!canManage(actorRank, rankOf(requestedRole))) {
  return json({ ok: false, error: "You can only create accounts with a role lower than your own." }, 403);
}
```

**e) 编辑已有账号的 role/office/brands/modules，加上"必须严格高于目标等级"这一条**（保留原本"至少要是 superadmin"的门槛，再叠加新规则）

```js
const hasAuthority = actorRank >= ROLE_RANK.superadmin && canManage(actorRank, targetRank);
if (!hasAuthority && !(isSelfPromotionToSuperAdmin && !superAdminAlreadyExists)) {
  return json({ ok: false, error: "You can only change role, office, or access for accounts ranked below your own." }, 403);
}
```

（`isSelfPromotionToSuperAdmin` 这个"零 SuperAdmin 时自我提升"的引导逻辑完全不用动，跟 owner 无关。）

**f) 编辑 fullName/pid，加上"自己或者严格高于目标"**

```js
if (profileChanging && !(actorRank >= ROLE_RANK.admin && (isSelf || canManage(actorRank, targetRank)))) {
  return json({ ok: false, error: "You can only edit profile fields for your own account, or accounts ranked below your own." }, 403);
}
```

**g) 密码重置（assisted reset），同样改用 `canManage()` + 允许重置自己**

```js
if (passwordChanging && !roleChanging && !accessChanging) {
  if (!isSelf && !canManage(actorRank, targetRank)) {
    return json({ ok: false, error: "You can only reset a password for accounts ranked below your own." }, 403);
  }
}
```

**h) `delete` action：同样加隐藏判断 + `canManage()`**

```js
const target = await getAccount(env, body.username);
if (isHiddenTarget(target, actorRank)) return json({ ok: false, error: "Account not found." }, 404);
if (target && !canManage(actorRank, rankOf(target.role))) {
  return json({ ok: false, error: "You can only delete accounts ranked below your own." }, 403);
}
```

**i) `lock`/`unlock` action：原本是"只要是 SuperAdmin 就行，不比较目标等级"——这是个真实漏洞（SuperAdmin 之前可以互相锁），现在补上**

```js
const target = await getAccount(env, body.username);
if (isHiddenTarget(target, actorRank)) return json({ ok: false, error: "Account not found." }, 404);
if (!target) return json({ ok: false, error: "Account not found." }, 404);
if (!(actorRank >= ROLE_RANK.superadmin && canManage(actorRank, rankOf(target.role)))) {
  return json({ ok: false, error: "You can only lock or unlock accounts ranked below your own." }, 403);
}
```

**j) `GET`（账号列表）：owner 查询者能看到自己**

```js
async function handleGet({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  const viewerUsername = auth.account?.role === "owner" ? auth.account.username : undefined;
  return json({ ok: true, accounts: await listAccounts(env, { viewerUsername }) });
}
```

---

### 4.3 `functions/api/auth/login.js`

登录流程里有一份**跟 accounts.js 完全独立**的"没有 Office 就直接拒绝"前置检查，必须单独改，不会因为改了 accounts.js 就自动同步：

```js
// 改之前：
if (!account.officeId && account.role !== "superadmin") { ... }
// 改之后：
if (!account.officeId && account.role !== "owner") { ... }
```

---

### 4.4 客户端文件（`index.html` / `accounts-admin.html` / `threads.html`）

这三个文件**各自独立**写死了一份 `ROLE_RANK`，全部要加 `owner: 4`：

```js
const ROLE_RANK = { agent: 0, senior: 1, admin: 2, superadmin: 3, owner: 4 };
```

漏掉任何一份，效果是：Owner 登录那个页面后，`ROLE_RANK["owner"]` 是 `undefined`，代码里通常写的是 `ROLE_RANK[role] ?? 0` 这种兜底，就会让 Owner 被当成最低等级的 Agent，反而看不到任何管理功能——**这是最容易漏改、也最难自己发现的坑**，因为界面不会报错，只是"权限突然消失"。

**`index.html` 额外要改的地方（因为它是主要的账号管理界面）：**

1. 建账号表单的角色下拉框：从"isSuperAdmin就给4个选项"改成"筛选出严格低于自己等级的角色"
2. Reset Password 可选目标列表：改成"严格低于自己等级 或者 是自己"
3. Agent Profile 弹窗（`openAgentProfileModal`）：Role / Office / Brands / Topic Access / 锁定按钮，从"只看isSuperAdmin"改成"是否真的等级压得住这个具体目标"（`canManageAccess = isSuperAdmin && myRank > targetRank`），否则会出现"UI 显示能改、一点就被服务器拒绝"的体验问题
4. `saveAgentProfileModal()`：判断要不要发送 role/office/brands/modules 字段时，**不要用 `isSuperAdmin` 这个全局变量**，改成检查 DOM 里 `#ap_role` 这个元素是否存在——因为同一个 SuperAdmin 用户，看别人的资料时可能有权限、看另一个 SuperAdmin 时可能没权限，全局变量不够精细，会导致试图读取一个根本没渲染出来的输入框，直接报错崩溃
5. Agent Profile 表格里的 Office 单元格：owner 自己那一行如果没绑 Office，要显示"unrestricted, OK for Owner"，不要显示"⚠️ can't log in"

---

## 5. 创建 Owner 账号（唯一入口：直接写 KV，绕开网站）

**这是刻意设计成这样的**——网站里从前端到后端，没有任何一条路径能把权限提升到 Owner，哪怕账号已经是 SuperAdmin 也不行。唯一方法是直接操作 Cloudflare KV。

### 方法 A：全新创建一个 Owner 账号

用下面这个 Node 脚本在**自己电脑本地**生成账号数据（密码不会发送到任何地方）：

```js
// create-owner-account.js
const crypto = require("crypto");
const PBKDF2_ITERATIONS = 10000; // 要跟 accounts.js 里的 PBKDF2_ITERATIONS_CURRENT 保持一致

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, "sha256").toString("base64");
}

const [, , username, password] = process.argv;
if (!username || !password) {
  console.error("Usage: node create-owner-account.js <username> <password>");
  process.exit(1);
}

const key = username.toLowerCase();
const salt = crypto.randomBytes(16);
const account = {
  username: key,
  salt: salt.toString("base64"),
  hash: hashPassword(password, salt),
  iterations: PBKDF2_ITERATIONS,
  tokenVersion: 0,
  role: "owner",
  officeId: null,
  allowedBrands: "all",
  allowedModules: "all",
  fullName: "",
  pid: "",
  lastActiveAt: null,
  lastPasswordChange: { at: new Date().toISOString(), by: key },
  locked: false,
  lockedAt: null,
  lockedReason: null,
};

console.log(`wrangler kv key put --binding=THREADS_KV "account:${key}" '${JSON.stringify(account)}' --remote`);
console.log(`\n然后把 "${key}" 加进 accounts-index 这个数组（先 wrangler kv key get 看现有内容再拼）：`);
console.log(`wrangler kv key get --binding=THREADS_KV "accounts-index" --remote`);
console.log(`wrangler kv key put --binding=THREADS_KV "accounts-index" '["${key}", ...现有数组内容...]' --remote`);
```

跑法：
```bash
node create-owner-account.js 你的用户名 "你的密码"
```
复制打印出来的两条 `wrangler kv key put` 命令，在自己电脑执行（需要先 `wrangler login`）。

**⚠️ 哈希算法必须完全匹配**：这段脚本用 Node 的 `crypto.pbkdf2Sync`，跟 `accounts.js` 里用 Web Crypto 的 `deriveBits` 必须产出完全一致的哈希（同样是 PBKDF2-HMAC-SHA256，10000 次迭代，32 字节输出），两者已经交叉验证过完全一致，不用担心密码验证不了。

### 方法 B：把现有账号直接升级成 Owner（推荐，保留原密码）

1. 打开 Cloudflare 网页后台 → Workers & Pages → KV → 找到项目绑定的 KV 命名空间
2. 搜索 key：`account:你的用户名`（全小写）
3. 编辑 Value，**只改 `"role"` 这一个字段**，从 `"superadmin"` 改成 `"owner"`，其他字段（尤其是 `salt`/`hash`/`iterations`）一个字都不要动
4. Save
5. 退出网站登录，重新登录一次（浏览器本地存的旧 role 信息要靠重新登录才会刷新）

---

## 6. 创建完 Owner 之后：重新分配其他角色权限

### 6.1 处理"零 SuperAdmin"窗口

如果升级前那个账号**是唯一的 SuperAdmin**，升级后系统里就变成零个 SuperAdmin 了（因为 Owner 从所有统计里都是隐身的，包括"系统里还有没有 SuperAdmin"这个检查）。这会重新打开"零 SuperAdmin 时任何 Admin 可以自我提升"的引导通道——这不是新漏洞，是原本就有的鸡生蛋机制。

**建议立刻用 Owner 权限，去 Agent Profile 手动指定一个信任的账号为 SuperAdmin**，把这个窗口关掉。

### 6.2 用 Owner 权限重新规划权限的操作入口

登录后，Owner 在 **Account Management** 里能看到全部功能且不受限制：
- **Create Account** —— 能建任何等级（除了 owner）的账号
- **Reset Password** —— 能重置任何人的密码，包括 SuperAdmin
- **Whitelist IP** —— 能改任何 Office 的 IP 白名单
- **TG Group / Channel** —— 能改路由
- **Agent Profile** —— 点开任何账号（除了另一个 owner），Role / Office / Brands / Topic Access / 锁定 全部可编辑

### 6.3 验证清单（每个 currency 项目部署后都建议走一遍）

- [ ] Owner 账号能正常登录（不需要绑 Office）
- [ ] 登录后侧边栏 Account Management 下面全部功能都显示、不是灰的
- [ ] Agent Profile 表格里能看到自己（Owner 自己那一行），Office 那一列显示"unrestricted, OK for Owner"而不是报错
- [ ] 用另一个 SuperAdmin 账号登录，Agent Profile 表格里**看不到** Owner 的任何痕迹
- [ ] 用那个 SuperAdmin 账号，试着编辑另一个 SuperAdmin 的 Role/Brands——应该被拒绝
- [ ] 确认现有的每一个 SuperAdmin 账号都绑了 Office + IP 白名单（**部署前必须检查**，不然会直接把人锁在门外登录不了）
- [ ] 用 Admin 账号登录，确认打不开、也碰不到 SuperAdmin 或 Owner 的账号

---

## 7. 移植到其他 currency 项目时的检查清单

1. `functions/_shared/accounts.js`、`functions/api/admin/accounts.js`、`functions/api/auth/login.js` —— 按第 4 节内容对照改
2. 全项目搜索 `agent: 0, senior: 1, admin: 2, superadmin: 3`，**每一处都要加 `, owner: 4`**（这是踩坑最多的地方）
3. 检查该项目是否也有 `accounts-admin.html` 这种独立备用管理页面，一并检查
4. 部署前，**先确认现有 SuperAdmin 账号都绑好 Office**，否则部署即锁死
5. 部署后用第 6.3 节的验证清单走一遍
6. 用第 5 节的脚本/步骤创建（或升级出）该项目自己的 Owner 账号
