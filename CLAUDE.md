# 上岸码头 - 公考资料站

## 项目信息
- **名称**: 上岸码头（公考资料分享站）
- **网站**: https://yshyz.github.io/gongkao/
- **GitHub**: https://github.com/yshyz/gongkao
- **QQ群**: 563208874
- **微信**: zhiaplmm（加微信备注"上岸"拉群）

## 做了什么（2026/06/30）
### 夸克网盘批量分享
- 运行 `quark_share_all.py` 连接 Chrome CDP 9222
- 从网盘"来自：分享"目录下列出 374 个文件夹
- 全部生成分享链接，零失败
- 输出: `C:\Users\13643\Desktop\quark_new_links.json`（去重后 339 门课程）

### 网站重建
- 使用 `build_site.py` 将 339 门课程智能分类写入 `index.html`
- 分类: 国省考980(61)、押题模拟(62)、公考名师(151)、事业单位(6)、时政(39)、公考面试(11)、历年真题(3)、赠送教辅(1)、其他(5)
- 按年份降序排列（最新在前）
- 去掉所有百度网盘链接，全部使用自有夸克链接
- 修复"全部"按钮不响应 bug
- 桌面端右侧悬浮联系栏 + 手机端底部联系栏
- 点击按钮展开显示 QQ群号/微信号，再点复制

### 部署
- `gh auth login` → 创建 yshyz/gongkao 仓库 → `git push`
- 开启 GitHub Pages: https://yshyz.github.io/gongkao/

## 关键路径
- **网站源码**: `D:\项目\gongkao-site\`
- **夸克网盘工具**: `C:\Users\13643\Desktop\QuarkPanTool\`
- **分享链接数据**: `C:\Users\13643\Desktop\quark_new_links.json`
- **链接生成脚本**: `C:\Users\13643\Desktop\quark_share_all.py`
- **网站重建脚本**: `C:\Users\13643\Desktop\build_site.py`

## 日常操作
1. **更新网盘链接**: 启动 Chrome CDP 9222 → 运行 `quark_share_all.py`
2. **重建网站**: 运行 `build_site.py`
3. **部署**: `cd D:\项目\gongkao-site && git add . && git commit -m "更新" && git push`

## 网站交互
- 点击 🐧 按钮展开 QQ群号 → 再点复制
- 点击 💚 按钮展开微信号 → 再点复制
- 搜索框支持搜索课程名/老师/机构
- 分类标签切换 + "全部"按钮
