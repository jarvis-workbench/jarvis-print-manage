# 技术方案：fabric + gl-matrix + html2canvas 渲染与输出链路（V1）

更新时间：2026-03-28
状态：评审中
关联文档：
- `docs/planning/00003-lan-driver-transfer-and-hiprint/00001-主规划.md`
- `docs/planning/00003-lan-driver-transfer-and-hiprint/00004-Socket事件与协议V1草案.md`

## 1. 目标
- 建立统一渲染内核，支持：
  - `render-jpeg`
  - `render-pdf`
  - `render-print`
- 保证模板渲染、截图输出、打印输出使用同一套坐标与变换规则。

## 2. 组件职责
- `fabric`：模板图元管理、画布渲染、对象层级控制。
- `gl-matrix`：矩阵运算（平移/旋转/缩放/组合变换），输出标准化 transform。
- `html2canvas`：将渲染结果快照为位图 Buffer（jpeg/png）。

## 3. 渲染数据流
1. 输入：`template + data` 或 `html`。
2. 归一化：模板字段标准化（单位、字体、图片、条码参数）。
3. 变换计算：
- `localMatrix = T * R * S`
- `worldMatrix = parentWorldMatrix * localMatrix`
4. 画布渲染：fabric 按 worldMatrix 绘制。
5. 输出分流：
- `render-jpeg`：html2canvas -> image buffer
- `render-pdf`：webContents.printToPDF -> pdf buffer
- `render-print`：webContents.print -> callback

## 4. 模块建议
- `src/renderer/print-template-adapter.ts`
- `src/renderer/transform-engine.ts`（gl-matrix）
- `src/renderer/fabric-render-engine.ts`
- `src/renderer/snapshot-engine.ts`（html2canvas）
- `electron/worker/print-render-task.mjs`

## 5. 关键约束
- 所有对象坐标必须经过 `gl-matrix` 输出，禁止在视图层手写坐标补丁。
- `html2canvas` 只负责快照，不负责布局；布局源必须来自模板引擎。
- 大页面输出必须支持分段渲染，避免单次内存峰值过高。

## 6. 失败与降级
- 模板渲染失败：返回 `RENDER_TEMPLATE_INVALID`。
- 快照失败：返回 `RENDER_SNAPSHOT_FAILED`，允许降级 `render-pdf`。
- PDF 失败：返回 `RENDER_PDF_FAILED`，允许降级 `render-print`。

## 7. 性能目标（首版）
- 单页模板渲染：P95 < 500ms。
- `render-jpeg`（A4）：P95 < 1.5s。
- 连续 50 任务无崩溃、无任务卡死。

## 8. 测试建议
- 单测：矩阵计算、模板归一化、错误码映射。
- 集成：`template -> jpeg/pdf/print` 三路一致性。
- 回归：字体、条码、图片资源丢失、超大页面。
