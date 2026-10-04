# 全国公司库查询 API（独立服务）

论坛 Vercel Serverless 装不下 1.86GB 的 SQLite（585 万家），所以全库跑在这里，
论坛通过 `COMPANIES_API_URL` 代理查询。评价/提交等写操作仍在论坛主库。

## 部署（VPS，如 18.118.166.53）

```bash
# 1. 下载数据库（约 1.86GB）
mkdir -p /opt/companies-api && cd /opt/companies-api
curl -L -o companies.db \
  https://github.com/jason6668/jm-forum/releases/download/v9-data/companies.db

# 2. 放本目录的 companies-api.js，同目录启动
node --version   # 需要 Node 22+
DB_FILE=/opt/companies-api/companies.db PORT=3457 node companies-api.js
```

## systemd 常驻

```ini
# /etc/systemd/system/companies-api.service
[Unit]
Description=Companies API (jm-forum 全国公司库)
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/companies-api
Environment=DB_FILE=/opt/companies-api/companies.db
Environment=PORT=3457
# Environment=API_KEY=xxx   # 可选：设置后论坛端也要配 COMPANIES_API_KEY
ExecStart=/usr/bin/node companies-api.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now companies-api
curl http://127.0.0.1:3457/stats
```

## 论坛端配置（Vercel → m-teacher-forum → Environment Variables）

- `COMPANIES_API_URL` = `http://VPS公网IP:3457`（或反代域名）
- `COMPANIES_API_KEY` = 与上面 API_KEY 一致（没设就不用加）

改完环境变量后 Redeploy 生效。验证：打开论坛避雷库，搜"腾讯"，看总数是否为百万级。

## 接口（均为 GET，只读）

- `/health`
- `/companies?q=&province=&city=&industry=&tag=&sort=&page=&pageSize=&excludeIds=`
- `/companies/batch?ids=1,2,3`（最多 500）
- `/companies/:idOrName`
- `/meta/industries` `/meta/provinces` `/meta/tags`
- `/stats`
