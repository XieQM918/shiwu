# 上传 GitHub 与合作伙伴使用

当前工程仓库：[XieQM918/shiwu](https://github.com/XieQM918/shiwu)。仓库根目录是**本工程目录的代码**，不包含上一级“跨境电商”工作区或本机运行资料。

## 分享前

运行 `npm run check:share`。它检查允许分发的文件，以及当前独立仓库是否已经跟踪数据或凭据；若被跟踪会报错。`.gitignore`不能自动取消已被Git跟踪的文件，所以不能只依赖忽略规则。

运行 `npm run package:project` 可得到 `output/exports/1688-workbench-mac-windows.zip`。该包只包含允许分发的源代码、说明、测试和Skill参考，不包含数据库、登录、个人偏好、成品、node_modules、dist或本机日志。解压后即可作为新仓库的内容。

## 新的空仓库

在GitHub创建空私有仓库后，使用GitHub Desktop的“Add Local Repository / Publish”，或在工程目录运行：

```sh
git init -b main
git add .
npm run check:share
git commit -m "Add Mac and Windows product workbench"
git remote add origin YOUR_GITHUB_REPOSITORY_URL
git push -u origin main
```

将占位地址替换为自己的仓库地址。若仓库非空，应先拉取已有内容并在独立分支整合，不强制覆盖远程历史。

## 合作伙伴获取

伙伴可以克隆以下仓库，或在GitHub点击“Code → Download ZIP”。若未来将仓库设为私有，需先为伙伴授予访问权限。

```sh
git clone https://github.com/XieQM918/shiwu.git
```

按README完成首次准备，再双击Windows启动入口。Code ZIP自带Skill和参考文件；不依赖git子模块或指向作者电脑的符号链接。

代码更新用`git pull`，本机数据继续留在各自电脑。两人同时使用不会占用对方账号、采集队列或数据库。本版不做多人实时资料同步；摄影Skill与初始文案方向随代码共享，个人偏好库保持独立。

## 自动检查

`.github/workflows/compatibility.yml`在推送、拉取请求或手动触发时，在Mac和Windows运行构建、测试、图片OCR及下载清理、界面检查，以及工程ZIP解压后的首次安装启动检查（Windows实际执行.cmd入口）。全部通过后生成一个工程包，在Actions页面的Artifacts下载。

CI不保存账号，不登录1688，不消耗GPT生图额度。伙伴的真实GPT生图和1688验证需要在其电脑上各自完成一次。只有Actions实际运行后显示绿色，才表示对应提交通过了Windows运行器检查；工程中提供工作流不代表已经执行了远程验收。

首个完整工程提交的Windows与Mac检查均已通过：[2026-10-31验收记录](https://github.com/XieQM918/shiwu/actions/runs/41178545999)。后续更新请查看对应提交的检查结果。
