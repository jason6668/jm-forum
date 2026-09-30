# JM 社区（NodeSeek 风格论坛）

一个高仿 NodeSeek 视觉与交互的社区论坛，亮色清爽风格界面，前后端一体，支持本地与 Vercel 两种部署方式。

![logo](public/assets/logo.png)

## ✨ 功能特性

| 模块 | 说明 |
|------|------|
| 板块体系 | 日常 / 情报 / 技术 / 交易 / Dev / 测评 / **失业联盟** / **吃瓜区** 八大板块 |
| 帖子信息流 | 最新 / 热门 / 浏览 三种排序，板块 Tab 筛选，置顶 + 推荐阅读标记，**标签聚合页**（点任意标签直达同标签话题） |
| **全国公司避雷库** | **🏢 全国公司库（`/companies`）**：内置 **585 万家真实工商注册企业**（31 省市自治区 1978-2019 年公开工商数据，SQLite + FTS5 中文搜索），**重庆省份默认置顶第一呈现**；支持按省份 / 行业 / 风险标签筛选、危险指数排序、**避雷热榜 / 风险看板 / 红黑榜**；访问者可打星（1-5 星避雷指数）+ 写真实经历评论（**可匿名**）+ 评价点赞 / 踩，一键加入**我的避雷清单**；风险标签（疑似跑路 / 经营异常 / 债务纠纷等）自动识别展示；Vercel 部署自动降级为 3 万条静态名录 |
| **等级与积分** | **10 级经验体系**（初来乍到 → 社区之神）：发帖 / 回帖 / 签到 / 被赞 / 评价公司均可获得经验，升级自动通知；**🍗 鸡腿积分商城**：可兑换头像框 / 永久头衔 / 自定义头衔（7 天）等商品 |
| **社区玩法** | **🍗 打赏**（帖子打赏鸡腿）、**💰 悬赏**（发帖冻结鸡腿，采纳最佳答案自动发放）、**🗳️ 话题投票**（单选 / 多选，实时结果）、**🏅 成就勋章墙**（14 个成就：首帖 / 签到 7 天 / 人气王 / 避雷先锋等）、**🔁 鸡腿可交易**（用户间转账，钱包互通） |
| 交易市场 | 交易板块支持价格展示（💰 徽标），方便 VPS / 域名 / 账号交易 |
| 帖子详情 | 楼主帖 + 评论流（楼层号）、点赞、收藏、分享链接、回复编辑器、**一键引用回复**（点楼层「引用」自动带上原文）、「← 返回列表」链接；**作者 / 管理员可随时编辑、删除自己的帖子**（管理端可编辑任意帖子） |
| **Markdown 编辑器** | 发帖 / 回复均内置**加粗 / 斜体 / 删除线 / 引用 / 代码块 / 链接 / @提及 / 列表 / 标题**工具栏，**所见即所得渲染 + 一键预览切换**，代码高亮不串格式，防 XSS |
| 签到系统 | 每日签到领取 3~5 个「鸡腿」积分，今日签到榜实时排行，签到后面板**即时刷新**（无需手动重载） |
| 排行榜 | 今日签到榜 / 鸡腿总榜 TOP 50，**新增「本周活跃榜」「本月活跃榜」**（按发帖 + 回复数实时统计） |
| 用户空间 | 头像、信任等级、主题数 / 回复数 / 鸡腿统计、TA 的主题列表、**访客一键发私信** |
| **站内私信** | **💬 站内私信系统**：会话列表（未读数徽章）、实时聊天窗、Enter 发送 / Ctrl+Enter 换行、已读回执，顶栏与移动端均有入口 |
| **站内通知** | **🔔 通知铃铛**：收到回复 / 被 @提及 / 收到私信即时提醒，红点未读数、下拉列表一键全部已读、点击直达原帖 |
| **举报机制** | 帖子 / 回复 / 公司评价均可 **🚩 一键举报**（重复举报自动拦截），管理后台有「举报队列」三态处理（待处理 / 已处理 / 已驳回） |
| **暗色模式** | 顶栏 🌙 一键切换亮 / 暗主题，偏好持久化到账号（换设备自动恢复） |
| **数据导出** | 管理后台「💾 数据导出」一键下载**全站 JSON 备份**（用户 / 帖子 / 私信 / 通知 / 举报 / 公司库全量） |
| **PWA 支持** | 可「添加到主屏幕」像 App 一样使用，离线时缓存静态资源、断网自动回退首页 |
| 搜索 | 按标题 / 正文 / 标签全文检索；空关键词自动展示**热门标签引导页**，标签点击直达聚合页 |
| 账号系统 | 注册、登录、退出、登录态持久化（7 天 Cookie） |
| **邀请注册制** | **注册必须持有管理员发放的注册码**，管理后台可批量生成 / 复制 / 删除注册码 |
| 个人设置 | 头像 / Bio / 签名 / Readme / 联系方式 / 屏蔽用户 / 常用偏好 / 首页版块 |
| **角色体系** | **站长（👑 owner）> 管理员（admin）> 成员**，站长可把任意用户设为站长 / 管理员，管理员可升降普通用户，前台全程展示角色徽章 |
| **群通知** | **Telegram 群 + 企业微信（微信群）机器人通知**：新用户注册 / 新帖 / 新回复可独立开关，后台一键测试、自动拉取电报群列表 |
| 管理后台 | `/admin`：仪表盘统计、用户管理（封禁/解封/角色/删除）、注册码管理、板块管理（增删改）、话题管理（置顶/推荐/关闭/删除）、通知设置、**公司避雷库管理**、**举报队列**、**数据导出备份**；用户 / 话题 / 举报列表均**支持分页**（page/pageSize/total/pages） |
| 收藏夹 | 一键收藏帖子，随时回看 |
| 细节体验 | 回到顶部按钮、帖子详情「← 返回」链接、板块徽章 / 标签**可点击跳转**、空搜索自动展示**热门标签引导**、私信页 Ctrl+Enter 快速发送提示、未登录空间页「登录后可发私信」引导、**OG 社交分享标签**（微信 / 外链预览标题摘要）、Toast 轻提示 + 分页条样式补齐、PWA 缓存版本管理（v2） |
| 响应式 | 桌面端右侧栏 + 移动端抽屉导航，PWA 可安装到桌面 / 主屏幕 |

