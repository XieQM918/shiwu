# Windows 使用说明

第一版面向Windows 10/11的64位电脑。建议使用正常的本地文件夹，例如 `C:\Work\1688-workbench`；中文和空格路径也支持。首次安装需联网下载npm依赖；图片识别模型安装完成后从本地读取。

## 首次准备

- 安装Node.js 24或更高版本，保留npm组件：[官方安装包](https://nodejs.org/)。
- 安装Google Chrome：[官方下载](https://www.google.com/chrome/)。
- 安装Python 3.9或更高版本，选择安装启动器并加入PATH：[官方Windows安装包](https://www.python.org/downloads/windows/)。不需要另外安装Tesseract、Visual Studio、Apple工具或WSL。
- 在“命令提示符”输入 `npm.cmd install -g @openai/codex`，安装官方Codex CLI。打开项目目录，双击“登录GPT-Windows.cmd”，根据官方登录页面使用**自己的ChatGPT账号**登录。

启动器会在首次运行或依赖更新时执行锁定版本的安装，自动取得本机OCR、中英文模型以及Windows版ExifTool。ExifTool属于可选平台依赖，请不要关闭npm的optional dependencies。图片清理仍使用项目原有Python Skill。

Windows原生Codex使用方式参见 [OpenAI Windows文档](https://learn.chatgpt.com/docs/windows/windows-sandbox)，工作台沿用 [Codex App Server](https://learn.chatgpt.com/docs/app-server)。工作台不修改系统的安全设置或全局Codex配置。

## 每次使用

1. 双击“启动工作台-Windows.cmd”，等待浏览器自动打开；已有服务运行时直接打开现有工作台。
2. 点“登录 / 查看1688”打开采集窗口，用自己的1688账号登录。此窗口和你的日常浏览器资料分开保存。
3. 粘贴链接采集，核对参数，再生成图片或查看上架文案。
4. 关闭网页不会停止服务。使用结束可在启动窗口按Ctrl+C；重启后未完成任务由你选择继续，已完成结果保留。

## 环境检查与常见问题

双击“环境检查-Windows.cmd”，或点击工作台右上角“环境检查”。它会检查组件与登录状态，不调用生图、不读取或展示登录令牌。

- **提示需要Node.js 24：** 安装正确版本，关闭旧终端后重新打开；不要复制Mac的node_modules。`node -v`可查看版本。
- **PowerShell提示不能加载npm.ps1：** 使用“命令提示符”，或使用`npm.cmd`；无需放宽PowerShell执行策略。
- **Python未找到：** 确认安装了Python和启动器，运行`py -3 --version`。必要时将环境变量`WORKBENCH_PYTHON`指向真实的python.exe。Windows应用商店占位命令不等于已经安装Python。
- **清理工具缺失：** 在工程目录执行 `npm.cmd ci --include=optional` 后重新启动。若公司防护软件隔离ExifTool，请按公司的处理流程解决，工作台不会关闭防护或提供未经清理的图片冒充成功。
- **Codex未找到：** 重新安装官方CLI。工作台支持npm的Windows命令入口，也支持用`WORKBENCH_CODEX_BIN`指定codex.exe或官方codex.js；无需共享别人的账号文件。
- **已登录但生图不可用／额度不足：** 打开具体任务查看原因。账号、模型和工具可用性取决于本机实际环境，不自动改用收费图片API。
- **本机识别结果不准确：** Windows和Mac使用不同识别引擎，个别数字或汉字可能不同。保留来源核对；尺寸标注与原文不一致时仍标待确认，不猜小数点或尺寸方向。
- **浏览器未自动打开：** 手动访问 `http://127.0.0.1:3210`，并检查启动窗口是否还在运行。占用端口时可设置`WORKBENCH_PORT`，不得改成对公网监听。

## 更新程序

先停止服务，再`git pull`，然后双击启动。启动器会按依赖锁文件安装更新并重新构建页面。保留`data/`和`output/`即可保留自己的历史、原图、成品与1688登录。

使用GitHub ZIP更新时，建议将新的代码覆盖到原目录；不要删除旧的`data/`和`output/`。首次迁移电脑时需重新登录各账号；不通过GitHub传递数据库、浏览器资料或Codex凭据。
