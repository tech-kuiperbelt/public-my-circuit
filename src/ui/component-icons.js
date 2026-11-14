// 用户自定义元件的内置图标库：稳定的 icon id + 24×24 SVG 路径/文字。
// 图标只影响呈现；definition.icon 由 core 做类型校验，未知 id 由 UI 回退为无图标。

export const COMPONENT_ICON_CATEGORIES = Object.freeze([
  Object.freeze({ id: 'basic', label: '基础逻辑' }),
  Object.freeze({ id: 'combinational', label: '组合逻辑' }),
  Object.freeze({ id: 'sequential', label: '时序逻辑' }),
  Object.freeze({ id: 'arithmetic', label: '算术逻辑' }),
  Object.freeze({ id: 'register', label: '寄存器' }),
  Object.freeze({ id: 'storage', label: '存储与控制' }),
  Object.freeze({ id: 'io', label: '输入输出' })
]);

// 功能模块统一使用矩形轮廓，内部文字为常见缩写。
// 矩形和引脚短线让图标在元件栏、封装预览和图纸上保持一致的电路感。
const MODULE_BOX = 'M4 4h16v16H4z';
const MODULE_PINS = 'M1 9h3M1 15h3M20 12h3';
const MODULE_PINS_3_IN = 'M1 8h3M1 12h3M1 16h3M20 9h3M20 15h3';
const MODULE_PINS_2_IN_2_OUT = 'M1 8h3M1 16h3M20 8h3M20 16h3';

function moduleIcon(id, label, category, summary, io, text, size, extraPaths) {
  return {
    id,
    label,
    category,
    summary,
    io,
    paths: [MODULE_BOX].concat(extraPaths || [MODULE_PINS]),
    texts: [{ value: text, x: 12, y: 12, size }]
  };
}