## 🛠 技术栈

- **后端**：Node.js + Express
- **前端**：原生 HTML / CSS / JavaScript 单页应用（无构建步骤）
- **存储**：
  - 本地：`data/db.json`（自动生成，含种子数据）+ **`data/companies.db`（SQLite 全国公司库，Node 22 内置 `node:sqlite`，零外部依赖）**
  - Vercel：自动切换为 **Vercel KV**（Upstash）+ 3 万条静态公司名录降级，无需改代码

## 📁 目录结构

```
forum/
├── server.js              # 后端入口（Express 服务 + 全部 API，兼容本地 & Vercel）
├── notify.js              # 群通知模块（Telegram / 企业微信群机器人）
├── seedCompanies.js       # 125 家真实重庆企业种子数据（公开工商信息，无预设评价）
├── genCompanies.js        # 生成 30000 家重庆企业名录脚本（node genCompanies.js 30000）→ public/data/companies.json
├── package.json           # 依赖清单（express / cookie-parser / bcryptjs）
├── vercel.json            # Vercel 部署配置（serverless 路由）
├── test_upgrade.js        # 玩法升级（等级/商城/打赏/悬赏/投票/成就/交易）回归测试脚本（开发用）
├── test_companies.js      # 公司避雷库回归测试脚本（开发用）
├── test_features.js       # 私信/通知/编辑删除/举报/周月榜/标签/导出/暗色/PWA 集成测试（开发用）
├── start.bat              # Windows 一键启动
├── start.sh               # Linux / macOS 一键启动
├── README.md              # 本教程
├── data/                  # 本地数据目录（db.json + companies.db）
├── _dataset/              # 全国公司库数据构建（不在 forum/ 下时位于上一级 _dataset/）
└── public/                # 前端静态资源
    ├── index.html         # 页面骨架（改站点名在这里）
    ├── manifest.json      # PWA 清单（应用名 / 图标 / 主题色）
    ├── sw.js              # Service Worker（静态缓存 + 离线回退）
    ├── assets/            # logo.png（换成你的 logo 就覆盖这个文件）
    ├── data/companies.json# 3 万条静态名录（Vercel 降级用，勿直接编辑）
    ├── css/style.css      # 亮色清爽主题样式（含暗色主题变量）
    └── js/app.js          # 前端逻辑（路由 / 渲染 / 交互 / Markdown 渲染器）
```

