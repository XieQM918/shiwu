#!/bin/zsh
cd "${0:A:h}"
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
if ! command -v node >/dev/null 2>&1 || ! node -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)' 2>/dev/null; then
  print '请先安装 Node.js 24 或更高版本：https://nodejs.org/'
  read 'reply?按回车关闭…'
  exit 1
fi
node scripts/launch.mjs start
if [[ $? -ne 0 ]]; then read 'reply?启动未完成，按回车关闭…'; fi
