# 拾物 · 1688 商品与 Etsy 工作台

在自己的电脑上收集1688商品图片、参数，生成Etsy图片与英文上架文案。支持Mac和Windows本机运行。**GitHub同步程序；每个人使用自己的GPT、1688登录和本地资料。**

## Windows 第一次使用

1. 安装 [Node.js 24或更高版本](https://nodejs.org/)、[Google Chrome](https://www.google.com/chrome/) 和 [Python 3.9或更高版本](https://www.python.org/downloads/windows/)。Python安装时勾选启动器及加入PATH，安装后重新打开终端。
2. 从本仓库点击 **Code → Download ZIP** 并解压，或使用Git克隆。进入包含本文件和`package.json`的目录，不要在压缩包内直接启动。
3. 在命令提示符运行 `npm.cmd install -g @openai/codex`。然后双击 **登录GPT-Windows.cmd**，使用你自己的ChatGPT账号登录。首次会安装项目组件、中英文识别模型和Windows下载清理工具。
4. 双击 **启动工作台-Windows.cmd**（或`start-workbench.cmd`），等待自动打开浏览器。保持启动窗口运行。遇到问题可双击 **环境检查-Windows.cmd**。
5. 在工作台点击 **登录 / 查看1688**，在独立采集窗口登录你自己的1688账号。遇到验证码由本人完成，再回工作台继续。

详见 [Windows使用说明](WINDOWS.md)。Windows不需要安装WSL、Apple开发工具，也不需要提供原作者的登录资料。

## Mac 使用

安装Node.js 24+、Google Chrome、本机Python 3与ExifTool后，双击 **启动工作台.command**。图片识别使用macOS Vision，首次识别需要Apple命令行工具。本机Codex可使用 `npm install -g @openai/codex` 安装并用自己的ChatGPT账号登录。

工作台地址默认是 [http://127.0.0.1:3210](http://127.0.0.1:3210)。服务只监听本机，不部署到公网。

## 能做什么

- 批量采集1–30个1688商品；支持标准、手机端和分享短链，保存原图并分开显示规格与参数依据。
- 图片文字识别在本机执行：Mac使用Vision；Windows使用Tesseract及随npm依赖安装的中英文模型。仅采集/OCR不调用付费AI接口。
- 每个规格生成Etsy场景图；每个商品生成英文标题、描述、建议标签与中文核对说明。通过本机已登录Codex调用，不新增付费API密钥。可用功能、额度及生图工具以各自账号实际能力为准；登录成功不等于保证可生图。
- 图片与文案可通过小型“修改”按钮输入要求，保留历史版本；长期偏好须在“修改审阅中心”确认才生效。
- Excel导出已采用的文案及商品/规格表；下载图片自动运行随工程携带的元数据清理Skill。清理文件内来源信息，不处理可见Logo或像素隐形水印。

完整说明见 [使用说明](使用说明.md)。

## 哪些资料不会同步

`data/`保存本机数据库、图片、1688浏览器登录、个人偏好及运行组件；`output/`保存生成任务、图片与导出。它们已加入Git忽略规则，也不会进入工程分享包。Codex使用当前电脑用户自己的本机登录，工程内没有作者的GPT令牌。

因此合作伙伴初次打开时会看到空资料库，需要各自采集；你们各自确认的偏好也不会自动覆盖对方。更新代码请保留自己的`data/`和`output/`，不要把Mac的`node_modules/`复制给Windows。

上传与协作步骤见 [GitHub分发说明](GITHUB.md)，验证范围见 [兼容性记录](COMPATIBILITY.md)。

开发命令：`npm ci --include=optional`、`npm run build`、`npm start`。环境检查：`npm run doctor`。测试：`npm test`、`npm run test:ui`。分享前检查：`npm run check:share`。生成不含本机资料的工程包：`npm run package:project`。
