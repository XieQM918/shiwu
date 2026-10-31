# 上传 GitHub 与合作伙伴使用

建议建一个独立的私有仓库，将**本工程目录的代码**作为仓库根目录。不要上传上一级“跨境电商”整个工作区，也不要直接压缩整个电脑上的工作台目录。

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

将伙伴加入私有仓库。他可以克隆，或在GitHub点击“Code → Download ZIP”。按README完成首次准备，再双击Windows启动入口。Code ZIP自带Skill和参考文件；不依赖git子模块或指向作者电脑的符号链接。

代码更新用`git pull`，本机数据继续留在各自电脑。两人同时使用不会占用对方账号、采集队列或数据库。本版不做多人实时资料同步；摄影Skill与初始文案方向随代码共享，个人偏好库保持独立。

## 自动检查

`.github/workflows/compatibility.yml`在推送、拉取请求或手动触发时，在Mac和Windows运行构建、测试、图片OCR及下载清理和界面检查。全部通过后生成一个工程包，在Actions页面的Artifacts下载。

CI不保存账号，不登录1688，不消耗GPT生图额度。伙伴的真实GPT生图和1688验证需要在其电脑上各自完成一次。只有Actions实际运行后显示绿色，才表示对应提交通过了Windows运行器检查；工程中提供工作流不代表已经执行了远程验收。