const ICONS = [
  // 基础逻辑：传统门电路轮廓。
  {
    id: 'NOT',
    label: '非门',
    category: 'basic',
    summary: '把 0 变 1、1 变 0。',
    io: '输入 A；输出 Y = NOT A。',
    paths: [
      'M5 5v14l12-7z',
      'M21 12a2 2 0 1 0-4 0a2 2 0 1 0 4 0',
      'M2 12h3M21 12h1'
    ]
  },
  {
    id: 'AND',
    label: '与门',
    category: 'basic',
    summary: '只有所有输入都为 1 时输出 1。',
    io: '输入 A、B；输出 Y = A AND B。',
    paths: [
      'M4 4h7a8 8 0 0 1 0 16H4z',
      'M2 9h2M2 15h2M19 12h3'
    ]
  },
  {
    id: 'OR',
    label: '或门',
    category: 'basic',
    summary: '只要有任意一个输入为 1，输出就是 1。',
    io: '输入 A、B；输出 Y = A OR B。',
    paths: [
      'M4 4c3 3 3 13 0 16 5 0 11-3 16-8-5-5-11-8-16-8z',
      'M2 9h3M2 15h3M20 12h2'
    ]
  },
  {
    id: 'NAND',
    label: '与非门',
    category: 'basic',
    summary: '与门之后再取反。',
    io: '输入 A、B；输出 Y = NOT (A AND B)。',
    paths: [
      'M4 4h7a8 8 0 0 1 0 16H4z',
      'M21 12a2 2 0 1 0-4 0a2 2 0 1 0 4 0',
      'M2 9h2M2 15h2M21 12h1'
    ]
  },
  {
    id: 'NOR',
    label: '或非门',
    category: 'basic',
    summary: '或门之后再取反。',
    io: '输入 A、B；输出 Y = NOT (A OR B)。',
    paths: [
      'M4 4c3 3 3 13 0 16 5 0 11-3 16-8-5-5-11-8-16-8z',
      'M21 12a2 2 0 1 0-4 0a2 2 0 1 0 4 0',
      'M2 9h3M2 15h3M21 12h1'
    ]
  },
  {
    id: 'XOR',
    label: '异或门',
    category: 'basic',
    summary: '两个输入不同时输出 1，相同时输出 0。',
    io: '输入 A、B；输出 Y = A XOR B。',
    paths: [
      'M4 4c3 3 3 13 0 16 5 0 11-3 16-8-5-5-11-8-16-8z',
      'M1.5 4c3 3 3 13 0 16',
      'M0.5 9h3.5M0.5 15h3.5M20 12h2'
    ]
  },
  {
    id: 'XNOR',
    label: '同或门',
    category: 'basic',
    summary: '两个输入相同时输出 1，不同时输出 0。',
    io: '输入 A、B；输出 Y = NOT (A XOR B)。',
    paths: [
      'M4 4c3 3 3 13 0 16 5 0 11-3 16-8-5-5-11-8-16-8z',
      'M1.5 4c3 3 3 13 0 16',
      'M0.5 9h3.5M0.5 15h3.5',
      'M21 12a2 2 0 1 0-4 0a2 2 0 1 0 4 0',
      'M21 12h1'
    ]
  },
  {
    id: 'DELAY',
    label: 'delay 门',
    category: 'basic',
    summary: '把输入延后一轮再输出，用于保存短暂历史。',
    io: '输入 A；下一个传播轮输出上一轮的 A。',
    paths: [
      'M2 12h4M18 12h4',
      'M6 5h12v14H6z'
    ],
    texts: [{ value: 'τ', x: 12, y: 12, size: 10 }]
  },

  // 组合逻辑：无记忆，输出只由当前输入决定。
  moduleIcon('HA', '半加器', 'combinational',
    '两个 1 位二进制数相加。',
    '输入 A、B；输出和 S、进位 C。',
    'HA', 6.5, ['M1 8h3M1 16h3M20 8h3M20 16h3']),
  moduleIcon('FA', '全加器', 'combinational',
    '两个 1 位数再加一个进位。',
    '输入 A、B、进位 Cin；输出和 S、进位 Cout。',
    'FA', 6.5, MODULE_PINS_3_IN),
  moduleIcon('MUX', '数据选择器', 'combinational',
    '按选择信号从多个输入中选一个输出。',
    '输入 I0、I1、选择 S；输出 Y。',
    'MUX', 6, ['M1 8h3M1 16h3M20 12h3M12 20v2']),
  moduleIcon('DEMUX', '数据分配器', 'combinational',
    '按选择信号把一个输入送到其中一个输出。',
    '输入 I、选择 S；输出 Y0、Y1。',
    'DEMUX', 4.7, ['M1 12h3M20 8h3M20 16h3M12 20v2']),
  moduleIcon('DEC', '译码器', 'combinational',
    '把二进制编码转换成单根有效的输出线。',
    '输入若干地址位；输出中被选中的一根为 1。',
    'DEC', 6, ['M1 9h3M1 15h3M20 7h3M20 11h3M20 15h3M20 19h3']),
  moduleIcon('ENC', '编码器', 'combinational',
    '把多根输入线转换成二进制编码。',
    '输入若干条选择线；输出对应的二进制编码。',
    'ENC', 6, ['M1 7h3M1 11h3M1 15h3M1 19h3M20 9h3M20 15h3']),
  moduleIcon('CMP', '比较器', 'combinational',
    '比较两个数的大小或是否相等。',
    '输入 A、B；输出相等、大于、小于等结果。',
    'CMP', 6, MODULE_PINS_2_IN_2_OUT),

  // 时序逻辑：带状态，输出还取决于历史。
  moduleIcon('SRLATCH', 'SR 锁存器', 'sequential',
    '用置位和复位输入记住 1 位状态。',
    '输入 S、R；输出 Q 及其反相。',
    'SR', 7, MODULE_PINS_2_IN_2_OUT),
  moduleIcon('DLATCH', 'D 锁存器', 'sequential',
    '使能有效时跟随 D，使能无效时保持。',
    '输入 D、使能 E；输出 Q。',
    'DL', 7, MODULE_PINS),
  moduleIcon('DFF', 'D 触发器', 'sequential',
    '在时钟边沿把 D 的值存入并保持。',
    '输入 D、时钟 CLK；输出 Q。',
    'DFF', 6, MODULE_PINS),
  moduleIcon('TFF', 'T 触发器', 'sequential',
    '每来一个有效时钟边沿就翻转输出。',
    '输入 T、时钟 CLK；输出 Q。',
    'TFF', 6, MODULE_PINS),
  moduleIcon('JKFF', 'JK 触发器', 'sequential',
    '兼具置位、复位、保持和翻转功能。',
    '输入 J、K、时钟 CLK；输出 Q。',
    'JKFF', 5, MODULE_PINS),
  moduleIcon('COUNTER', '计数器', 'sequential',
    '每个时钟边沿让计数值加一。',
    '输入时钟 CLK；输出当前计数值。',
    'CNT', 6, MODULE_PINS),

  // 算术逻辑：对多位二进制数做运算。
  moduleIcon('ADD8', '8 位加法器', 'arithmetic',
    '把两个 8 位数相加并产生进位。',
    '输入 A[7:0]、B[7:0]、Cin；输出 S[7:0]、Cout。',
    'ADD8', 5.4, MODULE_PINS),
  moduleIcon('INC', '加一器', 'arithmetic',
    '把输入值加一。',
    '输入 A；输出 A + 1。',
    'INC', 6.3, MODULE_PINS),
  moduleIcon('SUB', '减法器', 'arithmetic',
    '计算两个数之差。',
    '输入 A、B；输出 A - B 及借位。',
    'SUB', 6.3, MODULE_PINS),
  moduleIcon('ALU', '算术逻辑单元', 'arithmetic',
    '按操作码执行加法、减法或逻辑运算。',
    '输入 A、B、操作码；输出运算结果和标志位。',
    'ALU', 6.3, MODULE_PINS),

  // 寄存器：保存一组二进制位。
  moduleIcon('REG', '寄存器', 'register',
    '在时钟边沿保存输入值。',
    '输入 D、时钟 CLK；输出 Q。',
    'REG', 6, MODULE_PINS),
  moduleIcon('REG8', '8 位寄存器', 'register',
    '同时保存 8 位二进制数。',
    '输入 D[7:0]、时钟 CLK；输出 Q[7:0]。',
    'REG8', 5.2, MODULE_PINS),
  moduleIcon('ACC', '累加器', 'register',
    '保存算术运算的中间结果。',
    '输入数据与时钟；输出当前累加值。',
    'ACC', 6, MODULE_PINS),
  moduleIcon('OUT', '输出寄存器', 'register',
    '暂存要送往外部设备的值。',
    '输入数据、时钟；输出稳定的外部数据。',
    'OUT', 6, MODULE_PINS),
  moduleIcon('PC', '程序计数器', 'register',
    '保存下一条指令的地址。',
    '输入跳转地址、时钟；输出当前地址。',
    'PC', 6.5, MODULE_PINS),
  moduleIcon('IR', '指令寄存器', 'register',
    '保存当前正在执行的指令。',
    '输入指令、时钟；输出指令字段。',
    'IR', 6.5, MODULE_PINS),
  moduleIcon('FLAGS', '标志寄存器', 'register',
    '保存零、进位、溢出等状态标志。',
    '输入运算标志、时钟；输出各标志位。',
    'FLAGS', 4.7, MODULE_PINS),

  // 存储与控制。
  moduleIcon('RAM', '随机存储器', 'storage',
    '可读可写的数据存储。',
    '输入地址、数据、写使能；输出读出的数据。',
    'RAM', 5.8, MODULE_PINS),
  moduleIcon('ROM', '只读存储器', 'storage',
    '存放固定程序或常量表。',
    '输入地址；输出对应地址的数据。',
    'ROM', 5.8, MODULE_PINS),
  moduleIcon('CTRL', '控制器', 'storage',
    '根据指令产生各部件需要的控制信号。',
    '输入指令与状态；输出读写、使能等控制线。',
    'CTRL', 5.2, MODULE_PINS),

  // 输入输出：与玩家或外部设备交互。
  {
    id: 'TOGGLE',
    selectable: false,
    label: '拨动开关',
    category: 'io',
    summary: '手动切换并保持 0 或 1。',
    io: '输出 1 位电平，点击后保持新状态。',
    paths: [
      'M7 8h10a4 4 0 0 1 0 8H7a4 4 0 0 1 0-8z',
      'M13.5 12a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0'
    ]
  },
  {
    id: 'BUTTON',
    selectable: false,
    label: '按钮',
    category: 'io',
    summary: '按住时为 1，松开后回到 0。',
    io: '输出 1 位电平，适合手动测试。',
    paths: [
      'M6 10a6 6 0 1 0 12 0a6 6 0 1 0-12 0',
      'M9.5 10a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0',
      'M5 20h14'
    ]
  },
  {
    id: 'LAMP',
    selectable: false,
    label: '指示灯',
    category: 'io',
    summary: '显示输入电平是 0 还是 1。',
    io: '输入 1 位电平；点亮表示 1。',
    paths: [
      'M9 18h6M10 21h4',
      'M8.5 14a5.5 5.5 0 1 1 7 0c-.8.9-1.2 2-1.2 3H9.7c0-1-.4-2.1-1.2-3z'
    ]
  },
  {
    id: 'CLOCK',
    selectable: false,
    label: '时钟',
    category: 'io',
    summary: '周期性产生 0 和 1 交替的信号。',
    io: '输出方波，用于推动触发器和计数器。',
    paths: [
      'M2 12h4v-6h6v12h6V6h4'
    ]
  },
  {
    id: 'CONST1',
    selectable: false,
    label: '常量 1',
    category: 'io',
    summary: '始终输出逻辑 1。',
    io: '输出固定为 1，常用作使能或上拉。',
    paths: [
      'M3 3h18v18H3z'
    ],
    texts: [{ value: '1', x: 12, y: 13, size: 13 }]
  },
  {
    id: 'DISPLAY',
    selectable: false,
    label: '显示器',
    category: 'io',
    summary: '把输入的数字或字母显示出来。',
    io: '输入若干数据位；显示对应的字符。',
    paths: [
      'M3 5h18v14H3z',
      'M7 19v2M17 19v2'
    ],
    texts: [{ value: 'DISP', x: 12, y: 12, size: 5 }]
  }
].map(function (icon) {
  return Object.freeze({
    id: icon.id,
    label: icon.label,
    category: icon.category,
    selectable: icon.selectable !== false,
    summary: icon.summary,
    io: icon.io,
    paths: Object.freeze(icon.paths.slice()),
    texts: Object.freeze((icon.texts || []).map(function (text) {
      return Object.freeze({
        value: text.value,
        x: text.x,
        y: text.y,
        size: text.size
      });
    }))
  });
});

