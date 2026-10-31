# 跨平台兼容与验收范围

| 功能 | macOS | Windows |
| --- | --- | --- |
| 启动 | .command / npm launch | .cmd / npm launch，原生Node，不要求WSL |
| 浏览器与1688 | 本机Chrome，独立采集资料 | 本机Chrome，独立采集资料 |
| 图片文字识别 | 系统Vision | 本机Tesseract WASM，中英文模型随npm安装 |
| 图片尺寸读取 | 系统图像组件 | sharp，平台对应的预编译组件 |
| GPT生图与文案 | 本机Codex账号 | 本机Codex账号，支持npm Windows入口与exe |
| 下载清理 | Python + 本机ExifTool | Python + 随可选依赖安装的ExifTool |
| 数据与偏好 | 本机data和output | 本机data和output，互不共享 |

Windows OCR使用本机模型，保留文字框、长图分段、原文和尺寸标注证据。它与Vision不保证逐字一致。仅在尺寸标注与参数文字互证时分配长宽；识别冲突、缺失或方向不明继续待确认。局部标注数字与参数表不一致时，最多重读两个标注区域，不按参数表猜测小数点。

本次实现环境是Mac：会执行原有Mac回归及强制使用Windows同一套OCR引擎的真实图片测试，并测试Windows路径、npm命令入口和分发内容。未在合作伙伴的Windows电脑或其GPT/1688账号上执行真实生图和登录，因此不能把这些本机结果称为Windows整机验收。

GitHub工作流提供原生Windows运行器的后续自动验收。仓库地址、推送和Actions结果未确认前，远程Windows检查保持“未运行”。ARM设备、受公司策略限制的系统以及账号特定的生图能力需另行实测。