## 🚀 本地快速启动

### 方式一：一键脚本（推荐）

**Windows：** 双击 `start.bat`

**Linux / macOS：**
```bash
chmod +x start.sh && ./start.sh
```

### 方式二：手动启动

```bash
# 1. 进入项目目录
cd forum

# 2. 安装依赖（首次需要）
npm install
# 或使用国内镜像：npm install --registry=https://registry.npmmirror.com

# 3. 启动服务
npm start
```

启动后访问 **http://localhost:3000**

> 首次启动会自动生成 `data/db.json` 并写入演示数据（20 个用户、26 个主题、6 大板块）。

#### 📦 全国公司库数据（可选，1.9 GB）

仓库里**不包含** `data/companies.db`（1.9 GB，超出 GitHub 单文件 100 MB 上限），需要完整全国公司库时从 Release 下载：

```bash
# 下载后放到 data/ 目录即可，服务启动时自动识别
mkdir -p data
curl -L -o data/companies.db \
  https://github.com/jason6668/jm-forum/releases/download/v9-data/companies.db
```

> 文件大小 `1,995,247,616` 字节，SHA256 `20e6cd39b35b5899ed4285801d3fac10a4579981ae7dad26cffdc437703c995e`，下载后可自行校验。
> 不下载也能正常跑：服务会自动回退到 `public/data/companies.json` 的 3 万条静态名录（以重庆为主）。

**⚠️ 已知问题：全文搜索索引不完整。** 当前库中 `companies` 表有 **585 万家**，但 FTS5 索引 `companies_fts` 只覆盖 **82.5 万条**（约 14%），因此搜「教育」「科技」这类常见词可能返回 0 条结果（用省份 / 行业筛选不受影响）。下载后执行以下 SQL 即可重建完整索引（约需十几分钟，库体积会增长到 4 GB 左右）：

```sql
INSERT INTO companies_fts(name, address) SELECT name, address FROM companies;
```

### 默认账号

| 账号 | 密码 | 角色 |
|------|------|------|
| `admin` | `123456` | **站长**（👑 最高权限，已签到状态） |
| `alice` | `123456` | 普通用户 |
| `bob` | `123456` | 普通用户 |

> 新注册的账号当天未签到，可直接体验签到领鸡腿。
> 旧版本数据升级后，原 `admin` 账号会自动升级为**站长**，无需迁移操作。

### 👑 角色体系说明

| 角色 | 权限 |
|------|------|
| **站长（owner）** | 全部权限：管理用户 / 板块 / 话题 / 注册码 / 通知，**可把任意用户设为站长或管理员**，可封禁 / 删除管理员（不能动其他站长） |
| **管理员（admin）** | 管理用户（仅升降普通用户）、板块、话题、注册码、通知设置；**不能**设置站长、不能改其他管理员 / 站长的角色 |
| **成员（user）** | 正常使用论坛 |

- 操作入口：管理后台 → 👥 用户管理 → 角色下拉筛选 / 行内「升管理员 / 👑 设站长 / 降为成员」按钮
- 站长与管理员身份会在**帖子、回复、话题列表、个人空间**处以徽章展示
- 安全规则：不能修改 / 封禁 / 删除自己的账号；同级角色互不可操作

### 🔑 注册码说明（邀请注册制）