export const COMPONENT_ICONS = Object.freeze(ICONS);

// 这些图标已被内建 meta 元件（NOT/AND/OR）使用，自定义元件不得重复选择。
export const RESERVED_COMPONENT_ICON_IDS = Object.freeze(['NOT', 'AND', 'OR']);

const ICON_BY_ID = new Map(COMPONENT_ICONS.map(function (icon) {
  return [icon.id, icon];
}));

export function getComponentIcon(id) {
  return ICON_BY_ID.get(id) || null;
}

export function hasComponentIcon(id) {
  return ICON_BY_ID.has(id);
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function componentIconSvg(id) {
  const icon = getComponentIcon(id);
  if (!icon) {
    return null;
  }
  const paths = icon.paths.map(function (d) {
    return '<path d="' + d + '"></path>';
  }).join('');
  const texts = icon.texts.map(function (text) {
    return '<text x="' + text.x + '" y="' + text.y + '" ' +
      'text-anchor="middle" dominant-baseline="central" ' +
      'font-family="system-ui, sans-serif" font-size="' + text.size + '" ' +
      'font-weight="700" fill="currentColor" stroke="none">' +
      escapeXml(text.value) + '</text>';
  }).join('');
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
    'aria-hidden="true" focusable="false">' + paths + texts + '</svg>';
}

// 图标悬停帮助：名称 + 中文解释 + 简短功能说明/典型输入输出。
export function componentIconTooltip(id) {
  const icon = getComponentIcon(id);
  if (!icon) {
    return '';
  }
  return icon.label + '：' + icon.summary + (icon.io ? '\n' + icon.io : '');
}

// 收集已被其他自定义元件定义占用的图标 id，用于下拉中禁用重复选择。
export function usedComponentIconIds(definitions, excludeDefinitionId) {
  const used = new Set();
  if (!definitions) {
    return used;
  }
  const entries = definitions instanceof Map
    ? Array.from(definitions.entries())
    : Object.entries(definitions);
  for (const entry of entries) {
    const definitionId = entry[0];
    const definition = entry[1];
    if (excludeDefinitionId && definitionId === excludeDefinitionId) {
      continue;
    }
    const icon = definition && definition.icon;
    if (typeof icon === 'string' && icon.length > 0) {
      used.add(icon);
    }
  }
  return used;
}
