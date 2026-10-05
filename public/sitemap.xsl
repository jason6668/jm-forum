<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="1.0"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">
  <xsl:output method="html" encoding="UTF-8" indent="yes"/>
  <xsl:template match="/">
    <html lang="zh-CN">
      <head>
        <meta charset="UTF-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <title>JM 社区 · Sitemap</title>
        <style>
          body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; background: #f4f8f4; color: #1f2a22; }
          .wrap { max-width: 880px; margin: 0 auto; padding: 28px 16px 48px; }
          h1 { font-size: 22px; margin: 0 0 6px; color: #3d6c45; }
          .sub { color: #6b7a6f; font-size: 13px; margin-bottom: 18px; }
          table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 14px rgba(61,108,69,.08); }
          th, td { padding: 9px 12px; font-size: 13px; text-align: left; border-bottom: 1px solid #edf2ed; }
          th { background: #3d6c45; color: #fff; font-weight: 600; }
          tr:last-child td { border-bottom: none; }
          td.url { word-break: break-all; }
          a { color: #2f7d5b; text-decoration: none; }
          a:hover { text-decoration: underline; }
          .foot { margin-top: 16px; color: #8a978d; font-size: 12px; }
          @media (max-width: 640px) { th.freq, td.freq { display: none; } }
        </style>
      </head>
      <body>
        <div class="wrap">
          <h1>JM 社区 · Sitemap</h1>
          <div class="sub">共 <xsl:value-of select="count(sm:urlset/sm:url)"/> 条链接 · 供搜索引擎收录，浏览器打开即为此视图</div>
          <table>
            <tr><th>链接</th><th>最后更新</th><th class="freq">更新频率</th></tr>
            <xsl:for-each select="sm:urlset/sm:url">
              <tr>
                <td class="url"><a href="{sm:loc}"><xsl:value-of select="sm:loc"/></a></td>
                <td><xsl:value-of select="sm:lastmod"/></td>
                <td class="freq"><xsl:value-of select="sm:changefreq"/></td>
              </tr>
            </xsl:for-each>
          </table>
          <div class="foot">JM 社区 · bbs.8818618.xyz</div>
        </div>
      </body>
    </html>
  </xsl:template>
</xsl:stylesheet>