- 本站采用**邀请注册制**：新用户注册时必须填写注册码，注册码由管理员发放，**一个码只能用一次**。
- 首次启动会自动生成 **5 个演示注册码**（备注为"演示注册码"），可用管理后台查询：
  1. 用 `admin / 123456` 登录
  2. 右上角头像 → **🛡️ 管理后台** → **🔑 注册码**
  3. 即可查看 / 复制现有码，或批量生成新码（可带备注，如"发给微信好友"）
- 注册码用完就删掉演示码、生成自己的新码即可；已使用的码不可删除。

### 📣 群通知配置（Telegram / 微信群）

后台 **管理后台 → 🔔 通知设置**，可配置两个免费通知渠道，新用户注册、新帖、新回复可独立开关：

**✈️ Telegram 群通知**
1. 在 Telegram 里找 `@BotFather`，发 `/newbot` 按提示创建机器人，拿到 **Bot Token**（形如 `123456:ABC-DEF...`）
2. 把机器人**拉进你的通知群**，在群里随便发一条消息（或私聊机器人）
3. 后台填写 Bot Token → 点 **🔄 拉取会话列表** → 选中目标群，Chat ID 自动填入
4. 打开「启用」开关 → **💾 保存** → **📨 发送测试消息** 验证

**💬 企业微信（微信群）通知**
> 微信群没有开放 API，微信官方方案是**企业微信群机器人**（免费，机器人消息会显示在群聊里）。
1. 打开企业微信 → 目标群 → 右上角「…」→ **群机器人 → 添加机器人** → 复制 **Webhook 地址**
2. 后台粘贴 Webhook → 打开「启用」开关 → 保存 → 测试

> 通知失败不影响论坛功能（静默降级，日志可查）；消息里的帖子链接使用站点地址，线上部署建议设置环境变量 `SITE_URL=https://你的域名`，这样通知里的链接才正确。

## ⚡ 部署到 Vercel（推荐，免费）

本项目已适配 Vercel serverless：`server.js` 导出 Express app，静态资源与 API 统一由它托管，数据持久化使用 **Vercel KV**（无需自备服务器）。

### 第 1 步：推送到 GitHub

```bash
cd forum
git init
git add .
git commit -m "init forum"
# 在 GitHub 新建仓库后：
git remote add origin https://github.com/你的用户名/仓库名.git
git push -u origin main
```

### 第 2 步：Vercel 导入项目

