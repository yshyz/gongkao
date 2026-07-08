# 公考补给站 - 项目说明

## 项目概况
- 网站名：公考补给站（原上岸码头）
- 类型：公考资料分享单页网站
- 部署：GitHub Pages → https://yshyz.github.io/gongkao/
- 仓库：github.com/yshyz/gongkao
- 本地路径：D:\项目\gongkao-site\

## 文件结构
- `index.html` — 唯一的主文件，包含全部内容：
  - 课程数据：`const COURSES = [...]` 数组，格式 `{cat:"分类",year:2027,name:"课程名",quark:"夸克链接",tag:"new"}`
  - 更新日历：`fillCalendar()` 函数里的 `days` 数组
  - 渲染逻辑、样式全部内嵌
- `xhs-copywriting.md` — 小红书/群发文案库
- `wx-group.jpg` — 微信群二维码

## 当前状态（2026年7月）
- 60 门课程（2027新课 + 2026合集）
- 所有链接都是自有夸克永久链接
- 联系方式：只有 QQ群 563208874（微信号已删）
- 公众号：公考补给站，VIP 19.9元买断

## 常见任务
1. **更新课程链接**：在 COURSES 数组里改对应课程的 quark 字段
2. **加每日更新**：改 fillCalendar() 里的 days 数组
3. **部署**：`git add . && git commit -m "更新" && git push`

## 重要约定
- 改动前先说明改什么，用户确认后再动手
- 每次改完先在本地预览，用户确认后再 push
- 课程名、链接不要自己编造，等用户提供
