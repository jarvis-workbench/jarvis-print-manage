# 草案：Socket 事件与协议 V1（对标 electron-hiprint）

更新时间：2026-03-28
状态：评审中
关联文档：
- `docs/planning/00003-lan-driver-transfer-and-hiprint/00001-主规划.md`
- `docs/planning/00003-lan-driver-transfer-and-hiprint/00008-IPC与数据契约草案.md`

## 1. 协议目标
- 最大化兼容 `electron-hiprint` 常用事件，降低外部业务迁移成本。
- 协议分层：`socketProtocolVersion` 与 `lanProtocolVersion` 独立演进。

## 2. 连接参数
- 默认地址：`http://127.0.0.1:17521`
- 认证：`auth.token`（可为空，若本地配置要求 token 则强校验）
- 建议配置：`transports=['websocket']`

## 3. 客户端 -> 服务端事件
- `getClientInfo`
- `refreshPrinterList`
- `getPaperSizeInfo`
- `news`（HTML/PDF/URL-PDF/Blob-PDF 打印）
- `printByFragments`（大 HTML 分片）
- `render-jpeg`
- `render-pdf`
- `render-print`

## 4. 服务端 -> 客户端事件
- `clientInfo`
- `printerList`
- `paperSizeInfo`
- `success` / `error`
- `render-jpeg-success` / `render-jpeg-error`
- `render-pdf-success` / `render-pdf-error`
- `render-print-success` / `render-print-error`

## 5. 关键 payload（草案）

### 5.1 `news`
```json
{
  "templateId": "biz-001",
  "printer": "Printer Name",
  "type": "html|pdf|url_pdf|blob_pdf",
  "html": "<html>...</html>",
  "pdf_path": "https://.../a.pdf",
  "pdf_blob": "<Uint8Array>",
  "pageSize": { "width": 60000, "height": 80000 },
  "copies": 1,
  "silent": true,
  "rePrintAble": true
}
```

### 5.2 `success`
```json
{
  "templateId": "biz-001",
  "msg": "打印成功",
  "taskId": "print-task-uuid"
}
```

### 5.3 `error`
```json
{
  "templateId": "biz-001",
  "msg": "打印失败",
  "code": "PRINT_EXEC_FAILED",
  "taskId": "print-task-uuid"
}
```

## 6. 错误码建议
- 连接与鉴权：`SOCKET_AUTH_FAILED`、`SOCKET_PROTOCOL_MISMATCH`
- 打印阶段：`PRINT_PRINTER_NOT_FOUND`、`PRINT_PRINTER_UNAVAILABLE`、`PRINT_EXEC_FAILED`
- 渲染阶段：`RENDER_TEMPLATE_INVALID`、`RENDER_SNAPSHOT_FAILED`、`RENDER_PDF_FAILED`
- 数据阶段：`PAYLOAD_INVALID`、`PAYLOAD_TOO_LARGE`

## 7. 兼容策略
- V1 兼容 `electron-hiprint` 主事件名；新增字段一律可选。
- 重大变更时升级 `socketProtocolVersion`，并在握手阶段声明能力。

## 8. 安全与限流
- `maxHttpBufferSize` 设置上限，防止超大 payload 压垮进程。
- 单连接并发任务限制（默认 1）。
- 连续认证失败触发短时限流。
