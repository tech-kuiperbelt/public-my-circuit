// 导入导出编排：文件读取/下载、导出/导入对话框、Session 调用与结果提示。
// 纯数据规则在 src/core/bundle.js；本模块只处理浏览器交互。
import {
  MAX_BUNDLE_BYTES,
  buildExportBundle,
  countState,
  describeReferrer,
  parseBundle
} from '../core/bundle.js';
import { LIBRARY_SCHEMA_VERSION, SESSION_SCHEMA_VERSION } from './session-store.js';

function readFileText(file) {
  if (file && typeof file.text === 'function') {
    return file.text();
  }
  return new Promise(function (resolve, reject) {
    const reader = new FileReader();
    reader.onload = function () { resolve(String(reader.result || '')); };
    reader.onerror = function () { reject(reader.error || new Error('read failed')); };
    reader.readAsText(file);
  });
}

function formatCounts(counts) {
  return '元件 ' + counts.components + '，导线 ' + counts.wires + '，分组框 ' + counts.frames;
}

function formatError(result) {
  if (!result) {
    return '未知错误';
  }
  switch (result.reason) {
    case 'INVALID_JSON':
      return '文件不是有效的 JSON。';
    case 'INVALID_BUNDLE':
      return '文件结构不完整，不是有效的 my-circuit 导出文件。';
    case 'INVALID_FORMAT':
      return '文件格式不正确，不是 my-circuit 导出文件。';
    case 'UNSUPPORTED_VERSION':
      return '文件版本不兼容：' + (result.detail || '未知') + '（当前支持 1）。';
    case 'INVALID_DRAWING':
      return '文件中的主图纸结构无效：' + (result.detail || '未知');
    case 'INVALID_DEFINITIONS':
      return '文件中的自定义元件结构无效：' + (result.detail || '未知');
    case 'NOTHING_SELECTED':
      return '请至少选择主图纸或自定义元件。';
    case 'MISSING_DEFINITION':
      return '缺少定义「' + (result.detail || '?') + '」，文件不完整。' +
        (result.referrer ? '（被' + describeReferrer(result.referrer) + '使用）' : '');
    case 'CONFLICT_REQUIRED': {
      const conflict = result.conflict || {};
      const type = conflict.conflictKind === 'NAME' ? '名称冲突' : '内容冲突';
      return '定义「' + (conflict.name || conflict.id || '?') + '」' + type +
        '，且被' + describeReferrer(result.referrer) + '使用，已取消导入。';
    }
    case 'DEFINITION_INVALID': {
      const definition = result.definition || {};
      return '定义「' + (definition.name || definition.id || '?') + '」校验失败：' +
        (result.detail || '未知错误');
    }
    case 'RECURSIVE_DEFINITION':
      return '定义存在循环引用：' + (result.detail || '未知');
    case 'DRAWING_INVALID':
      return '主图纸结构或求值无效：' + (result.detail || '未知');
    case 'DRAWING_COMPONENTS_OVERLAP':
      return '主图纸内部元件重叠：' + (result.detail || '未知');
    case 'NO_FREE_AREA':
      return '找不到足够的主图纸空白区域，未导入任何内容。';
    case 'READ_ONLY':
      return '当前页面没有编辑权，不能导入。';
    case 'NOT_OWNER':
      return '编辑权已被其他页面接管，导入未保存。';
    case 'REVISION':
      return '主图纸或元件库已被其他页面修改，请重试。';
    case 'SESSION_FLUSH_FAILED':
      return '主图纸保存失败，请先处理。';
    case 'INCOMPATIBLE_LIBRARY':
    case 'INCOMPATIBLE_SESSION':
    case 'CORRUPT_LIBRARY':
    case 'CORRUPT_SESSION':
      return '本地数据不可用，导入未执行。';
    default:
      if (result.error) {
        return (result.error.name || '错误') + '：' + (result.error.message || '未知错误');
      }
      return result.detail || result.reason || '操作失败';
  }
}

function timestampName() {
  const date = new Date();
  const pad = value => String(value).padStart(2, '0');
  return 'my-circuit-' + date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) +
    '-' + pad(date.getHours()) + pad(date.getMinutes()) + '.mycircuit.json';
}

