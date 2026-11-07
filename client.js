/**
 * 浏览器侧前端（client half）—— QQ 邮箱面板。
 *
 * 运行位置：DSH Web GUI 的浏览器环境（不是 Node）。
 * 桥接方式：本插件是「静态包」，无 harness，前端拿不到 host.call，
 *          所有数据都通过 fetch 打到真实 Node 起的本地 HTTP（127.0.0.1:32999）。
 *
 * 挂载策略（遵守 UI 插件规范，对齐 plugin-manager / schedule）：
 *  - sidebar.panellist：在侧栏加一个「邮箱」图标按钮（list 槽，replaceRisk:none）。
 *                        id 与下面 main 面板的 key 同名，点图标 → ctx.layout.selectPanel 打开对应 main 面板。
 *  - main：中栏面板（key 与侧栏入口 id 同名），内嵌 React 邮件管理器（列表/写信/详情/删除/批量删除）。
 *  - 样式只用 --dsw-alias-* 主题 token，跟随深/浅色；不导入任何 Harness Client 包。
 */
window.__ModuleLoader__.load({
  id: '@local/qq-mail-dsh',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    const API = 'http://127.0.0.1:32999';

    /** 带超时/可中断的 fetch：服务器偶发僵死时，前端最多等一会儿就报错，而不是永远“加载中”。 */
    async function fetchWithTimeout(url, opts = {}, ms = 20000) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), ms);
      try {
        return await fetch(url, { ...opts, signal: ctrl.signal });
      } finally {
        clearTimeout(t);
      }
    }

    // ---- 主题 token（CSS 变量，跟随宿主深/浅色）----
    const css = `
.qm-root{position:relative;height:100%;width:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:14px;}
.qm-head{padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);display:flex;align-items:center;gap:8px;flex:0 0 auto;}
.qm-title{font-weight:600;flex:1;}
.qm-btn{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:5px 10px;cursor:pointer;font-size:13px;white-space:nowrap;}
.qm-btn:hover{border-color:var(--dsw-alias-brand-primary);}
.qm-btn.primary{background:var(--dsw-alias-brand-primary);color:#fff;border-color:transparent;}
.qm-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);}
.qm-tabs{display:flex;gap:4px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto;}
.qm-tab{padding:5px 10px;border-radius:6px;cursor:pointer;color:var(--dsw-alias-label-secondary);}
.qm-tab.active{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600;}
.qm-batch{display:flex;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1);flex:0 0 auto;}
.qm-selbar{font-size:12px;color:var(--dsw-alias-label-secondary);}
.qm-check{width:16px;height:16px;cursor:pointer;flex:0 0 auto;margin-right:6px;}
.qm-list{flex:1;overflow:auto;padding:6px 8px;min-height:0;}
.qm-item{position:relative;padding:9px 10px 9px 18px;border-radius:8px;cursor:pointer;border:1px solid transparent;}
.qm-item:hover{background:var(--dsw-alias-bg-layer-1);}
.qm-item.sel{background:var(--dsw-alias-bg-layer-2);}
.qm-item.unread .qm-subj{font-weight:700;}
.qm-item.unread::before{content:'';position:absolute;left:5px;top:50%;transform:translateY(-50%);width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-error-primary);}
.qm-search{display:flex;gap:6px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto;}
.qm-search-input{flex:1;min-width:0;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 10px;color:var(--dsw-alias-label-primary);font-size:13px;}
.qm-pg-input{width:40px;text-align:center;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:4px;color:var(--dsw-alias-label-primary);font-size:13px;padding:3px;}
.qm-row1{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);
  align-items:center;}
.qm-subj{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.qm-from{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.qm-detail{flex:1;overflow:auto;padding:12px 14px;min-height:0;}
.qm-detail h3{margin:0 0 6px;font-size:15px;}
.qm-meta{font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:10px;white-space:pre-line;}
.qm-body{white-space:pre-wrap;line-height:1.6;word-break:break-word;}
.qm-compose{display:flex;flex-direction:column;gap:8px;padding:12px 14px;overflow:auto;flex:1;min-height:0;}
.qm-input,.qm-textarea{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:8px;font-size:13px;width:100%;box-sizing:border-box;}
.qm-textarea{min-height:160px;resize:vertical;font-family:inherit;}
.qm-err{color:var(--dsw-alias-state-error-primary);padding:10px 14px;font-size:13px;}
.qm-empty{color:var(--dsw-alias-label-secondary);padding:18px;text-align:center;}
.qm-body2{display:flex;flex:1;min-height:0;overflow:hidden;}
.qm-folders{flex:0 0 160px;overflow:auto;padding:6px;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);}
.qm-fnode{padding:5px 6px;border-radius:6px;cursor:pointer;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;gap:4px;}
.qm-fnode:hover{background:var(--dsw-alias-bg-layer-2);}
.qm-fnode.active{background:var(--dsw-alias-bg-layer-2);font-weight:600;color:var(--dsw-alias-brand-primary);}
.qm-fnode.nosel{cursor:default;color:var(--dsw-alias-label-secondary);}
.qm-fnode.nosel:hover{background:transparent;}
.qm-farrow{width:13px;flex:0 0 auto;text-align:center;color:var(--dsw-alias-label-secondary);user-select:none;font-size:11px;}
.qm-ficon{font-size:13px;flex:0 0 auto;}
.qm-content{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;}
.qm-pager{display:flex;gap:6px;align-items:center;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-secondary);flex:0 0 auto;flex-wrap:wrap;}
.qm-pg-info{margin-right:4px;}
.qm-pg-input{width:46px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:2px 4px;font-size:12px;text-align:center;}
.qm-center{display:flex;align-items:center;justify-content:center;flex:1;min-height:0;}
.qm-loading{color:var(--dsw-alias-label-secondary);font-size:14px;}
.qm-login{width:min(420px,92%);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:22px 22px 18px;display:flex;flex-direction:column;gap:12px;box-shadow:0 6px 24px rgba(0,0,0,.18);}
.qm-login-title{font-size:17px;font-weight:700;color:var(--dsw-alias-label-primary);}
.qm-login-sub{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:-6px;}
.qm-login .qm-btn{width:100%;justify-content:center;padding:9px;}
.qm-help{margin-top:2px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px;font-size:12px;color:var(--dsw-alias-label-secondary);}
.qm-help summary{cursor:pointer;user-select:none;}
.qm-help-body{margin-top:8px;line-height:1.7;}
.qm-settings{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);flex:0 0 auto;flex-wrap:wrap;}
.qm-settings .qm-label{font-size:13px;color:var(--dsw-alias-label-secondary);flex:1;min-width:120px;}
.qm-switch{position:relative;width:42px;height:24px;border-radius:12px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);cursor:pointer;flex:0 0 auto;transition:background .2s,border-color .2s;}
.qm-switch.on{background:var(--dsw-alias-brand-primary);border-color:transparent;}
.qm-switch .qm-knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .2s;}
.qm-switch.on .qm-knob{left:22px;}
.qm-set-note{font-size:12px;color:var(--dsw-alias-label-secondary);}
`;

    // 侧栏图标组件：仅渲染图标，渲染在 harness 的面板行里，点击由 harness 处理（selectPanel）。
    // 接收 owner props：{ size:number; active:boolean }。
    const MailIcon = ({ size = 20, active = false }) =>
      h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', 'stroke-width': 2,
        style: active ? { color: 'var(--dsw-alias-brand-primary)' } : undefined,
      },
        h('rect', { x: 3, y: 5, width: 18, height: 14, rx: 2 }),
        h('path', { d: 'M3 7l9 6 9-6' }));

    function senderOf(m) {
      return (m.from || []).map((f) => (f && (f.name || f.address)) || f || '').join(', ');
    }

    // 文件夹图标（按特殊用途）
    function folderIcon(su) {
      switch (su) {
        case 'inbox': return '📥';
        case 'sent': return '📤';
        case 'trash': return '🗑️';
        case 'drafts': return '📝';
        case 'junk': return '⚠️';
        default: return '📁';
      }
    }

    // 递归渲染文件夹树（支持父子展开/收起；\NoSelect 节点只看不点）
    function FolderNode({ node, depth, activePath, collapsed, toggle, onPick }) {
      const kids = node.children || [];
      const hasKids = kids.length > 0;
      const expanded = !collapsed.has(node.path);
      const isActive = activePath === node.path;
      return h('div', null,
        h('div', {
          className: 'qm-fnode' + (isActive ? ' active' : '') + (node.noSelect ? ' nosel' : ''),
          style: { paddingLeft: 6 + depth * 12 },
          title: node.path,
          onClick: () => { if (!node.noSelect) onPick(node.path); },
        },
          hasKids
            ? h('span', {
                className: 'qm-farrow',
                onClick: (e) => { e.stopPropagation(); toggle(node.path); },
              }, expanded ? '▾' : '▸')
            : h('span', { className: 'qm-farrow' }, ''),
          h('span', { className: 'qm-ficon' }, folderIcon(node.specialUse)),
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, node.label),
        ),
        expanded && hasKids && kids.map((c) =>
          h(FolderNode, {
            key: c.path,
            node: c,
            depth: depth + 1,
            activePath,
            collapsed,
            toggle,
            onPick,
          })),
      );
    }

    function MailApp({ onClose }) {
      const [view, setView] = useState('list'); // list | detail
      const [folder, setFolder] = useState('INBOX');
      const [folders, setFolders] = useState([]); // 文件夹树（来自 /api/folders）
      const [folderLoading, setFolderLoading] = useState(false);
      const [mails, setMails] = useState([]);
      const [total, setTotal] = useState(0);
      const [page, setPage] = useState(1);
      const [pageSize] = useState(30);
      const [pageCount, setPageCount] = useState(1);
      const [jump, setJump] = useState('1');
      const [collapsed, setCollapsed] = useState(() => new Set()); // 已收起的文件夹路径
      const [cur, setCur] = useState(null);
      const [loading, setLoading] = useState(false);
      const [err, setErr] = useState('');
      const [selected, setSelected] = useState([]); // 多选：已勾选的邮件 id
      const [searchInput, setSearchInput] = useState(''); // 搜索框输入（未提交）
      const [search, setSearch] = useState(''); // 已提交的搜索词
      const [me, setMe] = useState({ loaded: false, bound: false, account: '' }); // 绑定状态
      const [bindAccount, setBindAccount] = useState(''); // 登录页：邮箱
      const [bindCode, setBindCode] = useState(''); // 登录页：授权码
      const [bindErr, setBindErr] = useState('');
      const [bindLoading, setBindLoading] = useState(false);
      const [digest, setDigestState] = useState({ loaded: false, enabled: false, hour: 21, minute: 0, target: '' });
      const [digestSaving, setDigestSaving] = useState(false);
      const openingRef = useRef(false); // 防重入：避免连点把请求打爆

      // 文件夹树：挂载时拉一次（QQ 文件夹不常变）
      const loadFolders = useCallback(async () => {
        setFolderLoading(true);
        try {
          const r = await fetchWithTimeout(`${API}/api/folders`);
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || '加载文件夹失败');
          setFolders(j.folders || []);
        } catch (e) {
          setErr(e.message === 'AbortError' ? '文件夹加载超时，请重试' : (e.message || '加载文件夹失败'));
        } finally {
          setFolderLoading(false);
        }
      }, []);

      const loadList = useCallback(async () => {
        setLoading(true);
        setErr('');
        try {
          const qs = search ? `&q=${encodeURIComponent(search)}` : '';
          const r = await fetchWithTimeout(
            `${API}/api/mails?folder=${encodeURIComponent(folder)}&page=${page}&pageSize=${pageSize}${qs}`);
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || '加载失败');
          setMails(j.mails);
          setTotal(j.total);
          setPageCount(j.pageCount || 1);
          if (j.page) setPage(j.page);
        } catch (e) {
          setErr(e.message === 'AbortError' ? '加载超时，请重试' : (e.message || '加载失败'));
        } finally {
          setLoading(false);
        }
      }, [folder, page, pageSize, search]);

      // 定时摘要状态：绑定成功后拉一次（默认关，可在面板随时开关）
      const loadDigest = useCallback(async () => {
        try {
          const r = await fetchWithTimeout(`${API}/api/digest`);
          const j = await r.json();
          if (j.ok) setDigestState({ loaded: true, enabled: !!j.enabled, hour: j.hour || 21, minute: j.minute || 0, target: j.target || '' });
        } catch {
          setDigestState((d) => ({ ...d, loaded: true }));
        }
      }, []);

      // 挂载时先问后端是否已绑定；未绑定则前端展示登录页
      useEffect(() => {
        (async () => {
          try {
            const r = await fetchWithTimeout(`${API}/api/me`);
            const j = await r.json();
            setMe({ loaded: true, bound: !!j.bound, account: j.account || '' });
            if (j.bound) { loadFolders(); loadDigest(); }
          } catch {
            setMe({ loaded: true, bound: false, account: '' });
          }
        })();
      }, [loadFolders, loadDigest]);

      useEffect(() => { if (me.bound) loadFolders(); }, [me.bound, loadFolders]);
      useEffect(() => { if (view === 'list' && me.bound) loadList(); }, [view, loadList, me.bound]);
      useEffect(() => { setJump(String(page)); }, [page]);

      // 当前文件夹的中文名（从树里找）
      const folderLabel = (() => {
        let label = folder;
        const walk = (arr) => {
          for (const n of arr) {
            if (n.path === folder) { label = n.label; return true; }
            if (n.children && walk(n.children)) return true;
          }
          return false;
        };
        walk(folders);
        return label;
      })();

      const toggle = (path) => setCollapsed((s) => {
        const n = new Set(s);
        if (n.has(path)) n.delete(path); else n.add(path);
        return n;
      });

      const openMail = async (m) => {
        if (openingRef.current) return; // 防重入
        openingRef.current = true;
        setLoading(true);
        setErr('');
        try {
          const r = await fetchWithTimeout(`${API}/api/mails/${encodeURIComponent(m.folder || folder)}/${encodeURIComponent(m.id)}`);
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || '打开失败');
          setCur({ ...j.mail, seen: true }); // 打开即已读
          setMails((prev) => prev.map((x) => (x.id === m.id ? { ...x, seen: true } : x)));
          setView('detail');
        } catch (e) {
          setErr(e.message === 'AbortError' ? '打开超时，请重试' : (e.message || '打开失败'));
        } finally {
          setLoading(false);
          openingRef.current = false;
        }
      };

      // 登录页：提交绑定（邮箱 + 授权码）
      const doBind = async () => {
        if (!bindAccount.trim() || !bindCode.trim()) { setBindErr('邮箱和授权码都要填'); return; }
        setBindLoading(true);
        setBindErr('');
        try {
          const r = await fetchWithTimeout(`${API}/api/bind`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ account: bindAccount.trim(), authCode: bindCode.trim() }),
          });
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || '绑定失败');
          setMe({ loaded: true, bound: true, account: bindAccount.trim() });
          setBindAccount(''); setBindCode('');
          loadFolders();
        } catch (e) {
          setBindErr(e.message === 'AbortError' ? '绑定超时，请重试' : (e.message || '绑定失败'));
        } finally {
          setBindLoading(false);
        }
      };

      // 面板设置区：随时开/关“定时会话投递”
      const doToggleDigest = async () => {
        const next = !digest.enabled;
        setDigestSaving(true);
        try {
          const r = await fetchWithTimeout(`${API}/api/digest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: next }),
          });
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || '设置失败');
          setDigestState((d) => ({
            ...d, enabled: !!j.enabled, hour: j.hour || d.hour,
            minute: j.minute || d.minute, target: j.target || d.target, loaded: true,
          }));
        } catch (e) {
          setErr(e.message === 'AbortError' ? '超时，请重试' : (e.message || '设置失败'));
        } finally {
          setDigestSaving(false);
        }
      };

      // 登录页视图
      const renderLogin = () => h('div', { className: 'qm-login' },
        h('div', { className: 'qm-login-title' }, '绑定 QQ 邮箱'),
        h('div', { className: 'qm-login-sub' }, '首次使用请填写邮箱与授权码（授权码不是登录密码）'),
        h('input', {
          className: 'qm-input', placeholder: 'QQ 邮箱（如 123@qq.com）',
          value: bindAccount, onChange: (e) => setBindAccount(e.target.value),
        }),
        h('input', {
          className: 'qm-input', type: 'password', placeholder: '授权码（QQ 邮箱设置里生成）',
          value: bindCode, onChange: (e) => setBindCode(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') doBind(); },
        }),
        bindErr && h('div', { className: 'qm-err' }, '⚠ ' + bindErr),
        h('button', { className: 'qm-btn primary', onClick: doBind, disabled: bindLoading },
          bindLoading ? '绑定中…' : '绑定并进入'),
        h('details', { className: 'qm-help' },
          h('summary', null, '如何获取授权码？'),
          h('div', { className: 'qm-help-body' },
            h('div', null, '1. 电脑登录 QQ 邮箱网页版 mail.qq.com；'),
            h('div', null, '2. 右上角「设置」→「账户」；'),
            h('div', null, '3. 下滑到「POP3/IMAP/SMTP…服务」，开启「IMAP/SMTP 服务」；'),
            h('div', null, '4. 按提示用手机发短信验证后，点击「生成授权码」，复制这串 16 位字符填到上方。'),
          ),
        ),
      );

      const remove = async (m) => {
        if (!confirm('确定删除这封邮件？')) return;
        setLoading(true);
        try {
          const r = await fetchWithTimeout(`${API}/api/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: m.id, folder: m.folder || folder }),
          });
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || '删除失败');
          if (view === 'detail') setView('list');
          loadList();
        } catch (e) {
          setErr(e.message === 'AbortError' ? '删除超时，请重试' : (e.message || '删除失败'));
        } finally {
          setLoading(false);
        }
      };

      const toggleSelect = (id) => {
        setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
      };

      const batchRemove = async () => {
        if (!selected.length) return;
        if (!confirm(`确定删除选中的 ${selected.length} 封邮件？`)) return;
        setLoading(true);
        try {
          for (const id of selected) {
            const r = await fetchWithTimeout(`${API}/api/delete`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id, folder }),
            });
            const j = await r.json();
            if (!j.ok) throw new Error(j.error || '删除失败');
          }
          setSelected([]);
          await loadList();
        } catch (e) {
          setErr(e.message === 'AbortError' ? '删除超时，请重试' : (e.message || '删除失败'));
        } finally {
          setLoading(false);
        }
      };

      const batchMarkRead = async () => {
        if (!selected.length) return;
        setLoading(true);
        try {
          for (const id of selected) {
            const r = await fetchWithTimeout(`${API}/api/seen`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id, folder, seen: true }),
            });
            const j = await r.json();
            if (!j.ok) throw new Error(j.error || '标记失败');
          }
          setMails((prev) => prev.map((x) => (selected.includes(x.id) ? { ...x, seen: true } : x)));
          setSelected([]);
        } catch (e) {
          setErr(e.message === 'AbortError' ? '超时，请重试' : (e.message || '标记失败'));
        } finally {
          setLoading(false);
        }
      };

      const switchFolder = (f) => {
        setFolder(f);
        setPage(1);
        setSearch(''); setSearchInput(''); // 切换文件夹清空搜索
        setView('list');
        setSelected([]); // 切换文件夹清空多选
      };

      const allSelected = mails.length > 0 && selected.length === mails.length;
      const toggleSelectAll = () => {
        setSelected(allSelected ? [] : mails.map((m) => m.id));
      };

      return h('div', { className: 'qm-root' },
        h('style', null, css),
        h('div', { className: 'qm-head' },
          h('span', { className: 'qm-title' }, me.bound ? 'QQ 邮箱' : 'QQ 邮箱 · 绑定'),
          view === 'detail' && h('button', { className: 'qm-btn', onClick: () => setView('list') }, '← 返回'),
          onClose && h('button', { className: 'qm-btn', onClick: onClose }, '✕'),
        ),

        me.bound && digest.loaded && h('div', { className: 'qm-settings' },
          h('span', { className: 'qm-label' },
            `定时会话投递 · 每天 ${String(digest.hour).padStart(2, '0')}:${String(digest.minute).padStart(2, '0')} 把最近会话汇总发到 ${digest.target || me.account}`),
          h('div', {
            className: 'qm-switch' + (digest.enabled ? ' on' : ''),
            role: 'switch', 'aria-checked': digest.enabled,
            onClick: doToggleDigest,
          }, h('div', { className: 'qm-knob' })),
          digestSaving && h('span', { className: 'qm-set-note' }, '保存中…'),
        ),

        !me.loaded
          ? h('div', { className: 'qm-body2 qm-center' }, h('div', { className: 'qm-loading' }, '加载中…'))
          : !me.bound
            ? h('div', { className: 'qm-body2 qm-center' }, renderLogin())
            : h('div', { className: 'qm-body2' },
          // 左侧：文件夹树（含 QQ 所有分类 + 父子层级）
          h('div', { className: 'qm-folders' },
            folderLoading && h('div', { className: 'qm-fnode' }, '加载文件夹…'),
            !folderLoading && folders.length === 0 && h('div', { className: 'qm-fnode' }, '无文件夹'),
            folders.map((node) =>
              h(FolderNode, {
                key: node.path,
                node,
                depth: 0,
                activePath: folder,
                collapsed,
                toggle,
                onPick: switchFolder,
              })),
          ),

          // 右侧：内容区（列表 / 详情）+ 分页
          h('div', { className: 'qm-content' },
            view === 'list' && h('div', { className: 'qm-pager' },
              h('span', { className: 'qm-pg-info' }, search ? `搜索「${search}」 · 共 ${total} 封` : `${folderLabel} · 共 ${total} 封`),
              h('span', { style: { flex: 1 } }),
              h('button', { className: 'qm-btn', disabled: page <= 1, onClick: () => setPage(1) }, '« 首页'),
              h('button', { className: 'qm-btn', disabled: page <= 1, onClick: () => setPage((p) => Math.max(1, p - 1)) }, '← 上一页'),
              h('span', null, '第 ',
                h('input', {
                  className: 'qm-pg-input',
                  value: jump,
                  onChange: (e) => setJump(e.target.value.replace(/[^0-9]/g, '')),
                }),
                ' 页 / 共 ', String(pageCount), ' 页'),
              h('button', {
                className: 'qm-btn',
                onClick: () => { const n = parseInt(jump, 10); if (!isNaN(n)) setPage(Math.min(pageCount, Math.max(1, n))); },
              }, '跳转'),
              h('button', { className: 'qm-btn', disabled: page >= pageCount, onClick: () => setPage((p) => Math.min(pageCount, p + 1)) }, '下一页 →'),
              h('button', { className: 'qm-btn', disabled: page >= pageCount, onClick: () => setPage(pageCount) }, '末页 »'),
            ),

            // 多选工具条：勾选了邮件才出现
            view === 'list' && selected.length > 0 && h('div', { className: 'qm-batch' },
              h('input', { type: 'checkbox', className: 'qm-check', checked: allSelected, onChange: toggleSelectAll }),
              h('span', { className: 'qm-selbar' }, `已选 ${selected.length} 封`),
              h('button', { className: 'qm-btn', onClick: batchMarkRead, disabled: loading }, '标为已读'),
              h('button', { className: 'qm-btn danger', onClick: batchRemove, disabled: loading }, '删除选中'),
              h('button', { className: 'qm-btn', onClick: () => setSelected([]) }, '取消选择'),
            ),

            // 搜索框：在当前文件夹内按主题/发件人/正文搜索（回车提交）
            view === 'list' && h('div', { className: 'qm-search' },
              h('input', {
                className: 'qm-search-input',
                placeholder: '搜索本文件夹（主题/发件人/正文）',
                value: searchInput,
                onChange: (e) => setSearchInput(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') { setSearch(searchInput); setPage(1); } },
              }),
              search && h('button', { className: 'qm-btn', onClick: () => { setSearchInput(''); setSearch(''); setPage(1); } }, '清除'),
            ),

            err && h('div', { className: 'qm-err' }, '⚠ ' + err),

            view === 'list' && h('div', { className: 'qm-list' },
              loading && h('div', { className: 'qm-empty' }, '加载中…'),
              !loading && mails.length === 0 && h('div', { className: 'qm-empty' }, '暂无邮件'),
              mails.map((m) =>
                h('div', {
                  key: m.id,
                  className: 'qm-item' + (m.seen ? '' : ' unread') + (selected.includes(m.id) ? ' sel' : ''),
                  onClick: () => openMail(m),
                  onContextMenu: (e) => { e.preventDefault(); remove(m); },
                },
                  h('div', { style: { display: 'flex', alignItems: 'center' } },
                    h('input', {
                      type: 'checkbox',
                      className: 'qm-check',
                      checked: selected.includes(m.id),
                      onClick: (e) => { e.stopPropagation(); toggleSelect(m.id); },
                    }),
                    h('div', { style: { flex: 1, minWidth: 0 } },
                      h('div', { className: 'qm-row1' },
                        h('span', { className: 'qm-subj' }, m.subject || '(无主题)'),
                        h('span', null, String(m.date || '').slice(0, 10)),
                      ),
                      h('div', { className: 'qm-from' }, senderOf(m)),
                    ),
                  ),
                ),
              ),
            ),

            view === 'detail' && cur && h('div', { className: 'qm-detail' },
              h('h3', null, cur.subject || '(无主题)'),
              h('div', { className: 'qm-meta' },
                '发件人：' + (cur.from || []).map((f) => f.address).join(', ') + '\n',
                '时间：' + cur.date),
              h('div', { className: 'qm-body' }, cur.text || '(无正文)'),
              cur.links && cur.links.length
                ? h('div', { style: { marginTop: 12 } },
                    h('div', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } }, '链接：'),
                    cur.links.map((l, i) => h('div', { key: i }, h('a', { href: l, target: '_blank', style: { color: 'var(--dsw-alias-brand-primary)' } }, l))),
                  )
                : null,
              h('div', { style: { marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' } },
                h('button', { className: 'qm-btn', onClick: () => remove(cur) }, '删除'),
                h('button', {
                  className: 'qm-btn',
                  onClick: async () => {
                    const wantUnread = cur.seen !== false; // 已读→标未读；未读→标已读
                    setLoading(true);
                    try {
                      const r = await fetchWithTimeout(`${API}/api/seen`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id: cur.id, folder: cur.folder || folder, seen: !wantUnread }),
                      });
                      const j = await r.json();
                      if (!j.ok) throw new Error(j.error || '操作失败');
                      setCur((c) => ({ ...c, seen: !wantUnread }));
                      setMails((prev) => prev.map((x) => (x.id === cur.id ? { ...x, seen: !wantUnread } : x)));
                    } catch (e) { setErr(e.message || '操作失败'); } finally { setLoading(false); }
                  },
                }, cur.seen !== false ? '标为未读' : '标为已读'),
                h('button', { className: 'qm-btn', onClick: () => { setCur(null); setView('list'); } }, '返回列表'),
              ),
            ),

          ),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 侧栏图标入口（list 槽，低风险）。id 与下面 main 面板 key 同名。
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'qq-mail', order: 50,
          locale: 'common', label: () => 'QQ 邮箱',
        }, MailIcon));

        // 中栏面板（key 与侧栏入口 id 同名）。点击侧栏图标 → ctx.layout.selectPanel('qq-mail') 打开它。
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: 'qq-mail',
          locale: 'common',
          inject: () => ({
            onClose: () => ctx.layout && ctx.layout.selectPanel(null),
          }),
        }, MailApp));
      },
    };
  },
});