1. 打开 [vercel.com](https://vercel.com) → **Add New… → Project** → 选择刚推的仓库
2. Framework Preset 选 **Other**（无需构建命令、无需输出目录）
3. 点击 **Deploy** 完成首次部署

> 本项目是 Express 服务，`vercel.json` 已把所有请求（含静态资源）转发给 serverless 函数，SPA 路由刷新不会 404。

### 第 3 步：创建 KV 数据库（数据持久化）

1. Vercel 项目 → **Storage → Create Database → KV（Upstash）**
2. 创建后选择 **Connect to Project**，选你的论坛项目
3. 环境变量会自动注入：`KV_REST_API_URL`、`KV_REST_API_TOKEN`

> ⚠️ **这一步不能跳过。** Vercel 环境下全部数据都存在 KV 里（没有本地文件可写）。未配置 KV 时网站照样能打开、也能看到种子数据，但**注册、发帖、回复等所有写入都不会保存**，刷新即丢失、每个实例各看各的。请在把链接发出去之前完成本步。

### 第 4 步：设置 Cookie 密钥

项目 → **Settings → Environment Variables**，添加：

| 变量名 | 说明 |
|--------|------|
| `COOKIE_SECRET` | 任意随机字符串（建议用 `openssl rand -hex 32` 生成），登录态安全靠它 |
| `SITE_URL` | 你的站点地址（如 `https://myforum.vercel.app`），通知消息里的帖子链接用 |

### 第 5 步：重新部署

改动环境变量后需要 **Redeploy**（Deployments → ⋯ → Redeploy）。首次部署完成、KV 为空时，会自动初始化种子数据（含 5 个演示注册码）。

访问 `https://你的项目名.vercel.app` 即可使用，管理员账号 `admin / 123456`（**上线后请立刻改密码**）。

### Vercel 部署注意事项

- **公司库在线上是降级版**：Vercel 是 serverless，没有持久磁盘，`data/companies.db`（全国 585 万家，1.9 GB）无法部署。线上会自动回退到 `public/data/companies.json` 的 **3 万条名录（以重庆为主）**，站点统计里显示的也是这个量级，全国范围内的公司搜索不可用。需要完整的全国公司库，请改用下面的「部署到服务器」方案。
- **Node 版本**：`package.json` 已锁定 `22.x`（`server.js` 用 try/catch 引入 `node:sqlite`，Vercel 上加载不到会自动降级，不影响启动）。Vercel 项目设置里的 Node.js Version 保持默认即可。
- **数据写入有秒级延迟**：为节省 KV 配额，普通写操作（发帖/回帖/签到等）会合并 ~1.2 秒后批量落盘；注册、登录、设置等关键操作立即落盘。刷新后看到新帖略有延迟属正常。
- **备份数据**：Vercel 控制台 → Storage → 你的 KV → **Export**，可导出全部数据 JSON。
- **免费额度**：KV 免费档每月约 3 万次读写 + 1MB 存储，个人论坛完全够用；数据量增长后可升级。
- **本地与线上数据不同步**：本地开发用 `data/db.json`，线上用 KV，两者互不影响。

## 🌐 部署到服务器（Linux 生产环境）

### 第 1 步：安装 Node.js

```bash
# Ubuntu / Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 验证
node -v   # v20.x 以上
npm -v
```

### 第 2 步：上传项目

```bash
# 本地打包（排除 node_modules 和 data）
tar --exclude=node_modules --exclude=data -czf forum.tar.gz forum

# 服务器上传解压
scp forum.tar.gz root@你的服务器IP:/opt/
ssh root@你的服务器IP
cd /opt && tar xzf forum.tar.gz

# 安装依赖
cd forum
npm install --production
```

### 第 3 步：用 PM2 守护进程（开机自启 / 崩溃重启）

```bash
sudo npm install -g pm2

cd /opt/forum
pm2 start server.js --name forum --env production
pm2 save                 # 保存进程列表
pm2 startup              # 按提示执行输出的命令，实现开机自启
```

常用命令：

```bash
pm2 list                 # 查看状态
pm2 logs forum           # 查看日志
pm2 restart forum        # 重启
pm2 stop forum           # 停止
```

### 第 4 步：Nginx 反向代理 + 域名

```bash
sudo apt-get install -y nginx
```

新建站点配置 `/etc/nginx/sites-available/forum`：

```nginx
server {
    listen 80;
    server_name forum.example.com;   # 改成你的域名

    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

启用并重载：

```bash
sudo ln -s /etc/nginx/sites-available/forum /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 第 5 步：HTTPS（免费证书）

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d forum.example.com
# 按提示操作，certbot 会自动改配置并定时续期
```

### 第 6 步：防火墙

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

## 🪟 部署到 Windows 服务器

1. 安装 [Node.js LTS](https://nodejs.org/)（勾选添加到 PATH）
2. 把 `forum` 文件夹放到服务器任意位置
3. 双击 `start.bat` 即可访问 `http://服务器IP:3000`
4. 如需开机自启：任务计划程序 → 创建任务 → 触发器「登录时」/「启动时」→ 操作指向 `start.bat`
5. 如需绑定域名 + HTTPS，可用 Nginx（Windows 版）或 IIS 反向代理，或宝塔面板

## ⚙️ 自定义配置

| 想改什么 | 怎么改 |
|----------|--------|
| 站点名称 | `public/index.html` 中 `<title>` 与 `.site-name`（当前为 "JM 社区"） |
| 专属 Logo | 用你的图片覆盖 `public/assets/logo.png`（保持同名即可，无需改代码） |
| 端口 | 启动前设置环境变量：`PORT=8080 npm start`，或改 `server.js` 中 `PORT` |
| Cookie 密钥 | 设置环境变量 `COOKIE_SECRET=你的随机字符串`（生产环境务必设置） |
| 站点链接（通知用） | 设置环境变量 `SITE_URL=https://你的域名`，通知里的帖子链接即指向它 |
| 亮色主题配色 | `public/css/style.css` 顶部 `:root` 变量 |
| 暗色主题配色 | `public/css/style.css` 中 `html[data-theme="dark"]` 变量块 |
| 注册码 | 管理后台 → 🔑 注册码，可生成 / 复制 / 删除（无需改代码） |
| 公司避雷库 | 本地自动读 `data/companies.db`（全国 585 万家）；Vercel 降级读静态 3 万条；管理后台 → 🏢 公司避雷库：单个添加 / 批量导入 / 编辑 / 删除，也可删除不实评价 |
| 商城商品 | 管理后台 → 🛒 积分商城：上架 / 下架徽章、永久头衔、自定义头衔（可改价格） |
| PWA 图标 | 替换 `public/manifest.json` 中 `icons` 指向的图标文件（建议 512×512 PNG） |

## 🏢 全国公司避雷库说明

- **入口**：顶部导航「🏢 避雷库」，或失业联盟板块顶部的「公司避雷库」banner
- **数据规模**：**585 万家真实工商注册企业**（去重后），覆盖全国 31 省市自治区（1978-2019 年注册），数据源为公开的工商注册信息数据集（CC BY-NC-SA 4.0，仅作避雷参考）
- **重庆置顶**：省份筛选 **重庆默认置顶第一呈现**（列表排序默认重庆优先、其余省份按名称序垫底），方便重庆本地用户优先筛查
- **双模式存储**：
  - **本地 / 服务器**：SQLite（`data/companies.db`，Node 22 内置 `node:sqlite` 模块，零外部依赖）+ **FTS5 trigram 中文全文索引**，任意公司名 / 地址子串毫秒级搜索；按省份 / 行业 / 风险标签筛选、排序、分页
  - **Vercel 降级**：无 SQLite 环境自动回退 `public/data/companies.json` 静态 3 万条名录，功能一致
- **风险标签**：系统按公司名称 / 注册信息自动打标（如「疑似跑路」「经营异常」「债务纠纷」「小额贷款」等 12 类），支持按标签筛选
- **打星规则**：1-5 星即避雷指数（1 星尚可 → 5 星强烈避雷），星级 + 一句话真实经历；同用户可随时更新自己的评价；**支持匿名评价**（不显示用户名与头像）；评价可点赞 / 踩
- **避雷热榜 / 风险看板 / 红黑榜**：`/companies?sort=danger` 危险指数榜、`/companies?sort=reviews` 讨论最多榜、`/companies?sort=rating` 红黑评分榜
- **我的避雷清单**：登录用户可一键把公司加入「🛡️ 我的避雷清单」，随时回看
- **数据构建**（可选，本地部署时）：从公开数据集下载 31 省 CSV 后运行 `_dataset/build_companies_db.js` 生成 `data/companies.db`（详见 `_dataset/README`）
- **风控**：管理员可删除任何不实 / 恶意评价；平台不预设、不背书对真实企业的负面内容，评价内容责任由发布者自负

## 💾 数据备份与迁移

**方式一：管理后台一键导出（推荐）**

管理员登录 → 右上角头像 → 🛡️ 管理后台 → 💾 数据导出 → 下载 `forum-backup-日期.json`，包含**全站全部数据**（用户 / 帖子 / 私信 / 通知 / 举报 / 公司库 / 注册码）。

**方式二：直接备份数据文件**

全部数据都在 `data/db.json` 一个文件里（本地部署）：

```bash
# 备份
cp data/db.json backup_$(date +%F).json

# 恢复：把备份文件拷回 data/db.json 后重启即可
pm2 restart forum
```

> Vercel 部署：KV 控制台 → Storage → 你的 KV → Export 可导出全部数据；恢复时用 Import 或直接覆盖 `forum-backup` 里的同名键。
> 想清空演示数据重新开始：停服 → 删除 `data/db.json` → 启动，会自动重建全新种子数据。

## ❓ 常见问题

**Q：端口被占用怎么办？**
启动前 `PORT=8080 npm start`，或先 `netstat -ano | findstr :3000`（Windows）/ `lsof -i:3000`（Linux）找到占用进程。

**Q：改了站点名/Logo 不生效？**
前端是静态文件，改完 `public/` 后**刷新浏览器（Ctrl+F5 强制刷新）**即可，无需重启后端。

**Q：服务器上中文显示乱码？**
确保服务器终端用 UTF-8 编码（`export LANG=en_US.UTF-8`）；Nginx 已默认 UTF-8。

**Q：忘记管理员密码？**
直接编辑 `data/db.json`，把 `admin` 的 `passwordHash` 替换为任意一个已知账号（如 `alice`）的哈希，重启后用 `alice` 的密码登录 admin。（Vercel 部署：在 KV 控制台导出数据修改后重新导入）

**Q：注册提示"注册码无效 / 已被使用"？**
注册码区分字母大小写不敏感，但 `JM-` 前缀和字母数字要完整输入。一个注册码只能注册一次，用过的码请去管理后台查看状态并生成新码。

**Q：怎么发注册码给朋友？**
管理后台 → 🔑 注册码 → 点「复制」即可粘贴到微信/邮件分发；生成时填备注方便管理（如"发给张三"）。

**Q：怎么把朋友设为站长 / 管理员？**
管理后台 → 👥 用户管理 → 找到该用户 → 点「👑 设站长」或「升管理员」（设站长仅站长本人可操作）。

**Q：微信群怎么收到论坛通知？**
微信个人群没有开放接口，请使用**企业微信群机器人**：企业微信 → 群 → 群机器人 → 添加 → 复制 Webhook 填到后台「通知设置」。机器人发的消息会出现在群聊里（含网页版 / 个人微信端）。

**Q：Telegram 通知拉不到群？**
`getUpdates` 只返回最近 24 小时的会话。请确认：机器人已拉进目标群、群里发过消息（或私聊过机器人）、Bot Token 填写正确，然后再点「拉取会话列表」。

**Q：怎么私信别人？**
打开对方的主页（点头像 / 用户名）→ 点「💬 发私信」；或顶部导航「💬 私信」查看会话列表。消息实时送达，对方顶栏铃铛会亮红点。

**Q：帖子发错了 / 想修改？**
帖子底部有「✏️ 编辑」和「🗑️ 删除」按钮（仅作者本人；管理员可在管理后台或帖子页编辑/删除任意帖子）。编辑支持改标题、正文、标签、板块。

**Q：怎么举报违规内容？**
帖子详情页点「🚩 举报」→ 填写理由，管理员在后台「🚩 举报队列」处理。同一用户对同一内容只能举报一次，重复举报会被拦截。

**Q：Markdown 怎么用？**
发帖 / 回复编辑器上方有工具栏（**B** / *I* / ~~S~~ / 引用 / 代码 / 链接 / @ / 列表 / 标题），点按钮自动插入语法；也可以直接手写 `**加粗**`、`` `代码` ``、`> 引用` 等，发布后自动渲染。

**Q：手机能像 App 一样用吗？**
支持 PWA：用 Chrome / Edge / Safari 打开站点 → 菜单选「添加到主屏幕」，即可像原生 App 一样全屏使用，离线时也能打开已缓存页面。

**Q：怎么备份全站数据？**
管理后台 → 💾 数据导出，一键下载全站 JSON 备份；本地部署也可直接复制 `data/db.json`。恢复：把 JSON 内容写回 `data/db.json`（本地）或 KV（Vercel）后重启。

**Q：可以换数据库吗？**
当前默认 JSON 文件 / Vercel KV 存储，适合个人 / 中小型社区。数据量大后可迁移到 SQLite / MySQL，只需改写 `server.js` 中的存储层函数（`loadDb` / `saveDb`）。

---

祝使用愉快！有任何问题随时反馈。
