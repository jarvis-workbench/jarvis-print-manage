# PowerShell Script Registry

目录：`electron/config/script/ps`

## 脚本清单

- `printer-open-system-add-wizard.scps1`：打开 Windows 系统“添加打印机”向导。
- `printer-list-installed.scps1`：读取系统打印机与驱动列表（包含后台打印服务状态兜底）。
- `printer-list-usb-ports.scps1`：读取系统 USB 虚拟打印端口列表（例如 `USB001`）。
- `printer-backup-driver.scps1`：按打印机名导出/复制驱动文件并生成备份结果。
- `printer-install-from-backup.scps1`：基于备份索引安装驱动并按条件创建打印机。
- `printer-ping-host.scps1`：检测目标 IP 是否可连通并返回结构化结果。
- `printer-uninstall.scps1`：卸载打印机、驱动并尝试清理残留文件。

## 占位符规范

- 占位符格式：`{{TOKEN_NAME}}`
- 渲染方式：主进程使用正则 `/\{\{([A-Z0-9_]+)\}\}/g` 进行替换。
- 若脚本中存在未替换占位符，会直接抛错，防止参数缺失时执行。

## 防篡改说明

- `sign.json` 记录每个脚本的：
  - 原始脚本哈希：`hash`
  - 与当前 appId 组合后的二次哈希：`appHash`（算法：`sha256(appId + ':' + hash)`）
- 主进程加载脚本时会校验上述两项，不一致则拒绝执行。

## 修改流程

1. 编辑对应 `*.scps1` 脚本。
2. 重新生成 `sign.json` 中哈希值。
3. 启动应用并验证脚本调用链。
