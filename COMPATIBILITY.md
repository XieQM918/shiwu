# 跨平台兼容与验收范围

| 功能 | macOS | Windows |
| --- | --- | --- |
| 启动 | .command / npm launch | .cmd / npm launch，原生Node，不要求WSL |
| 浏览器与1688 | 本机Chrome，独立采集资料 | 本机Chrome，独立采集资料 |
| 图片文字识别 | 系统Vision | 本机Tesseract WASM，中英文模型随npm安装 |
| 图片尺寸读取 | 系统图像组件 | sharp，平台对应的预编译组件 |
| GPT生图 | 专用Chrome会员网页，指定GPT-6 Luna | 同一网页适配器、独立登录，需账号实测 |
| 上架文案 | 本机Codex账号 | 本机Codex账号，支持npm Windows入口与exe |
| 下载清理 | Python + 本机ExifTool | Python + 随可选依赖安装的ExifTool |
| 数据与偏好 | 本机data和output | 本机data和output，互不共享 |

Windows OCR使用本机模型，保留文字框、长图分段、原文和尺寸标注证据。它与Vision不保证逐字一致。仅在尺寸标注与参数文字互证时分配长宽；识别冲突、缺失或方向不明继续待确认。局部标注数字与参数表不一致时，最多重读两个标注区域，不按参数表猜测小数点。

本次开发环境是Mac，本机完整回归与强制使用Windows同一套OCR引擎的真实图片测试已通过，并测试了Windows路径、npm命令入口和分发内容。

2026-10-31，已发布提交 `011bae2cfeb0dc9e0db29558ee699d8f6ce518cd` 在GitHub原生Windows与Mac运行器上通过依赖安装、构建、功能测试、界面检查及分享检查：[自动验收记录](https://github.com/XieQM918/shiwu/actions/runs/41178545999)。Windows使用本机OCR和ExifTool，Mac使用Vision；测试中的生成任务使用替身，不消耗账号额度。

尚未在合作伙伴的电脑或其GPT/1688账号上执行真实生图和登录。上述自动检查不等同于其账号的整机验收；首次仍需本人登录并检查生图能力。ARM设备、受公司策略限制的系统以及账号特定的生图能力需另行实测。

2026-11-01新增会员网页适配器：目前通过隔离网页及队列测试，真实网页登录、GPT-6 Luna选项、上传与下载尚待完整联调；不沿用此前Codex生图的验收结论。
