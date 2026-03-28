# 契约清单：打印机驱动压缩包化字段与 IPC（P1）

更新时间：2026-03-28  
状态：已确认（作为编码实现约束）  
关联看板：`docs/planning/03-打印机驱动压缩包化编码任务看板.md`

## 1. 目标
- 将 P1 所有“字段新增”和“IPC返回扩展”固定为可直接实现的契约，减少编码阶段反复讨论。
- 明确与现有函数的映射：`normalizeIndex`、`backupPrinterDriver`、`installPrinterFromBackup`。

## 2. 当前基线（来自代码）
- `normalizeIndex(raw)` 当前标准化字段：
  - `printerName/driverName/driverVersion/manufacturer/infRelativePath/backupSubDir/backupAt`
  - `portName/portHostAddress/portNumber/environment`
  - `pnpDeviceId/hardwareIds/usbVid/usbPid/usbVidPid/deviceSerial`
- IPC 通道基线：
  - `printers:backup-driver`
  - `printers:install`
  - `drivers:index:get`

## 3. P1 新增字段契约

### 3.1 索引项（`driver-index.json` -> `entries[]`）
新增字段（必填，旧数据走默认值）：
- `archiveFileName: string` 默认 `''`
- `archiveRelativePath: string` 默认 `''`
- `archiveSha256: string` 默认 `''`
- `archiveSize: number` 默认 `0`
- `archiveFormat: 'pdrv.zip' | ''` 默认 `''`
- `extractPolicy: 'cleanup-on-success' | 'keep-on-fail'` 默认 `'cleanup-on-success'`

### 3.2 元数据文件（`driver-backup.json`）
新增字段：
- `archiveFileName`
- `archiveRelativePath`
- `archiveSha256`
- `archiveSize`
- `archiveFormat`

### 3.3 前端类型（`src/env.d.ts`）
- `interface DriverBackupResult` 新增 `archive*` 字段。
- `interface DriverIndexEntry` 新增 `archive*` 与 `extractPolicy` 字段。

## 4. IPC 返回契约（不新增通道）

### 4.1 `printers:backup-driver`
返回体最小新增：
```json
{
  "archiveFileName": "HP-LaserJet-20260328.pdrv.zip",
  "archiveRelativePath": "HP-LaserJet-20260328.pdrv.zip",
  "archiveSha256": "<hex>",
  "archiveSize": 1234567,
  "archiveFormat": "pdrv.zip"
}
```

### 4.2 `drivers:index:get`
`index.entries[]` 最小新增：
```json
{
  "archiveFileName": "HP-LaserJet-20260328.pdrv.zip",
  "archiveRelativePath": "HP-LaserJet-20260328.pdrv.zip",
  "archiveSha256": "<hex>",
  "archiveSize": 1234567,
  "archiveFormat": "pdrv.zip",
  "extractPolicy": "cleanup-on-success"
}
```

### 4.3 `printers:install`
- 入参维持不变。
- 行为新增：若索引含 `archive*`，优先校验压缩包后解压安装。

## 5. 错误码契约
- `ARCHIVE_NOT_FOUND`：索引存在归档字段但文件不存在。
- `ARCHIVE_HASH_MISMATCH`：文件哈希不一致。
- `ARCHIVE_EXTRACT_FAILED`：解压过程失败。
- 返回建议：
```json
{
  "status": "failed",
  "errorCode": "ARCHIVE_HASH_MISMATCH",
  "errorMessage": "...",
  "taskId": "..."
}
```

## 6. C1-C3 逐项实现定义
- C1：`normalizeIndex` 与 `env.d.ts` 新字段默认值生效。
- C2：`backupPrinterDriver` 完成打包、哈希、索引写入。
- C3：`installPrinterFromBackup` 完成“校验 -> 解压 -> 安装 -> 清理/保留”。

## 7. 兼容与回滚
- 兼容：旧索引无 `archive*` 时，按目录路径安装。
- 回滚：通过 `backupArchiveEnabled` 开关回退目录模式；字段保留不回删。
