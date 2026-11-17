/**
 * Client half of the group-chat bundle.
 *
 * It contributes a right-sidebar tab (type + body + chip title) and a composer-dock
 * launcher. The tab renders two panes: the room list on the left, the conversation on
 * the right; dialogs handle create / add-member / remove.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-group-chat',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 宿主注入的原生目录选择器（ctx.uiWorkspace），没有时退回手填路径。 */
    let workspaceApi = null

    const API = '/group-chat/api/'
    /** Right-sidebar tab identity: the type id is also the key of its body and title. */
    const TAB_ID = '@local/dsh-group-chat'
    const TAB_KIND = 'group-chat'
    const MODE_KEY = 'dsh-group-chat.takeoverMode'
    const READS_KEY = 'dsh-group-chat.reads'

    const CHANNELS = [
      { value: 'codex', label: 'codex', sub: '子进程 · 用你的 Codex 登录' },
      { value: 'claude', label: 'claude', sub: '子进程 · 用你的 Claude Code 登录' },
      { value: 'dsh', label: 'dsh', sub: '原生模型 · 最省钱' },
    ]
    const TEMPLATES = [
      { value: '', label: '不预置成员' },
      { value: 'dev', label: '开发（架构/实现/审校）' },
      { value: 'review', label: '评审（主审/复核）' },
      { value: 'research', label: '调研（调研/收敛）' },
    ]

    /**
     * 角色预设：身份 + 关注范围 + 输出形态。评审类一律写明"只给意见不改文件"，
     * 因为 codex / claude 成员本身是有写权限的子进程。
     */
    const ROLES = [
      {
        value: 'architect',
        label: '架构师',
        name: '架构师',
        channel: 'codex',
        role: '你是资深架构师。负责拆解需求、划定模块边界与数据流，给出取舍理由和最小可行方案；先给结论再给依据，不写大段代码。',
      },
      {
        value: 'reviewer',
        label: '代码评审',
        name: '评审',
        channel: 'claude',
        role: '你是严格但具体的代码评审。逐条指出问题：位置（文件:行）+ 严重级别（阻断 / 建议）+ 改法；只给意见、不直接改文件；没发现问题要明确说无异议。',
      },
      {
        value: 'backend',
        label: '后端实现',
        name: '后端',
        role: '你是后端工程师。给出可直接落地的实现：关键代码、接口契约、错误处理与边界条件；动手前先说明要改哪些文件，改动尽量小。',
      },
      {
        value: 'frontend',
        label: '前端实现',
        name: '前端',
        role: '你是前端工程师。关注状态管理、交互细节、可访问性，以及空态 / 错态 / 加载态；给出可运行的代码与样式取舍理由。',
      },
      {
        value: 'qa',
        label: '测试',
        name: '测试',
        channel: 'claude',
        role: '你是测试工程师。设计覆盖正常路径、边界值、异常路径的用例，写确定性且可独立运行的测试；说明覆盖了哪些风险，不猜未定义的行为。',
      },
      {
        value: 'security',
        label: '安全评审',
        name: '安全',
        role: '你是安全评审。检查鉴权与越权、注入、SSRF、密钥硬编码、上传与回调校验；按严重级别给出位置和修法，默认只读不改。',
      },
      {
        value: 'performance',
        label: '性能评审',
        name: '性能',
        role: '你是性能评审。关注 N+1、全表扫描、无界内存、热路径与并发；给出可量化的判断依据（复杂度 / 次数 / 体积），缺数据就说明需要什么才能判断。',
      },
      {
        value: 'dba',
        label: '数据 / SQL',
        name: 'DBA',
        role: '你是数据库与 SQL 评审。检查索引与最左前缀、执行计划、分页 count 开销、事务边界与锁；给出 EXPLAIN 要关注的点以及具体改法。',
      },
      {
        value: 'devops',
        label: '运维 / CI',
        name: '运维',
        role: '你是 DevOps。负责构建、部署、日志与回滚路径；给具体命令和失败时的判断依据，不假设环境，动手前先确认。',
      },
      {
        value: 'pm',
        label: '产品',
        name: '产品',
        role: '你是产品经理。把需求拆成用户可验收的场景与边界，明确这一版不做什么；用业务语言描述，不写实现细节。',
      },
      {
        value: 'lead',
        label: '技术负责人',
        name: '负责人',
        role: '你是技术负责人。汇总各方意见、给明确决策与下一步分工；有冲突时说明取舍代价，输出简短、可执行。',
      },
      {
        value: 'writer',
        label: '文档',
        name: '文档',
        role: '你是技术文档作者。把讨论收敛成结构化文档：背景、结论、接口或步骤、风险；不臆造未确认的信息。',
      },
    ]

    /** Everything visual lives in this one sheet; inline styles cannot express hover/focus. */
    const CSS = `
.gc-root,.gc-root *,.gc-root *::before,.gc-root *::after,
.gc-dlg,.gc-dlg *,.gc-dlg *::before,.gc-dlg *::after{box-sizing:border-box}
.gc-root{--gc-tx:inherit;
--gc-ac:var(--dsw-alias-accent,#4c8dff);--gc-dg:var(--dsw-alias-danger,#e5484d);
--gc-elev:var(--dsw-alias-bg-elevated,#23232a);
--gc-l1:color-mix(in srgb,#000 12%,transparent);
--gc-band:color-mix(in srgb,currentColor 3%,transparent);
--gc-hover:color-mix(in srgb,currentColor 4%,transparent);
--gc-sel:color-mix(in srgb,currentColor 7%,transparent);
--gc-fill:color-mix(in srgb,currentColor 5%,transparent);
--gc-c90:color-mix(in srgb,currentColor 90%,transparent);
--gc-c75:color-mix(in srgb,currentColor 75%,transparent);
--gc-c62:color-mix(in srgb,currentColor 62%,transparent);
--gc-c50:color-mix(in srgb,currentColor 50%,transparent);
--gc-c44:color-mix(in srgb,currentColor 44%,transparent);
--gc-c36:color-mix(in srgb,currentColor 36%,transparent);
--gc-line:color-mix(in srgb,currentColor 6%,transparent);
height:100%;width:100%;min-height:0;position:relative;display:grid;grid-template-columns:248px minmax(0,1fr);grid-template-rows:minmax(0,1fr);color:var(--gc-tx);font-size:13px;font-family:inherit;background:transparent;overflow:hidden}
.gc-root.narrow{grid-template-columns:minmax(0,1fr)}
.gc-root.narrow .gc-room{display:none}
.gc-root.narrow.room-open .gc-room{display:flex}
.gc-root.narrow.room-open .gc-list{display:none}
.gc-root.narrow .gc-back{display:inline-flex}
.gc-root:not(.narrow) .gc-back{display:none}

/* 左栏：凹陷层 */
.gc-list{display:flex;flex-direction:column;min-height:0;background:var(--gc-l1);border-right:1px solid var(--gc-line)}
.gc-list-head{display:flex;align-items:center;gap:8px;padding:12px 16px 4px;flex:none}
.gc-list-head b{font-size:12px;line-height:16px;font-weight:600;letter-spacing:.02em;color:var(--gc-c62);flex:1}
.gc-search{padding:0 12px 10px;flex:none}
.gc-groups{flex:1;overflow-y:auto;padding:0 8px 12px}
.gc-groups::-webkit-scrollbar,.gc-messages::-webkit-scrollbar{width:8px}
.gc-groups::-webkit-scrollbar-thumb,.gc-messages::-webkit-scrollbar-thumb{background:color-mix(in srgb,currentColor 14%,transparent);border-radius:4px}
.gc-groups::-webkit-scrollbar-track,.gc-messages::-webkit-scrollbar-track{background:transparent}

/* 群列表行 */
.gc-wrap{position:relative}
.gc-group{display:flex;align-items:center;gap:10px;width:100%;min-height:52px;padding:8px 30px 8px 8px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left;position:relative;margin-bottom:2px;transition:background .12s}
.gc-group:hover{background:var(--gc-hover)}
.gc-group:focus-visible{outline:none;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--gc-ac) 45%,transparent)}
.gc-group[aria-current="true"]{background:var(--gc-sel)}
.gc-group[aria-current="true"]::before{content:"";position:absolute;left:0;top:50%;transform:translateY(-50%);width:2px;height:16px;border-radius:2px;background:var(--gc-ac)}
.gc-av{flex:none;width:28px;height:28px;border-radius:7px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:var(--gc-c75);background:var(--gc-sel)}
.gc-group .txt{flex:1;min-width:0}
.gc-group .n{font-size:13px;line-height:18px;font-weight:500;color:var(--gc-c90);display:flex;align-items:center;gap:6px}
.gc-group[aria-current="true"] .n{font-weight:600;color:currentColor}
.gc-group .m{font-size:11px;line-height:14px;color:var(--gc-c44);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
.gc-badge{flex:none;min-width:16px;height:16px;padding:0 5px;border-radius:8px;background:color-mix(in srgb,var(--gc-ac) 12%,transparent);color:var(--gc-ac);font-size:10px;line-height:16px;text-align:center;font-variant-numeric:tabular-nums}
.gc-rename{flex:1;min-width:0;height:24px;padding:0 6px;border:0;border-radius:5px;background:color-mix(in srgb,currentColor 8%,transparent);color:var(--gc-c90);font:inherit;font-size:13px;font-weight:500;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--gc-ac) 45%,transparent)}
.gc-rename:focus{outline:none;box-shadow:inset 0 0 0 1px var(--gc-ac)}
.gc-del{position:absolute;right:4px;top:50%;transform:translateY(-50%);width:22px;height:22px;border:0;border-radius:6px;background:transparent;color:var(--gc-c50);cursor:pointer;font-size:11px;opacity:0;transition:opacity .12s,background .12s,color .12s}
.gc-wrap:hover .gc-del,.gc-del:focus-visible{opacity:1}
.gc-del:hover{background:color-mix(in srgb,var(--gc-dg) 12%,transparent);color:var(--gc-dg)}

/* 右栏 */
.gc-room{display:flex;flex-direction:column;min-height:0;min-width:0}
.gc-room-head{display:flex;align-items:center;gap:6px;min-height:48px;padding:10px 16px;background:var(--gc-band);flex:none;box-shadow:inset 0 -1px 0 var(--gc-line)}
.gc-room-head .t{font-size:14px;line-height:19px;font-weight:600;color:color-mix(in srgb,currentColor 92%,transparent);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gc-room-head .c{font-size:11.5px;line-height:16px;color:var(--gc-c44);flex:none}
.gc-members{display:flex;flex-wrap:wrap;gap:4px;padding:6px 16px 10px;background:var(--gc-band);flex:none;border-bottom:0}

/* 成员 chip：无描边，选中用中性底 + 1px 蓝环 */
.gc-chip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px 0 8px;border:0;border-radius:6px;background:transparent;color:var(--gc-c50);font:inherit;font-size:11.5px;font-weight:500;cursor:pointer;transition:background .12s,color .12s,box-shadow .12s}
.gc-chip:hover{background:var(--gc-hover);color:var(--gc-c75)}
.gc-chip[aria-pressed="true"]{background:color-mix(in srgb,currentColor 10%,transparent);color:color-mix(in srgb,currentColor 95%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--gc-ac) 45%,transparent)}
.gc-dot{flex:none;width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.6}
.gc-dot[data-ch="codex"]{background:#f5a524;opacity:1}
.gc-dot[data-ch="claude"]{background:#d97757;opacity:1}
.gc-dot[data-ch="dsh"]{background:#4c8dff;opacity:1}
.gc-dot[data-bound="1"]{box-shadow:0 0 0 1px color-mix(in srgb,currentColor 33%,transparent)}

/* 消息 */
.gc-scroll{position:relative;flex:1;min-height:0}
.gc-messages{height:100%;overflow-y:auto;padding:16px 16px 6px}
.gc-m{display:flex;flex-direction:column;gap:4px;margin-bottom:16px}
.gc-m.grouped{margin-bottom:6px}
.gc-mhead{display:flex;align-items:center;gap:6px;min-height:28px}
.gc-av-sm{width:28px;height:28px;background:color-mix(in srgb,currentColor 12%,transparent);font-size:11px}
.gc-av-sm[data-ch="codex"]{background:color-mix(in srgb,#f5a524 18%,transparent)}
.gc-av-sm[data-ch="claude"]{background:color-mix(in srgb,#d97757 18%,transparent)}
.gc-av-sm[data-ch="dsh"]{background:color-mix(in srgb,#4c8dff 18%,transparent)}
.gc-mname{font-size:12px;line-height:16px;font-weight:600;color:var(--gc-c90)}
.gc-mmeta{font-size:11px;line-height:16px;color:var(--gc-c36);font-variant-numeric:tabular-nums}
.gc-mbody{margin-left:34px;font-size:13px;line-height:1.62;color:var(--gc-c90);white-space:pre-wrap;word-break:break-word;max-width:640px}
.gc-m.me .gc-mbody{margin-left:0;padding:8px 10px;border-radius:8px;background:var(--gc-fill);color:var(--gc-c75)}
.gc-m.error .gc-mbody{color:var(--gc-dg);box-shadow:inset 2px 0 0 var(--gc-dg);padding-left:8px;margin-left:26px}
.gc-m.live .gc-mbody{color:var(--gc-c62)}
.gc-caret{display:inline-block;width:2px;height:13px;background:var(--gc-ac);vertical-align:-2px;margin-left:3px;animation:gc-blink 1s steps(1) infinite}
@keyframes gc-blink{50%{opacity:0}}
.gc-empty{padding:24px 16px;color:var(--gc-c44);text-align:center;font-size:12px;line-height:1.6}
.gc-jump{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);padding:4px 12px;border-radius:999px;background:var(--gc-elev);border:1px solid var(--gc-line);color:var(--gc-c75);font-size:11px;cursor:pointer;box-shadow:0 8px 20px rgba(0,0,0,.35)}
.gc-skeleton{border-radius:6px;background:linear-gradient(90deg,color-mix(in srgb,currentColor 6%,transparent),color-mix(in srgb,currentColor 10%,transparent),color-mix(in srgb,currentColor 6%,transparent));background-size:200% 100%;animation:gc-shimmer 1.2s ease-in-out infinite}
@keyframes gc-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}

/* 输入区：工具带 */
.gc-foot{flex:none;padding:10px 12px;background:var(--gc-band);box-shadow:inset 0 1px 0 var(--gc-line)}
.gc-busy{display:flex;align-items:center;gap:8px;margin-bottom:8px;color:var(--gc-c44);font-size:11px}
.gc-busy::before{content:"";width:5px;height:5px;border-radius:50%;background:var(--gc-ac);animation:gc-blink 1.2s steps(1) infinite}
.gc-composer{display:flex;gap:8px;align-items:flex-end;position:relative}
.gc-ta{flex:1;min-height:40px;max-height:120px;resize:none;padding:9px 10px;border:0;border-radius:8px;background:var(--gc-fill);color:var(--gc-c90);font:inherit;font-size:13px;line-height:19px;transition:box-shadow .12s}
.gc-ta::placeholder{color:var(--gc-c44)}
.gc-ta:focus{outline:none;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--gc-ac) 45%,transparent),0 0 0 3px color-mix(in srgb,var(--gc-ac) 12%,transparent)}
.gc-ta:disabled{opacity:.5;cursor:not-allowed}
.gc-reason{margin-top:6px;color:var(--gc-c36);font-size:11px;line-height:16px}

/* 按钮 */
.gc-btn{height:28px;padding:0 10px;border:0;border-radius:8px;background:var(--gc-fill);color:var(--gc-c75);font:inherit;font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:6px;transition:background .12s,color .12s}
.gc-btn:hover:not(:disabled){background:color-mix(in srgb,currentColor 9%,transparent);color:var(--gc-c90)}
.gc-btn:focus-visible{outline:none;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--gc-ac) 45%,transparent),0 0 0 3px color-mix(in srgb,var(--gc-ac) 12%,transparent)}
.gc-btn:disabled{opacity:.45;cursor:not-allowed}
.gc-btn.primary{height:32px;padding:0 14px;background:var(--gc-ac);color:#fff;font-weight:600}
.gc-btn.primary:hover:not(:disabled){background:var(--gc-ac);color:#fff;filter:brightness(1.08)}
.gc-btn.primary:disabled{background:color-mix(in srgb,currentColor 8%,transparent);color:var(--gc-c36);opacity:1;filter:none}
.gc-btn.danger{color:var(--gc-dg);background:transparent}
.gc-btn.danger:hover:not(:disabled){background:color-mix(in srgb,var(--gc-dg) 12%,transparent);color:var(--gc-dg)}
.gc-btn.icon{width:26px;height:26px;padding:0;justify-content:center;background:transparent;color:var(--gc-c50)}
.gc-btn.icon:hover:not(:disabled){background:var(--gc-hover);color:var(--gc-c90)}

/* 输入框 / 下拉 */
.gc-input,.gc-select-trigger{height:28px;padding:0 10px;border:0;border-radius:8px;background:var(--gc-fill);color:var(--gc-c90);font:inherit;font-size:12px}
.gc-input::placeholder{color:var(--gc-c44)}
.gc-input:focus{outline:none;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--gc-ac) 45%,transparent),0 0 0 3px color-mix(in srgb,var(--gc-ac) 12%,transparent)}
.gc-center{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center}
.gc-center h3{margin:0;font-size:13px;font-weight:600;color:var(--gc-c90)}
.gc-center p{margin:0;color:var(--gc-c44);max-width:280px;font-size:12px;line-height:1.6}

/* 浮层：必须用 token，保证不透明 */
.gc-menu{position:absolute;right:14px;top:48px;z-index:20;min-width:150px;padding:4px;background:var(--gc-elev);border:1px solid var(--gc-line);border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.45)}
.gc-menu button{display:block;width:100%;text-align:left;padding:7px 10px;border:0;border-radius:6px;background:transparent;color:var(--gc-c90);font:inherit;font-size:12px;cursor:pointer}
.gc-menu button:hover{background:var(--gc-hover)}
.gc-menu button.danger{color:var(--gc-dg)}
.gc-menu button.danger:hover{background:color-mix(in srgb,var(--gc-dg) 12%,transparent)}

/* 弹窗 */
.gc-backdrop{position:absolute;inset:0;z-index:20;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px}
.gc-dlg{width:368px;max-width:100%;background:var(--gc-elev);color:var(--gc-tx);border:1px solid var(--gc-line);border-radius:12px;box-shadow:0 18px 44px rgba(0,0,0,.55);text-align:left}
.gc-dlg-head{display:flex;align-items:center;gap:8px;padding:14px 16px 10px}
.gc-dlg-head h3{margin:0;font-size:13px;font-weight:600;color:var(--gc-c90);flex:1}
.gc-x{width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;color:var(--gc-c50);cursor:pointer;font-size:14px}
.gc-x:hover{background:var(--gc-hover);color:var(--gc-c90)}
.gc-dlg-body{padding:0 16px 14px}
.gc-field{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}
.gc-field > label{font-size:11px;line-height:16px;color:var(--gc-c44)}
.gc-hint{font-size:11px;line-height:16px;color:var(--gc-c36)}
.gc-dlg-foot{display:flex;gap:8px;justify-content:flex-end;padding:12px 16px;background:var(--gc-band);box-shadow:inset 0 1px 0 var(--gc-line)}
.gc-dlg .gc-input,.gc-dlg .gc-select-trigger{height:32px}
.gc-dlg .gc-role{height:auto;min-height:66px;padding:8px 10px;line-height:1.6;font-size:12px;resize:vertical;font-family:inherit}
.gc-field.invalid .gc-input{box-shadow:inset 0 0 0 1px var(--gc-dg)}
.gc-err{color:var(--gc-dg);font-size:11px;line-height:16px;margin-bottom:8px}
.gc-select{position:relative}
.gc-select-trigger{width:100%;display:flex;align-items:center;gap:8px;cursor:pointer;text-align:left}
.gc-select-trigger[aria-expanded="true"]{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--gc-ac) 45%,transparent)}
.gc-select-trigger .val{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gc-chev{flex:none;width:7px;height:7px;margin-right:3px;border-top:1.5px solid var(--gc-c50);border-right:1.5px solid var(--gc-c50);transform:rotate(135deg) translate(-1px,-1px)}
.gc-clear{flex:none;width:18px;height:18px;margin-left:2px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:10px;line-height:1;color:var(--gc-c50);cursor:pointer;transition:background .12s,color .12s}
.gc-clear:hover{background:color-mix(in srgb,currentColor 14%,transparent);color:var(--gc-c90)}
.gc-input-wrap{position:relative;flex:1;min-width:0}
.gc-input-wrap .gc-input{width:100%;padding-right:28px}
.gc-input-wrap .gc-clear{position:absolute;right:5px;top:50%;transform:translateY(-50%)}
.gc-select-menu{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:10;padding:4px;border-radius:10px;background:var(--gc-elev);border:1px solid var(--gc-line);box-shadow:0 12px 32px rgba(0,0,0,.45);max-height:280px;overflow-y:auto}
.gc-opt{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;border:0;border-radius:6px;background:transparent;color:var(--gc-c90);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.gc-opt:hover{background:var(--gc-hover)}
.gc-opt[aria-selected="true"]{background:color-mix(in srgb,var(--gc-ac) 10%,transparent);color:var(--gc-ac)}
.gc-opt .opt-main{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gc-opt .sub{flex:none;color:var(--gc-c36);font-size:11px}
.gc-paths{display:flex;flex-direction:column;gap:4px}
.gc-path{display:flex;align-items:center;gap:6px;padding:5px 6px 5px 8px;border-radius:6px;background:var(--gc-fill);font-size:11px}
.gc-path .p{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--gc-c75)}
.gc-none{padding:10px;color:var(--gc-c36);font-size:11px;text-align:center}
.gc-picker{margin-top:6px;border-radius:8px;background:var(--gc-fill);max-height:152px;overflow-y:auto}
.gc-pick{display:flex;flex-direction:column;gap:1px;width:100%;padding:8px 10px;border:0;border-bottom:1px solid var(--gc-line);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.gc-pick:last-child{border-bottom:0}
.gc-pick:hover{background:var(--gc-hover)}
.gc-pick .t{font-size:12px;color:var(--gc-c90)}
.gc-pick .s{font-size:10px;color:var(--gc-c36)}
.gc-seg{display:flex;gap:6px}
.gc-seg button{flex:1;height:30px;border:0;border-radius:8px;background:var(--gc-fill);color:var(--gc-c50);font:inherit;font-size:11px;cursor:pointer;transition:background .12s,color .12s,box-shadow .12s}
.gc-seg button:hover{color:var(--gc-c75)}
.gc-seg button[aria-pressed="true"]{background:color-mix(in srgb,currentColor 10%,transparent);color:var(--gc-c90);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--gc-ac) 45%,transparent)}

/* @ 提及 */
.gc-mentions{position:absolute;bottom:calc(100% + 8px);left:0;right:0;z-index:20;padding:4px;border-radius:10px;background:var(--gc-elev);border:1px solid var(--gc-line);box-shadow:0 12px 32px rgba(0,0,0,.45);max-height:200px;overflow-y:auto}
.gc-mi{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;border:0;border-radius:6px;background:transparent;color:var(--gc-c90);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.gc-mi:hover,.gc-mi[data-active="true"]{background:var(--gc-hover)}
.gc-mi .hint{margin-left:auto;color:var(--gc-c36);font-size:10px}
.gc-mentions .none{padding:8px 10px;color:var(--gc-c36);font-size:11px}`

    /* ------------------------------ helpers ------------------------------ */

    async function call(path, init) {
      let response
      try {
        response = await fetch(API + path, {
          headers: {
            'content-type': 'application/json',
            'x-group-chat-token': globalThis.__GROUP_CHAT_TOKEN__ || '',
          },
          ...init,
        })
      } catch (cause) {
        throw new Error('网络不通，检查 Harness 是否还在运行')
      }
      const payload = await response.json().catch(() => ({}))
      if (response.status === 403) {
        const error = new Error('页面凭证已过期')
        error.auth = true
        throw error
      }
      if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`)
      return payload
    }

    function loadMode() {
      try {
        const value = localStorage.getItem(MODE_KEY)
        if (value === 'fork' || value === 'resume') return value
      } catch {
        /* ignore */
      }
      return 'fork'
    }

    function saveMode(value) {
      try {
        localStorage.setItem(MODE_KEY, value)
      } catch {
        /* ignore */
      }
    }

    function readReads() {
      try {
        return JSON.parse(localStorage.getItem(READS_KEY) || '{}') || {}
      } catch {
        return {}
      }
    }

    function saveReads(groupId, seq) {
      try {
        const reads = readReads()
        if ((reads[groupId] || 0) >= seq) return
        reads[groupId] = seq
        localStorage.setItem(READS_KEY, JSON.stringify(reads))
      } catch {
        /* ignore */
      }
    }

    function unreadCount(groups) {
      const reads = readReads()
      let total = 0
      for (const group of groups) total += Math.max(0, (group.lastSeq || 0) - (reads[group.id] || 0))
      return total
    }

    const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}/i
    const fmtMs = (ms) => (ms == null ? '' : ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`)
    /** 字母块用的字：取名字里第一个汉字（Codex-架构师 → 架，P1 验收群 → 验），没有汉字则取首个字母。 */
    const initialOf = (name) => {
      const text = String(name || '').trim()
      if (!text) return '?'
      const cjk = /[\u4e00-\u9fa5]/.exec(text)
      if (cjk) return cjk[0]
      const alpha = /[a-z0-9]/i.exec(text)
      return alpha ? alpha[0].toUpperCase() : text[0]
    }

    /* ------------------------------ tab body ------------------------------ */

    function GroupChatTab() {
      const [phase, setPhase] = React.useState('loading') // loading | failed | ready
      const [panelError, setPanelError] = React.useState(null)
      const [groups, setGroups] = React.useState([])
      const [activeId, setActiveId] = React.useState(null)
      const [query, setQuery] = React.useState('')
      const [entries, setEntries] = React.useState([])
      const [entriesLoading, setEntriesLoading] = React.useState(false)
      const [live, setLive] = React.useState([])
      const [busy, setBusy] = React.useState(false)
      const [targets, setTargets] = React.useState([])
      const [mentions, setMentions] = React.useState([])
      const [draft, setDraft] = React.useState('')
      const [error, setError] = React.useState(null)
      const [atBottom, setAtBottom] = React.useState(true)
      const [hasNew, setHasNew] = React.useState(false)
      const [menuOpen, setMenuOpen] = React.useState(false)
      const [narrow, setNarrow] = React.useState(false)
      const [roomOpen, setRoomOpen] = React.useState(false)
      const [sending, setSending] = React.useState(false)

      // dialogs
      const [creating, setCreating] = React.useState(false)
      const [newName, setNewName] = React.useState('')
      const [newTemplate, setNewTemplate] = React.useState('')
      const [newProjects, setNewProjects] = React.useState([])
      const [adding, setAdding] = React.useState(null)
      const [addingPending, setAddingPending] = React.useState(false)
      const [sessions, setSessions] = React.useState(null)
      const [removing, setRemoving] = React.useState(null)
      const [renaming, setRenaming] = React.useState(null)
      const [renameName, setRenameName] = React.useState('')
      const [editingId, setEditingId] = React.useState(null)
      const [editName, setEditName] = React.useState('')
      const [sessionQuery, setSessionQuery] = React.useState('')
      const committingRef = React.useRef(false)
      const [archives, setArchives] = React.useState([])
      const [archivesOpen, setArchivesOpen] = React.useState(false)
      const [openSelect, setOpenSelect] = React.useState(null)
      const [mention, setMention] = React.useState(null)

      const bodyRef = React.useRef(null)
      const seqRef = React.useRef(0)
      const nearBottom = React.useRef(true)
      const taRef = React.useRef(null)
      const rootRef = React.useRef(null)
      const [focusTick, setFocusTick] = React.useState(0)

      const active = groups.find((group) => group.id === activeId) || null
      const members = active?.members || []
      const ready = phase === 'ready'

      const recipients = React.useMemo(() => {
        const ids = new Set([...targets, ...mentions])
        return ids.size ? members.filter((member) => ids.has(member.id)) : []
      }, [targets, mentions, members])

      const loadArchives = React.useCallback(async () => {
        try {
          const payload = await call('archive')
          setArchives(payload.archives || [])
        } catch {
          /* the archive list is not critical */
        }
      }, [])

      const loadState = React.useCallback(async () => {
        try {
          const payload = await call('state')
          const next = payload.groups || []
          setGroups(next)
          setActiveId((current) => (current && next.some((g) => g.id === current) ? current : next[0]?.id || null))
          setPhase('ready')
          setPanelError(null)
        } catch (cause) {
          setPanelError({ message: cause.message, auth: Boolean(cause.auth) })
          setPhase('failed')
        }
      }, [])

      React.useEffect(() => {
        loadState()
      }, [loadState])

      React.useEffect(() => {
        if (ready) loadArchives()
      }, [ready, loadArchives])

      // 切群 = 完整重置
      React.useEffect(() => {
        setEntries([])
        setEntriesLoading(Boolean(activeId))
        setTargets([])
        setMentions([])
        setMention(null)
        setError(null)
        setLive([])
        setBusy(false)
        nearBottom.current = true
        setAtBottom(true)
        setHasNew(false)
        seqRef.current = 0
      }, [activeId])

      const loadEntries = React.useCallback(async (groupId) => {
        if (!groupId) return
        try {
          const payload = await call(`groups/${encodeURIComponent(groupId)}/transcript?limit=100`)
          const next = payload.entries || []
          setEntries(next)
          seqRef.current = next.length ? next[next.length - 1].seq : 0
          if (!nearBottom.current) setHasNew(true)
        } catch {
          /* polling errors stay quiet */
        } finally {
          setEntriesLoading(false)
        }
      }, [])

      React.useEffect(() => {
        if (!ready || !activeId) return undefined
        loadEntries(activeId)
        const timer = setInterval(() => {
          call(`groups/${encodeURIComponent(activeId)}/status`)
            .then((payload) => {
              setBusy(Boolean(payload.busy))
              setLive(Array.isArray(payload.live) ? payload.live : [])
            })
            .catch(() => {})
          loadEntries(activeId)
        }, 1500)
        return () => clearInterval(timer)
      }, [ready, activeId, loadEntries])

      React.useEffect(() => {
        if (!activeId || entries.length === 0) return
        if (nearBottom.current) saveReads(activeId, entries[entries.length - 1].seq)
      }, [activeId, entries])

      React.useEffect(() => {
        if (!nearBottom.current) return
        const node = bodyRef.current
        if (node) node.scrollTop = node.scrollHeight
      }, [entries, live])

      React.useEffect(() => {
        const node = rootRef.current
        if (!node) return undefined
        const measure = () => setNarrow(node.clientWidth < 520)
        measure()
        if (typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver(measure)
          observer.observe(node)
          return () => observer.disconnect()
        }
        window.addEventListener('resize', measure)
        return () => window.removeEventListener('resize', measure)
      }, [])

      // 宿主的 tab 容器可能只有 auto 高度，`height:100%` 和 grid 行约束都会落空，
      // 于是内容把面板撑破、footer 与消息重叠。这里按视口剩余高度给根节点定高，
      // 让它自成一个可滚动的固定区域。
      React.useLayoutEffect(() => {
        const node = rootRef.current
        if (!node) return undefined
        const fit = () => {
          const rect = node.getBoundingClientRect()
          const available = Math.max(320, Math.floor(window.innerHeight - Math.max(0, rect.top) - 4))
          const current = Number.parseFloat(node.style.height || '0')
          if (Math.abs(current - available) > 1) node.style.height = `${available}px`
        }
        fit()
        window.addEventListener('resize', fit)
        const timer = window.setInterval(fit, 2000)
        return () => {
          window.removeEventListener('resize', fit)
          window.clearInterval(timer)
        }
      }, [])

      React.useEffect(() => {
        if (!creating && !adding && !removing) return undefined
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          if (openSelect) { setOpenSelect(null); return }
          setCreating(false)
          setAdding(null)
          setRemoving(null)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [creating, adding, removing, openSelect])

      // 下拉：点空白处或窗口失焦就收起
      React.useEffect(() => {
        if (!openSelect) return undefined
        const close = (event) => {
          const node = event.target
          if (node && typeof node.closest === 'function' && node.closest('.gc-select')) return
          setOpenSelect(null)
        }
        const onBlur = () => setOpenSelect(null)
        document.addEventListener('mousedown', close, true)
        window.addEventListener('blur', onBlur)
        return () => {
          document.removeEventListener('mousedown', close, true)
          window.removeEventListener('blur', onBlur)
        }
      }, [openSelect])

      // 弹窗关掉时顺手收起残留的下拉
      React.useEffect(() => {
        if (creating || adding || removing || renaming || archivesOpen) return
        if (openSelect) setOpenSelect(null)
      }, [creating, adding, removing, renaming, archivesOpen, openSelect])

      React.useEffect(() => {
        if (focusTick === 0) return
        const node = taRef.current
        if (node) node.focus()
      }, [focusTick])

      // 加成员弹窗打开后自动拉已有会话；关闭或换渠道时清掉缓存
      React.useEffect(() => {
        if (!adding) {
          if (sessions !== null) setSessions(null)
          return
        }
        if (sessions !== null) return
        pickSessions(adding.channel)
      }, [adding, sessions])

      function onScroll() {
        const node = bodyRef.current
        if (!node) return
        const bottom = node.scrollHeight - node.scrollTop - node.clientHeight < 32
        nearBottom.current = bottom
        setAtBottom(bottom)
        if (bottom) {
          setHasNew(false)
          if (activeId && seqRef.current) saveReads(activeId, seqRef.current)
        }
      }

      async function send() {
        const text = draft.trim()
        if (!text || !active || sending) return
        const ids = recipients.map((member) => member.id)
        setSending(true)
        setError(null)
        try {
          await call(`groups/${encodeURIComponent(active.id)}/say`, {
            method: 'POST',
            body: JSON.stringify({ text, memberIds: ids.length ? ids : undefined }),
          })
          setDraft('')
          setMentions([])
          setMention(null)
          nearBottom.current = true
          setAtBottom(true)
          await loadEntries(active.id)
        } catch (cause) {
          setError({ scope: 'say', message: cause.message })
        } finally {
          setSending(false)
        }
      }

      async function cancel() {
        if (!active) return
        try {
          await call(`groups/${encodeURIComponent(active.id)}/cancel`, { method: 'POST' })
        } catch (cause) {
          setError({ scope: 'say', message: cause.message })
        }
      }

      async function createGroup() {
        const name = newName.trim()
        if (!name) return
        setError(null)
        try {
          const created = await call('groups', {
            method: 'POST',
            body: JSON.stringify({
              name,
              template: newTemplate || undefined,
              projects: newProjects.length ? newProjects : undefined,
            }),
          })
          setCreating(false)
          setNewName('')
          setNewTemplate('')
          setNewProjects([])
          await loadState()
          setActiveId(created.group.id)
        } catch (cause) {
          setError({ scope: 'create', message: cause.message })
        }
      }

      /** 会话检索：标题包含，或 id 前缀匹配。 */
      function matchesQuery(session, query) {
        const q = String(query || '').trim().toLowerCase()
        if (!q) return true
        const title = String(session.title || '').toLowerCase()
        return title.includes(q) || session.id.toLowerCase().startsWith(q)
      }

      /** 选中一条已有会话：回填会话 id、接管标题与名称。 */
      function pickSession(session) {
        setAdding((current) => {
          if (!current) return current
          const title = session.title || session.id.slice(0, 8)
          return {
            ...current,
            sid: session.id,
            thread: session.title,
            name: title.length > 16 ? `${title.slice(0, 16)}…` : title,
          }
        })
        setSessionQuery(session.title || session.id.slice(0, 8))
        setOpenSelect(null)
      }

      async function pickSessions(channel) {
        setSessions([])
        try {
          const payload = await call(`sessions?channel=${encodeURIComponent(channel)}&limit=60`)
          setSessions(payload.sessions || [])
        } catch (cause) {
          setError({ scope: 'add', message: cause.message })
          setSessions([])
        }
      }

      async function addMember() {
        if (!adding || !active || addingPending) return
        const name = adding.name.trim()
        if (!name) return
        const sid = (adding.sid || '').trim()
        if (sid && !SID_RE.test(sid)) return
        setAddingPending(true)
        setError(null)
        try {
          await call(`groups/${encodeURIComponent(active.id)}/members`, {
            method: 'POST',
            body: JSON.stringify({
              channel: adding.channel,
              name,
              role: (adding.role || '').trim() || undefined,
              threadId: sid || undefined,
              mode: sid ? adding.mode : undefined,
            }),
          })
          setAdding(null)
          setSessions(null)
          await loadState()
        } catch (cause) {
          setError({ scope: 'add', message: cause.message })
        } finally {
          setAddingPending(false)
        }
      }

      /** 列表里双击群名就地改名：Enter / 失焦提交，Esc 取消。 */
      function startRename(group) {
        committingRef.current = false
        setEditingId(group.id)
        setEditName(group.name)
      }

      function cancelRename() {
        committingRef.current = true
        setEditingId(null)
      }

      async function commitRename() {
        const id = editingId
        const name = editName.trim()
        setEditingId(null)
        if (!id || committingRef.current || !name) return
        const current = groups.find((group) => group.id === id)
        if (!current || current.name === name) return
        try {
          await call(`groups/${encodeURIComponent(id)}/rename`, {
            method: 'POST',
            body: JSON.stringify({ name }),
          })
          await loadState()
        } catch (cause) {
          setError({ scope: 'rename', message: cause.message })
        }
      }

      async function renameGroup() {        if (!renaming) return
        const name = renameName.trim()
        if (!name) return
        setError(null)
        try {
          await call(`groups/${encodeURIComponent(renaming)}/rename`, {
            method: 'POST',
            body: JSON.stringify({ name }),
          })
          setRenaming(null)
          await loadState()
        } catch (cause) {
          setError({ scope: 'rename', message: cause.message })
        }
      }

      async function removeGroup() {
        const groupId = removing
        if (!groupId) return
        setError(null)
        try {
          await call(`groups/${encodeURIComponent(groupId)}/remove`, { method: 'POST' })
          setRemoving(null)
          await loadState()
          await loadArchives()
        } catch (cause) {
          setRemoving(null)
          setError({ scope: 'remove', message: cause.message })
        }
      }

      async function restoreGroup(groupId) {
        setError(null)
        try {
          await call(`archive/${encodeURIComponent(groupId)}/restore`, { method: 'POST' })
          await loadArchives()
          await loadState()
        } catch (cause) {
          setError({ scope: 'archive', message: cause.message })
        }
      }

      function exportMinutes() {
        if (!active) return
        call(`groups/${encodeURIComponent(active.id)}/export`)
          .then((payload) => setError({ scope: 'menu', message: `已导出：${payload.file}` }))
          .catch((cause) => setError({ scope: 'menu', message: cause.message }))
        setMenuOpen(false)
      }

      /* ---------------------------- @ mentions ---------------------------- */

      const mentionCandidates = React.useMemo(() => {
        if (!mention) return []
        const q = mention.query.toLowerCase()
        return members.filter((member) => !q || member.name.toLowerCase().includes(q))
      }, [mention, members])

      function refreshMention(node) {
        const pos = node.selectionStart ?? node.value.length
        const before = node.value.slice(0, pos)
        const match = /(^|[\s(])@([^\s@]{0,20})$/.exec(before)
        if (!match) {
          setMention(null)
          return
        }
        const q = match[2]
        setMention({ start: pos - q.length - 1, query: q, index: 0 })
      }

      function pickMention(member) {
        const node = taRef.current
        if (!node || !mention || !member) return
        const pos = node.selectionStart ?? node.value.length
        const insert = `@${member.name} `
        const value = node.value.slice(0, mention.start) + insert + node.value.slice(pos)
        setDraft(value)
        setMentions((current) => (current.includes(member.id) ? current : [...current, member.id]))
        setMention(null)
        requestAnimationFrame(() => {
          node.value = value
          node.selectionStart = node.selectionEnd = mention.start + insert.length
          node.focus()
        })
      }

      /* ----------------------------- rendering ----------------------------- */

      function renderSelect(key, value, options, onPick, placeholder, onClear) {
        const open = Boolean(openSelect && openSelect.key === key)
        const dropUp = Boolean(open && openSelect.up)
        const current = options.find((option) => option.value === value)
        const label = current ? current.label : placeholder || value
        const clearable = Boolean(onClear) && Boolean(value)
        return h(
          'div',
          { className: 'gc-select' },
          h(
            'button',
            {
              type: 'button',
              className: 'gc-select-trigger',
              'aria-haspopup': 'listbox',
              'aria-expanded': open,
              onClick: (event) => {
                if (open) {
                  setOpenSelect(null)
                  return
                }
                // 靠底部时向上展开，避免菜单被面板底边裁掉
                const rect = event.currentTarget.getBoundingClientRect()
                const below = window.innerHeight - rect.bottom
                setOpenSelect({ key, up: below < 300 })
              },
            },
            h('span', { className: 'val' }, label),
            clearable
              ? h(
                  'span',
                  {
                    className: 'gc-clear',
                    role: 'button',
                    tabIndex: -1,
                    'aria-label': '清除',
                    title: '清除',
                    onClick: (event) => {
                      event.stopPropagation()
                      setOpenSelect(null)
                      onClear()
                    },
                  },
                  '✕',
                )
              : null,
            h('span', { className: 'gc-chev', 'aria-hidden': 'true' }),
          ),
          open
            ? h(
                'div',
                {
                  className: 'gc-select-menu',
                  role: 'listbox',
                  style: dropUp ? { top: 'auto', bottom: 'calc(100% + 4px)' } : undefined,
                },
                options.map((option) =>
                  h(
                    'button',
                    {
                      key: option.value,
                      type: 'button',
                      className: 'gc-opt',
                      role: 'option',
                      'aria-selected': option.value === value,
                      onClick: () => {
                        onPick(option.value)
                        setOpenSelect(null)
                      },
                    },
                    h('span', { className: 'opt-main' }, option.label),
                    option.sub ? h('span', { className: 'sub' }, option.sub) : null,
                  ),
                ),
              )
            : null,
        )
      }

      function renderGroupList() {
        const q = query.trim().toLowerCase()
        const list = groups.filter((group) => !q || group.name.toLowerCase().includes(q))
        if (!list.length) {
          return h('div', { className: 'gc-empty' }, q ? '没有匹配的群' : '还没有群，点右上角 + 新建')
        }
        const reads = readReads()
        return list.map((group) => {
          const unread = Math.max(0, (group.lastSeq || 0) - (reads[group.id] || 0))
          const last = group.members.length ? `${group.members.length} 人` : '空群'
          const recent = group.last && group.last.author
            ? `${group.last.author === '你' ? '你' : group.last.author}${group.last.ms ? ` ${fmtMs(group.last.ms)}` : ''}`
            : ''
          const meta = recent ? `${last} · ${recent}` : last
          const editing = editingId === group.id
          return h(
            'div',
            { key: group.id, className: 'gc-wrap' },
            editing
              ? h(
                  'div',
                  { className: 'gc-group', 'aria-current': group.id === activeId, style: { cursor: 'default' } },
                  h('span', { className: 'gc-av', 'aria-hidden': 'true' }, initialOf(group.name)),
                  h(
                    'span',
                    { className: 'txt' },
                    h('input', {
                      className: 'gc-rename',
                      value: editName,
                      'aria-label': '群名',
                      ref: (node) => {
                        if (node && node.dataset.ready !== '1') {
                          node.dataset.ready = '1'
                          node.focus()
                          node.select()
                        }
                      },
                      onChange: (event) => setEditName(event.target.value),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          commitRename()
                        } else if (event.key === 'Escape') {
                          event.preventDefault()
                          cancelRename()
                        }
                      },
                      onBlur: () => commitRename(),
                    }),
                    h('div', { className: 'm' }, meta),
                  ),
                )
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'gc-group',
                    'aria-current': group.id === activeId,
                    title: '双击改名',
                    onClick: () => {
                      setActiveId(group.id)
                      if (narrow) setRoomOpen(true)
                    },
                    onDoubleClick: () => startRename(group),
                  },
                  h('span', { className: 'gc-av', 'aria-hidden': 'true' }, initialOf(group.name)),
                  h(
                    'span',
                    { className: 'txt' },
                    h(
                      'div',
                      { className: 'n' },
                      group.name,
                      unread > 0 ? h('span', { className: 'gc-badge' }, unread > 99 ? '99+' : String(unread)) : null,
                    ),
                    h('div', { className: 'm' }, meta),
                  ),
                ),
            editing
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'gc-del',
                    title: '移除群聊',
                    'aria-label': `移除群聊 ${group.name}`,
                    onClick: () => {
                      setRemoving(group.id)
                      setMenuOpen(false)
                    },
                  },
                  '✕',
                ),
          )
        })
      }

      function renderMessages() {
        const nodes = []
        if (entriesLoading && entries.length === 0) {
          nodes.push(
            h(
              'div',
              { key: 'sk' },
              h('div', { className: 'gc-skeleton', style: { width: '70%', height: 14, marginBottom: 8 } }),
              h('div', { className: 'gc-skeleton', style: { width: '50%', height: 14 } }),
            ),
          )
        } else if (entries.length === 0) {
          nodes.push(h('div', { key: 'empty', className: 'gc-empty' }, '还没有消息，发第一句吧'))
        } else {
          let previous = null
          for (const entry of entries) {
            const isMe = !entry.channel
            const grouped =
              !isMe &&
              previous &&
              previous.author === entry.author &&
              previous.channel === entry.channel &&
              previous.kind !== 'error' &&
              entry.kind !== 'error'
            nodes.push(
              h(
                'div',
                {
                  key: entry.seq,
                  className: `gc-m${isMe ? ' me' : ''}${grouped ? ' grouped' : ''}${entry.kind === 'error' ? ' error' : ''}`,
                },
                isMe || grouped
                  ? null
                  : h(
                      'div',
                      { className: 'gc-mhead' },
                      h(
                        'span',
                        { className: 'gc-av gc-av-sm', 'data-ch': entry.channel || '', 'aria-hidden': 'true' },
                        initialOf(entry.author),
                      ),
                      h('span', { className: 'gc-mname' }, entry.author),
                      entry.channel
                        ? h('span', { className: 'gc-mmeta' }, `${entry.channel}${entry.ms ? ` · ${fmtMs(entry.ms)}` : ''}`)
                        : entry.ms
                          ? h('span', { className: 'gc-mmeta' }, fmtMs(entry.ms))
                          : null,
                    ),
                h('div', { className: 'gc-mbody' }, entry.text),
              ),
            )
            previous = entry
          }
        }
        for (const item of live) {
          nodes.push(
            h(
              'div',
              { key: `live-${item.memberId}`, className: 'gc-m live' },
              h(
                'div',
                { className: 'gc-mhead' },
                h(
                  'span',
                  { className: 'gc-av gc-av-sm', 'data-ch': item.channel || '', 'aria-hidden': 'true' },
                  initialOf(item.name),
                ),
                h('span', { className: 'gc-mname' }, item.name),
                h(
                  'span',
                  { className: 'gc-mmeta' },
                  `${item.channel} · ${Math.round(item.ms / 1000)}s · ${item.streaming ? '输出中' : '思考中'}`,
                ),
              ),
              h(
                'div',
                { className: 'gc-mbody' },
                item.text || '',
                item.text ? h('span', { className: 'gc-caret' }) : null,
              ),
            ),
          )
        }
        return nodes
      }

      function renderDialog() {
        if (archivesOpen) {
          return h(
            'div',
            { className: 'gc-backdrop', onClick: (event) => event.target === event.currentTarget && setArchivesOpen(false) },
            h(
              'div',
              { className: 'gc-dlg', role: 'dialog', 'aria-modal': 'true' },
              h(
                'div',
                { className: 'gc-dlg-head' },
                h('h3', null, '已移除的群聊'),
                h('button', { type: 'button', className: 'gc-x', 'aria-label': '关闭', onClick: () => setArchivesOpen(false) }, '✕'),
              ),
              h(
                'div',
                { className: 'gc-dlg-body' },
                h('span', { className: 'gc-hint' }, '聊天记录都保留着，恢复后成员和已绑定的会话 id 也一并回来。'),
                archives.length === 0
                  ? h('div', { className: 'gc-hint', style: { marginTop: 10 } }, '还没有移除过群聊。')
                  : h(
                      'div',
                      { style: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 } },
                      archives.map((record) =>
                        h(
                          'div',
                          {
                            key: record.id,
                            style: {
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              padding: '8px 10px',
                              border: '1px solid var(--gc-bd)',
                              borderRadius: 8,
                            },
                          },
                          h(
                            'div',
                            { style: { flex: 1, minWidth: 0 } },
                            h('div', { style: { fontSize: 12, fontWeight: 600 } }, record.name),
                            h(
                              'div',
                              { className: 'gc-hint' },
                              `${record.members} 人 · ${record.messages} 条 · 移除于 ${String(record.removedAt).slice(0, 10)}`,
                            ),
                          ),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'gc-btn',
                              disabled: !record.restorable,
                              title: record.restorable ? '' : '这条归档没有完整快照，只能保留记录',
                              onClick: () => restoreGroup(record.id),
                            },
                            '恢复',
                          ),
                        ),
                      ),
                    ),
                error?.scope === 'archive' ? h('div', { className: 'gc-err', style: { marginTop: 8 } }, error.message) : null,
              ),
              h(
                'div',
                { className: 'gc-dlg-foot' },
                h('button', { type: 'button', className: 'gc-btn', onClick: () => setArchivesOpen(false) }, '关闭'),
              ),
            ),
          )
        }

        if (renaming) {
          const can = Boolean(renameName.trim())
          return h(
            'div',
            { className: 'gc-backdrop', onClick: (event) => event.target === event.currentTarget && setRenaming(null) },
            h(
              'div',
              { className: 'gc-dlg', role: 'dialog', 'aria-modal': 'true' },
              h(
                'div',
                { className: 'gc-dlg-head' },
                h('h3', null, '重命名'),
                h('button', { type: 'button', className: 'gc-x', 'aria-label': '关闭', onClick: () => setRenaming(null) }, '✕'),
              ),
              h(
                'div',
                { className: 'gc-dlg-body' },
                h(
                  'div',
                  { className: 'gc-field', style: { marginBottom: 4 } },
                  h('label', null, '群名'),
                  h('input', {
                    className: 'gc-input',
                    value: renameName,
                    autoFocus: true,
                    onChange: (event) => setRenameName(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' && renameName.trim()) renameGroup()
                    },
                  }),
                ),
                error?.scope === 'rename' ? h('div', { className: 'gc-err' }, error.message) : null,
              ),
              h(
                'div',
                { className: 'gc-dlg-foot' },
                h('button', { type: 'button', className: 'gc-btn', onClick: () => setRenaming(null) }, '取消'),
                h(
                  'button',
                  { type: 'button', className: 'gc-btn primary', disabled: !can, onClick: renameGroup },
                  '保存',
                ),
              ),
            ),
          )
        }

        if (removing) {
          const group = groups.find((item) => item.id === removing)
          if (!group) return null
          return h(
            'div',
            { className: 'gc-backdrop', onClick: (event) => event.target === event.currentTarget && setRemoving(null) },
            h(
              'div',
              { className: 'gc-dlg', role: 'dialog', 'aria-modal': 'true' },
              h(
                'div',
                { className: 'gc-dlg-head' },
                h('h3', null, '移除群聊'),
                h('button', { type: 'button', className: 'gc-x', 'aria-label': '关闭', onClick: () => setRemoving(null) }, '✕'),
              ),
              h(
                'div',
                { className: 'gc-dlg-body' },
                h('p', { style: { margin: '0 0 6px', fontSize: 12 } }, `确定移除「${group.name}」吗？`),
                h('span', { className: 'gc-hint' }, '只是从列表移除，聊天记录会保留在 storages 的 archive 目录里，不会删除。'),
              ),
              h(
                'div',
                { className: 'gc-dlg-foot' },
                h('button', { type: 'button', className: 'gc-btn', onClick: () => setRemoving(null) }, '取消'),
                h('button', { type: 'button', className: 'gc-btn danger', onClick: removeGroup }, '移除'),
              ),
            ),
          )
        }

        if (creating) {
          const can = Boolean(newName.trim())
          return h(
            'div',
            { className: 'gc-backdrop', onClick: (event) => event.target === event.currentTarget && setCreating(false) },
            h(
              'div',
              { className: 'gc-dlg', role: 'dialog', 'aria-modal': 'true' },
              h(
                'div',
                { className: 'gc-dlg-head' },
                h('h3', null, '新建群'),
                h('button', { type: 'button', className: 'gc-x', 'aria-label': '关闭', onClick: () => setCreating(false) }, '✕'),
              ),
              h(
                'div',
                { className: 'gc-dlg-body' },
                h(
                  'div',
                  { className: 'gc-field' },
                  h('label', null, '群名'),
                  h('input', {
                    className: 'gc-input',
                    placeholder: '例如：接口评审',
                    value: newName,
                    autoFocus: true,
                    onChange: (event) => setNewName(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' && can) createGroup()
                    },
                  }),
                ),
                h(
                  'div',
                  { className: 'gc-field' },
                  h('label', null, '项目目录（可选，可多个）'),
                  newProjects.length
                    ? h(
                        'div',
                        { className: 'gc-paths' },
                        newProjects.map((item, index) =>
                          h(
                            'div',
                            { key: `${item}-${index}`, className: 'gc-path' },
                            h('span', { className: 'p', title: item }, item),
                            h(
                              'span',
                              {
                                className: 'gc-clear',
                                role: 'button',
                                tabIndex: -1,
                                title: '移除',
                                onClick: () => setNewProjects(newProjects.filter((_, at) => at !== index)),
                              },
                              '✕',
                            ),
                          ),
                        ),
                      )
                    : null,
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'gc-btn',
                      style: { alignSelf: 'flex-start' },
                      onClick: async () => {
                        try {
                          const picked = workspaceApi ? await workspaceApi.pickDirectory() : null
                          if (picked) setNewProjects((current) => (current.includes(picked) ? current : [...current, picked]))
                        } catch (cause) {
                          setError({ scope: 'create', message: cause?.message || '选择目录失败' })
                        }
                      },
                    },
                    '+ 添加项目',
                  ),
                  h('span', { className: 'gc-hint' }, '第一个目录会成为成员的工作目录，其余会写进提示词作为可参考的项目。'),
                ),
                h(
                  'div',
                  { className: 'gc-field' },
                  h('label', null, '成员模板'),
                  renderSelect('template', newTemplate, TEMPLATES, setNewTemplate),
                  h('span', { className: 'gc-hint' }, '选模板会自动配好成员；也可以先建空群。'),
                ),
                error?.scope === 'create' ? h('div', { className: 'gc-err' }, error.message) : null,
              ),
              h(
                'div',
                { className: 'gc-dlg-foot' },
                h('button', { type: 'button', className: 'gc-btn', onClick: () => setCreating(false) }, '取消'),
                h(
                  'button',
                  { type: 'button', className: 'gc-btn primary', disabled: !can, onClick: createGroup },
                  '建群',
                ),
              ),
            ),
          )
        }

        if (adding) {
          const noThread = adding.channel === 'dsh'
          const sid = adding.sid || ''
          const sidBad = sid.trim() !== '' && !SID_RE.test(sid.trim())
          const selected = (sessions || []).find((item) => item.id === sid) || null
          // 选中后输入框里显示的是标题，此时不该拿它当检索词
          const queryText = selected && selected.title === sessionQuery ? '' : sessionQuery
          const can = Boolean(adding.name.trim()) && !sidBad
          return h(
            'div',
            { className: 'gc-backdrop', onClick: (event) => event.target === event.currentTarget && setAdding(null) },
            h(
              'div',
              { className: 'gc-dlg', role: 'dialog', 'aria-modal': 'true' },
              h(
                'div',
                { className: 'gc-dlg-head' },
                h('h3', null, '加成员'),
                h('button', { type: 'button', className: 'gc-x', 'aria-label': '关闭', onClick: () => setAdding(null) }, '✕'),
              ),
              h(
                'div',
                { className: 'gc-dlg-body' },
                h(
                  'div',
                  { className: 'gc-field' },
                  h('label', null, '角色预设'),
                  renderSelect(
                    'role',
                    adding.preset || '',
                    ROLES.map((role) => ({ value: role.value, label: role.label })),
                    (value) => {
                      const preset = ROLES.find((role) => role.value === value)
                      setSessionQuery('')
                      setAdding({
                        ...adding,
                        preset: value,
                        name: preset ? preset.name : adding.name,
                        role: preset ? preset.role : '',
                        channel: preset && preset.channel ? preset.channel : adding.channel,
                        sid: '',
                        thread: null,
                      })
                    },
                    '选择角色预设（可选）',
                    () => setAdding({ ...adding, preset: '', name: '', role: '' }),
                  ),
                  h('span', { className: 'gc-hint' }, '选一个会自动填好名称和职责，仍可自己改。'),
                ),
                h(
                  'div',
                  { className: 'gc-field' },
                  h('label', null, '渠道'),
                  renderSelect('channel', adding.channel, CHANNELS, (value) => {
                    setSessions(null)
                    setSessionQuery('')
                    setAdding({ ...adding, channel: value, sid: '', thread: null })
                  }),
                ),
                h(
                  'div',
                  { className: 'gc-field' },
                  h('label', null, '名称'),
                  h('input', {
                    className: 'gc-input',
                    placeholder: '例如：架构师',
                    value: adding.name,
                    autoFocus: true,
                    onChange: (event) => setAdding({ ...adding, name: event.target.value }),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' && can) addMember()
                    },
                  }),
                ),
                h(
                  'div',
                  { className: 'gc-field' },
                  h('label', null, '职责 / 提示词（可选）'),
                  h('textarea', {
                    className: 'gc-input gc-role',
                    rows: 3,
                    placeholder: '会写进它的提示词；选预设会自动填好',
                    value: adding.role,
                    onChange: (event) => setAdding({ ...adding, role: event.target.value }),
                  }),
                ),
                h(
                  'div',
                  { className: `gc-field${sidBad ? ' invalid' : ''}` },
                  h('label', null, '已有会话 / 会话 ID（可选）'),
                  h(
                    'div',
                    { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                        h(
                          'div',
                          { className: 'gc-select', style: { flex: 1, minWidth: 0 } },
                          h(
                            'div',
                            { className: 'gc-input-wrap' },
                            h('input', {
                              className: 'gc-input',
                              spellCheck: false,
                              placeholder: sessions ? '搜索会话标题，或粘贴会话 ID' : '加载中…',
                              value: sessionQuery,
                              onFocus: (event) => {
                                const rect = event.currentTarget.getBoundingClientRect()
                                setOpenSelect({ key: 'session', up: window.innerHeight - rect.bottom < 320 })
                              },
                              onChange: (event) => {
                                const text = event.target.value
                                setSessionQuery(text)
                                const trimmed = text.trim()
                                // 整串是 UUID 就当手填 ID，否则视为检索词
                                if (SID_RE.test(trimmed)) {
                                setAdding({ ...adding, sid: trimmed, thread: null })
                              } else if (adding.sid && !SID_RE.test(trimmed)) {
                                setAdding({ ...adding, sid: '', thread: null })
                              }
                              setOpenSelect({ key: 'session', up: false })
                            },
                            onKeyDown: (event) => {
                              if (event.key === 'Escape') {
                                setOpenSelect(null)
                                return
                              }
                              const first = (sessions || []).find((session) => matchesQuery(session, queryText))
                              if (event.key === 'Enter' && openSelect && first) {
                                event.preventDefault()
                                pickSession(first)
                              }
                            },
                            }),
                            sessionQuery || sid
                              ? h(
                                  'span',
                                  {
                                    className: 'gc-clear',
                                    role: 'button',
                                    tabIndex: -1,
                                    title: '清除',
                                    onClick: () => {
                                      setAdding({ ...adding, sid: '', thread: null })
                                      setSessionQuery('')
                                      setOpenSelect(null)
                                    },
                                  },
                                  '✕',
                                )
                              : null,
                          ),
                          openSelect && openSelect.key === 'session'
                            ? h(
                                'div',
                                {
                                  className: 'gc-select-menu',
                                  role: 'listbox',
                                  style: openSelect.up ? { top: 'auto', bottom: 'calc(100% + 4px)' } : undefined,
                                },
                                (() => {
                                  const list = (sessions || []).filter((session) => matchesQuery(session, queryText))
                                  if (!list.length) {
                                    return h('div', { className: 'gc-none' }, sessions ? '没有匹配的会话' : '加载中…')
                                  }
                                  return list.map((session) =>
                                    h(
                                      'button',
                                      {
                                        key: session.id,
                                        type: 'button',
                                        className: 'gc-opt',
                                        role: 'option',
                                        'aria-selected': session.id === sid,
                                        onClick: () => pickSession(session),
                                      },
                                      h('span', { className: 'opt-main' }, session.title || session.id.slice(0, 8)),
                                      h('span', { className: 'sub' }, `${session.channel} · ${String(session.updatedAt).slice(0, 10)}`),
                                    ),
                                  )
                                })(),
                              )
                            : null,
                        ),
                      ),
                  h(
                    'span',
                    { className: 'gc-hint' },
                    sidBad
                      ? '看起来不是有效的会话 ID（UUID 形式）。'
                      : sid
                        ? adding.channel === 'dsh'
                          ? '只读取这条会话的历史当上下文，不会改写它。'
                          : '添加后它会接着这条会话的上下文说话。'
                        : '不选就是新会话，从零开始。',
                  ),
                ),
                sid && !sidBad && adding.channel !== 'dsh'
                  ? h(
                      'div',
                      { className: 'gc-field', style: { marginBottom: 4 } },
                      h('label', null, '接管方式（由你选，会记住）'),
                      h(
                        'div',
                        { className: 'gc-seg' },
                        h(
                          'button',
                          {
                            type: 'button',
                            'aria-pressed': adding.mode === 'fork',
                            onClick: () => {
                              saveMode('fork')
                              setAdding({ ...adding, mode: 'fork' })
                            },
                          },
                          '分叉',
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            'aria-pressed': adding.mode === 'resume',
                            onClick: () => {
                              saveMode('resume')
                              setAdding({ ...adding, mode: 'resume' })
                            },
                          },
                          '续写',
                        ),
                      ),
                      h(
                        'span',
                        { className: 'gc-hint' },
                        adding.mode === 'fork'
                          ? '分叉：读得到旧上下文，新回合写在一条新线程里，你原来那条会话一字不改。'
                          : '续写：直接往原会话里追加消息。原会话正被 Codex 桌面端打开时会失败，也改写了原会话历史。',
                      ),
                    )
                  : null,
                error?.scope === 'add' ? h('div', { className: 'gc-err' }, error.message) : null,
              ),
              h(
                'div',
                { className: 'gc-dlg-foot' },
                h('button', { type: 'button', className: 'gc-btn', onClick: () => setAdding(null) }, '取消'),
                h(
                  'button',
                  { type: 'button', className: 'gc-btn primary', disabled: !can || addingPending, onClick: addMember },
                  addingPending ? '添加中…' : sid && !sidBad ? '接管并添加' : '添加成员',
                ),
              ),
            ),
          )
        }

        return null
      }

      function renderFailure() {
        return h(
          'div',
          { className: 'gc-center', style: { gridColumn: '1 / -1' } },
          h('h3', null, '无法连接群聊服务'),
          h(
            'p',
            null,
            panelError?.auth
              ? '页面凭证已过期，刷新页面即可恢复。你的群和消息不会丢。'
              : panelError?.message || '请求失败',
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, marginTop: 6 } },
            panelError?.auth
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'gc-btn primary',
                    style: { width: 'auto' },
                    onClick: () => window.location.reload(),
                  },
                  '刷新页面',
                )
              : null,
            h(
              'button',
              {
                type: 'button',
                className: 'gc-btn',
                onClick: () => {
                  setPhase('loading')
                  loadState()
                },
              },
              '重试',
            ),
          ),
        )
      }

      function renderCreateGuide() {
        return h(
          'div',
          { className: 'gc-center', style: { gridColumn: '1 / -1' } },
          h('h3', null, '建第一个群'),
          h('p', null, '把 Codex、Claude Code、DeepSeek Harness 的成员拉进同一个面板。'),
          h(
            'button',
            {
              type: 'button',
              className: 'gc-btn primary',
              style: { width: 'auto', minWidth: 160 },
              onClick: () => {
                setCreating(true)
                setNewName('')
                setNewTemplate('')
                setNewProjects([])
              },
            },
            '+ 新建群',
          ),
        )
      }

      function renderMemberGuide() {
        return h(
          'div',
          { className: 'gc-center' },
          h('h3', null, '群里还没有人'),
          h('p', null, '加一个成员，就能开始发言。'),
          h(
            'button',
            {
              type: 'button',
              className: 'gc-btn primary',
              style: { width: 'auto', minWidth: 180, marginTop: 4 },
              onClick: () =>
                setAdding({ channel: 'dsh', preset: '', name: '', role: '', sid: '', mode: loadMode() }),
            },
            '+ 加第一个成员',
          ),
          h('p', null, 'dsh 成员最省钱；codex / claude 用你自己的登录'),
        )
      }

      function renderMembers() {
        return [
          ...members.map((member) =>
            h(
              'button',
              {
                key: member.id,
                type: 'button',
                className: 'gc-chip',
                'aria-pressed': targets.includes(member.id),
                title: `${member.name} · ${member.channel}${member.hasThread ? ' · 已绑定会话' : ' · 新会话'}`,
                onClick: () =>
                  setTargets((current) =>
                    current.includes(member.id)
                      ? current.filter((id) => id !== member.id)
                      : [...current, member.id],
                  ),
              },
              h('span', { className: 'gc-dot', 'data-ch': member.channel, 'data-bound': member.hasThread ? '1' : '0' }),
              member.name,
            ),
          ),
          targets.length
            ? h(
                'button',
                { key: 'clear', type: 'button', className: 'gc-btn', style: { height: 26, fontSize: 11 }, onClick: () => setTargets([]) },
                '清除选择',
              )
            : null,
        ]
      }

      function renderRoom() {
        if (!active) {
          return h('div', { className: 'gc-center' }, h('p', null, '从左侧选一个群，或新建一个。'))
        }
        const head = h(
          'div',
          { className: 'gc-room-head' },
          h(
            'button',
            {
              type: 'button',
              className: 'gc-btn icon gc-back',
              title: '返回群列表',
              onClick: () => setRoomOpen(false),
            },
            '←',
          ),
          h('div', { className: 't' }, active.name),
          h('span', { className: 'c' }, `· ${members.length} 人`),
          h('span', { style: { flex: 1 } }),
          h(
            'button',
            {
              type: 'button',
              className: 'gc-btn',
              onClick: () => setAdding({ channel: 'dsh', preset: '', name: '', role: '', sid: '', mode: loadMode() }),
            },
            '+ 加成员',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'gc-btn icon',
              title: '更多',
              onClick: () => setMenuOpen((value) => !value),
            },
            '⋯',
          ),
          menuOpen
            ? h(
                'div',
                { className: 'gc-menu' },
                h('button', { type: 'button', onClick: exportMinutes }, '导出纪要'),
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => {
                      setMenuOpen(false)
                      setRenameName(active.name)
                      setRenaming(active.id)
                    },
                  },
                  '重命名',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'danger',
                    onClick: () => {
                      setMenuOpen(false)
                      setRemoving(active.id)
                    },
                  },
                  '移除群聊',
                ),
              )
            : null,
        )

        const membersRow = h('div', { className: 'gc-members' }, ...renderMembers())

        if (!members.length) {
          return h(React.Fragment, null, head, membersRow, renderMemberGuide())
        }

        const disabled = busy || sending
        const who = recipients.length === 0
          ? '发给全体成员…'
          : recipients.length === 1
            ? `发给 ${recipients[0].name}…`
            : `发给 ${recipients.length} 位成员…`

        const jump = hasNew && !atBottom
          ? h('button', { type: 'button', className: 'gc-jump', onClick: () => { nearBottom.current = true; setAtBottom(true); setHasNew(false) } }, '有新消息 · 回到底部')
          : null

        return h(
          React.Fragment,
          null,
          head,
          membersRow,
          h(
            'div',
            { className: 'gc-scroll' },
            h('div', { className: 'gc-messages', ref: bodyRef, onScroll }, ...renderMessages()),
            jump,
          ),
          h(
            'div',
            { className: 'gc-foot' },
            error?.scope === 'say' ? h('div', { className: 'gc-err' }, error.message) : null,
            error?.scope === 'menu' ? h('div', { className: 'gc-err', style: { color: 'var(--gc-mu)' } }, error.message) : null,
            busy
              ? h(
                  'div',
                  { className: 'gc-busy' },
                  h('span', null, '等待成员回复…'),
                  h('button', { type: 'button', className: 'gc-btn', style: { height: 24, fontSize: 11 }, onClick: cancel }, '停止回复'),
                )
              : null,
            h(
              'div',
              { className: 'gc-composer' },
              mention
                ? h(
                    'div',
                    { className: 'gc-mentions' },
                    mentionCandidates.length
                      ? mentionCandidates.map((member, index) =>
                          h(
                            'button',
                            {
                              key: member.id,
                              type: 'button',
                              className: 'gc-mi',
                              'data-active': index === mention.index,
                              onMouseDown: (event) => event.preventDefault(),
                              onClick: () => pickMention(member),
                            },
                            h('span', { className: 'gc-dot', 'data-ch': member.channel, 'data-bound': member.hasThread ? '1' : '0' }),
                            member.name,
                            h('span', { className: 'hint' }, `${member.channel}${member.hasThread ? ' · 已绑定' : ''}`),
                          ),
                        )
                      : h('div', { className: 'none' }, '没有匹配的成员'),
                  )
                : null,
              h('textarea', {
                className: 'gc-ta',
                ref: taRef,
                rows: 1,
                placeholder: who,
                value: draft,
                disabled,
                onChange: (event) => {
                  setDraft(event.target.value)
                  refreshMention(event.target)
                },
                onKeyDown: (event) => {
                  if (mention) {
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                      event.preventDefault()
                      const list = mentionCandidates
                      if (!list.length) return
                      const step = event.key === 'ArrowDown' ? 1 : -1
                      setMention({ ...mention, index: (mention.index + step + list.length) % list.length })
                      return
                    }
                    if ((event.key === 'Enter' || event.key === 'Tab') && mentionCandidates.length) {
                      event.preventDefault()
                      pickMention(mentionCandidates[mention.index] || mentionCandidates[0])
                      return
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      setMention(null)
                      return
                    }
                  }
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    send()
                  }
                },
                onBlur: () => setTimeout(() => setMention(null), 120),
              }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'gc-btn primary',
                  disabled: !draft.trim() || disabled,
                  onClick: send,
                },
                sending ? '发送中…' : '发送',
              ),
            ),
            h(
              'div',
              { className: 'gc-reason' },
              busy ? '成员正在回复，稍等或点「停止回复」' : '@ 点名 · Enter 发送 · Shift+Enter 换行',
            ),
          ),
        )
      }

      const rootClass = `gc-root${narrow ? ' narrow' : ''}${narrow && roomOpen ? ' room-open' : ''}`

      let content
      if (phase === 'failed') content = renderFailure()
      else if (phase === 'loading') {
        content = h(
          'div',
          { style: { gridColumn: '1 / -1', padding: 14 } },
          h('div', { className: 'gc-skeleton', style: { width: '80%', height: 26, marginBottom: 8 } }),
          h('div', { className: 'gc-skeleton', style: { width: '60%', height: 26, marginBottom: 8 } }),
          h('div', { className: 'gc-skeleton', style: { width: '40%', height: 26 } }),
        )
      } else if (groups.length === 0) content = renderCreateGuide()
      else {
        content = [
          h(
            'aside',
            { key: 'list', className: 'gc-list' },
            h(
              'div',
              { className: 'gc-list-head' },
              h('b', null, '群聊'),
              archives.length
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'gc-btn',
                      style: { height: 24, padding: '0 6px', fontSize: 11 },
                      title: '已移除的群聊（聊天记录保留着）',
                      onClick: () => setArchivesOpen(true),
                    },
                    `已移除 ${archives.length}`,
                  )
                : null,
              h(
                'button',
                {
                  type: 'button',
                  className: 'gc-btn icon',
                  title: '新建群',
                  onClick: () => {
                    setCreating(true)
                    setNewName('')
                    setNewTemplate('')
                    setNewProjects([])
                  },
                },
                '+',
              ),
            ),
            h(
              'div',
              { className: 'gc-search' },
              h('input', {
                className: 'gc-input',
                style: { width: '100%' },
                placeholder: '搜索群聊…',
                value: query,
                onChange: (event) => setQuery(event.target.value),
              }),
            ),
            h('div', { className: 'gc-groups' }, ...renderGroupList()),
          ),
          h('section', { key: 'room', className: 'gc-room' }, renderRoom()),
        ]
      }

      return h(
        React.Fragment,
        null,
        h('style', null, CSS),
        h('div', { className: rootClass, ref: rootRef }, content, renderDialog()),
      )
    }

    /** The tab chip's title; the sidebar renders it. */
    function GroupTabTitle() {
      return h('span', null, '群聊')
    }

    /** Composer-dock launcher: opens (or focuses) the right-sidebar tab. */
    function GroupDock(props) {
      const [badge, setBadge] = React.useState(0)

      React.useEffect(() => {
        let alive = true
        const tick = () => {
          call('state')
            .then((payload) => {
              if (alive) setBadge(unreadCount(payload.groups || []))
            })
            .catch(() => {})
        }
        tick()
        const timer = setInterval(tick, 6000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])

      return h(
        'button',
        {
          type: 'button',
          title: '在右侧栏打开群聊',
          style: {
            height: '26px',
            padding: '0 10px',
            borderRadius: '13px',
            border: '1px solid var(--dsw-alias-border-default, rgba(127,127,127,0.35))',
            background: 'transparent',
            color: 'inherit',
            fontSize: '12px',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
          },
          onClick: () => props.open(),
        },
        '群聊',
        badge > 0
          ? h(
              'span',
              {
                style: {
                  minWidth: '14px',
                  height: '14px',
                  padding: '0 4px',
                  borderRadius: '7px',
                  background: 'var(--dsw-alias-accent, #4c8dff)',
                  color: '#fff',
                  fontSize: '10px',
                  lineHeight: '14px',
                  textAlign: 'center',
                },
              },
              badge > 99 ? '99+' : String(badge),
            )
          : null,
      )
    }

    return {
      inject: ['slots', 'sidebarRight', 'sidebarRightTabs', 'uiWorkspace'],
      apply(ctx) {
        // 原生文件夹选择器：建群时用它添加项目目录
        workspaceApi = ctx.uiWorkspace || null
        ctx.effect(() =>
          ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            priority: 'builtin',
            title: () => '群聊',
          }),
        )

        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, GroupChatTab),
        )
        ctx.slots.inject('sidebar.right.pane.tab.title', () =>
          ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, GroupTabTitle),
        )

        const open = () => {
          try {
            ctx.sidebarRight.openTab(TAB_KIND)
          } catch {
            /* the sidebar refused */
          }
        }

        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'dsh-group-chat', order: 5 },
            () => h(GroupDock, { open }),
          ),
        )
      },
    }
  },
})