export function createBundleController(options) {
  const app = options.app;
  const session = options.session;
  const dialog = options.dialog;
  const toast = options.toast;
  const fileInput = options.fileInput;
  let busy = false;

  function sessionReady() {
    return Boolean(session && session.getStatus && session.getStatus().ready);
  }

  function canImport() {
    if (!sessionReady()) {
      toast.show('Session 尚未就绪');
      return false;
    }
    if (app.draft) {
      toast.show(app.draft.readOnly ? '请先关闭封装详情' : '请先保存或取消封装编辑');
      return false;
    }
    if (!session.canEdit()) {
      toast.show('当前页面没有编辑权，不能导入');
      return false;
    }
    return true;
  }

  function downloadJson(bundle) {
    const text = JSON.stringify(bundle);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = timestampName();
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  async function exportBundle() {
    if (busy) {
      return;
    }
    if (!sessionReady()) {
      toast.show('Session 尚未就绪');
      return;
    }
    if (app.draft) {
      toast.show(app.draft.readOnly ? '请先关闭封装详情' : '请先保存或取消封装编辑');
      return;
    }
    const library = session.getLibrary();
    const definitions = library && library.definitions ? library.definitions : {};
    const drawingCounts = countState(app.state);
    const drawingTotal = drawingCounts.components + drawingCounts.wires + drawingCounts.frames;
    const definitionCount = Object.keys(definitions).length;
    if (drawingTotal === 0 && definitionCount === 0) {
      toast.show('没有可导出的内容');
      return;
    }
    const selected = await dialog.checks({
      title: '导出',
      message: '选择要写入文件的内容。',
      options: [
        {
          id: 'drawing',
          label: '主图纸',
          description: drawingTotal > 0 ? formatCounts(drawingCounts) : '当前主图纸为空',
          checked: drawingTotal > 0
        },
        {
          id: 'definitions',
          label: '自定义元件',
          description: definitionCount > 0 ? '共 ' + definitionCount + ' 个定义' : '当前没有自定义元件',
          checked: definitionCount > 0,
          disabled: definitionCount === 0
        }
      ],
      confirmLabel: '导出',
      cancelLabel: '取消'
    });
    if (!selected || selected.length === 0) {
      return;
    }
    const includeDrawing = selected.indexOf('drawing') !== -1;
    const includeDefinitions = selected.indexOf('definitions') !== -1;
    const built = buildExportBundle({
      library,
      state: app.state,
      includeDrawing,
      includeDefinitions,
      now: function () { return new Date().toISOString(); },
      schema: { session: SESSION_SCHEMA_VERSION, library: LIBRARY_SCHEMA_VERSION }
    });
    if (!built.ok) {
      await dialog.confirm({
        title: '无法导出',
        message: formatError(built),
        confirmLabel: '知道了',
        hideCancel: true
      });
      return;
    }
    try {
      downloadJson(built.bundle);
      toast.show('已导出文件');
    } catch (error) {
      await dialog.confirm({
        title: '无法导出',
        message: '浏览器拒绝下载文件：' + (error && error.message || error),
        confirmLabel: '知道了',
        hideCancel: true
      });
    }
  }

  function openImportPicker() {
    if (busy || !canImport()) {
      return;
    }
    if (!fileInput) {
      toast.show('文件选择不可用');
      return;
    }
    fileInput.value = '';
    fileInput.click();
  }

  async function handleFile(file) {
    if (busy || !file || !canImport()) {
      return;
    }
    if (file.size > MAX_BUNDLE_BYTES) {
      await dialog.confirm({
        title: '无法导入',
        message: '文件过大（超过 ' + Math.round(MAX_BUNDLE_BYTES / 1024 / 1024) + ' MB）。',
        confirmLabel: '知道了',
        hideCancel: true
      });
      return;
    }
    let text;
    try {
      text = await readFileText(file);
    } catch (error) {
      await dialog.confirm({
        title: '无法读取文件',
        message: String(error && error.message || error),
        confirmLabel: '知道了',
        hideCancel: true
      });
      return;
    }
    const inspected = parseBundle(text);
    if (!inspected.ok) {
      await dialog.confirm({
        title: '无法导入',
        message: formatError(inspected),
        confirmLabel: '知道了',
        hideCancel: true
      });
      return;
    }
    const bundle = inspected.bundle;
    const drawingCounts = bundle.drawing && bundle.drawing.state
      ? countState(bundle.drawing.state)
      : { components: 0, wires: 0, frames: 0 };
    const drawingTotal = drawingCounts.components + drawingCounts.wires + drawingCounts.frames;
    const definitionCount = Object.keys(bundle.definitions || {}).length;
    const availableDrawing = Boolean(bundle.drawing && bundle.drawing.state);
    const availableDefinitions = definitionCount > 0;
    if (!availableDrawing && !availableDefinitions) {
      toast.show('文件中没有可导入的内容');
      return;
    }

    let lastError = '';
    for (;;) {
      const fileDescription = [
        file.name,
        '主图纸：' + (availableDrawing ? formatCounts(drawingCounts) : '无'),
        '自定义元件：' + (availableDefinitions
          ? definitionCount + ' 个' +
            (bundle.includes && bundle.includes.definitions === 'used'
              ? '（该文件仅包含主图纸使用的部分）'
              : '')
          : '无')
      ].join('\n');
      const selected = await dialog.checks({
        title: '导入',
        message: fileDescription + (lastError ? '\n\n' + lastError : ''),
        options: [
          {
            id: 'drawing',
            label: '主图纸',
            description: availableDrawing
              ? (drawingTotal > 0 ? '导入到当前图纸的空白区域，不覆盖现有内容' : '文件主图纸为空')
              : '文件不含主图纸',
            checked: availableDrawing,
            disabled: !availableDrawing
          },
          {
            id: 'definitions',
            label: '自定义元件',
            description: availableDefinitions
              ? '导入不冲突的定义；被引用且冲突时整次取消'
              : '文件不含自定义元件',
            checked: availableDefinitions,
            disabled: !availableDefinitions
          }
        ],
        confirmLabel: '导入',
        cancelLabel: '取消'
      });
      if (!selected || selected.length === 0) {
        return;
      }
      const selection = {
        drawing: selected.indexOf('drawing') !== -1,
        definitions: selected.indexOf('definitions') !== -1
      };
      busy = true;
      let result;
      try {
        result = await session.importBundle(bundle, selection);
      } catch (error) {
        result = {
          ok: false,
          reason: 'IMPORT_FAILED',
          detail: String(error && error.message || error)
        };
      } finally {
        busy = false;
      }
      if (!result.ok) {
        lastError = '导入未完成：' + formatError(result);
        continue;
      }
      if (result.focusBounds && typeof app.centerOnBounds === 'function') {
        app.centerOnBounds(result.focusBounds);
      }
      await showResult(result);
      return;
    }
  }

  async function showResult(result) {
    const lines = [];
    if (result.noop) {
      lines.push('没有需要导入的内容。');
    } else {
      if (result.addedDefinitionIds && result.addedDefinitionIds.length > 0) {
        lines.push('新增自定义元件：' + result.addedDefinitionIds.length + ' 个（已加入元件箱）');
      }
      if (result.identicalDefinitionIds && result.identicalDefinitionIds.length > 0) {
        lines.push('已存在、未重复导入：' + result.identicalDefinitionIds.length + ' 个');
      }
      if (result.drawing) {
        lines.push('主图纸已导入，并放置在当前图纸的空白区域。');
      } else if (result.drawingEmpty) {
        lines.push('文件主图纸为空，未改动当前主图纸。');
      }
    }
    if (result.skippedDefinitions && result.skippedDefinitions.length > 0) {
      lines.push('跳过冲突定义（未被引用）：' +
        result.skippedDefinitions.map(function (item) { return item.name; }).join('、'));
    }
    if (lines.length === 0) {
      toast.show('导入完成');
      return;
    }
    const shouldShow = lines.length > 1 ||
      (result.skippedDefinitions && result.skippedDefinitions.length > 0) ||
      result.noop;
    if (!shouldShow) {
      toast.show(lines[0]);
      return;
    }
    await dialog.confirm({
      title: '导入完成',
      message: lines.join('\n'),
      confirmLabel: '知道了',
      hideCancel: true
    });
  }

  return { exportBundle, openImportPicker, handleFile };
}
