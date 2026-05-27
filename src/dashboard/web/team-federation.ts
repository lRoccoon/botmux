// Team (federation) page: manage this deployment's team membership across
// deployments. Unified "我的团队" view — each team (the one I host + ones I
// joined) is one collapsible block: deployments → bots, with a single 拉群
// control per team. Edit capability/role for MY bots; mint invite codes (Hub),
// join others' teams by invite (Spoke). All dashboard-token authed.
// See docs/federation-design.md.
import { escapeHtml } from './ui.js';

interface RosterBot {
  larkAppId: string; name: string; cliId: string; capability: string | null;
  hasTeamRole: boolean; deployment: { id: string; name: string; local: boolean; stale: boolean };
}
interface RosterDeployment { id: string; name: string; local: boolean; botCount: number; stale: boolean; }
interface LocalResp {
  ok: boolean; deployment: { deploymentId: string; name: string; ownerUnionId?: string; ownerName?: string };
  suggestedHubUrl: string; deployments: RosterDeployment[]; bots: RosterBot[];
}

/** One team block in the unified view: the team I host (kind=local) or a team I
 *  joined (kind=remote). Both render identically (deployments → bots + 拉群). */
interface Team {
  kind: 'local' | 'remote';
  key: string;            // 'local' or `${hubUrl}::${teamId}`
  label: string;          // '我托管的团队' or the remote team name
  sub: string;            // hubUrl (remote) — shown muted next to the label
  ok: boolean;            // remote connectivity (always true for local)
  error?: string;
  hubUrl?: string; teamId?: string; // remote only
  deployments: RosterDeployment[];
  bots: RosterBot[];
}

async function jget(u: string) { const r = await fetch(u); return { status: r.status, body: await r.json().catch(() => ({})) }; }
async function jpost(u: string, b?: unknown) {
  const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function jput(u: string, b: unknown) {
  const r = await fetch(u, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

let localTeam: Team | null = null;   // the team THIS deployment hosts
let remoteTeams: Team[] = [];        // teams this deployment joined
let myDeploymentId = '';             // this deployment's id → which bots are MINE (editable)
const pickedByTeam = new Map<string, Set<string>>(); // team.key → picked larkAppIds (for 拉群)
const collapsedTeams = new Set<string>();            // collapsed team.keys

function $(id: string): HTMLElement { return document.getElementById(id)!; }
function allTeams(): Team[] { return [...(localTeam ? [localTeam] : []), ...remoteTeams]; }
function pickedSet(key: string): Set<string> { let s = pickedByTeam.get(key); if (!s) { s = new Set(); pickedByTeam.set(key, s); } return s; }
function teamByKey(key: string): Team | undefined { return allTeams().find(t => t.key === key); }

function pageHtml(): string {
  return `<section class="page">
<div class="page-heading">
  <div>
    <p class="eyebrow">团队</p>
    <h1>团队协作（跨部署）</h1>
    <p>把别的部署（同事自己跑的 botmux）邀请进同一个团队，互相发现机器人、协作。</p>
  </div>
</div>

<div class="card" style="margin-bottom:16px">
  <h2 style="margin-top:0">本部署</h2>
  <p>我的飞书身份：<b id="tf-owner">未绑定</b>
    <button id="tf-autobind" class="primary" style="margin-left:8px">绑定</button>
    <span class="muted" style="font-size:13px">（用机器人凭证自动识别你；绑定后拉群会把你拉进群、机器人也归到你名下）</span></p>
  <div id="tf-bind-out" style="display:none;margin-top:6px"></div>
  <p class="muted" style="font-size:13px">别人加入你的团队时，需要你的 Hub 地址 + 邀请码。邀请码发给<b>别的部署</b>的人用（不能加入自己）。</p>
  <p><button id="tf-invite" class="primary">生成邀请码</button></p>
  <div id="tf-invite-out" style="display:none;margin-top:8px"></div>
</div>

<div class="card" style="margin-bottom:16px">
  <h2 style="margin-top:0">加入别人的团队</h2>
  <p style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
    <input id="tf-hub" placeholder="Hub 地址，如 http://10.0.0.5:7891" style="flex:1;min-width:240px">
    <input id="tf-code" placeholder="邀请码" style="min-width:160px">
    <button id="tf-join" class="primary">加入</button>
  </p>
  <div id="tf-join-out" style="display:none;margin-top:6px"></div>
</div>

<div class="card">
  <h2 style="margin-top:0">我的团队 <span class="muted" id="tf-count" style="font-size:13px"></span>
    <button id="tf-sync" class="ghost" style="float:right;font-size:13px">同步</button></h2>
  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px;font-size:13px">
    <input id="tf-search" placeholder="搜索 名称/能力/CLI…" style="padding:5px 9px;min-width:180px">
    <select id="tf-cli" style="padding:5px"><option value="">全部 CLI</option></select>
    <label><input type="checkbox" id="tf-fcap"> 有能力标签</label>
    <label><input type="checkbox" id="tf-frole"> 有团队角色</label>
  </div>
  <p class="muted" style="font-size:13px;margin:0 0 4px">「我托管的团队」是别人加入你后形成的；下面是你加入的别人的团队。每个团队里勾选机器人即可单独拉群（自动带上各自负责人）。</p>
  <div id="tf-teams">加载中…</div>
</div>

<div id="tf-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);align-items:center;justify-content:center;z-index:50">
  <div style="background:var(--card,#fff);color:var(--text,#1f2329);border-radius:10px;padding:18px 20px;width:min(560px,92vw)">
    <h2 id="tf-modal-title" style="margin-top:0">团队角色</h2>
    <p class="muted" style="font-size:13px">团队级角色（该机器人跨群的默认人设）。留空保存即删除。仅本部署的机器人可编辑。</p>
    <textarea id="tf-modal-text" style="width:100%;min-height:200px;font:13px/1.5 ui-monospace,Menlo,monospace;padding:10px;box-sizing:border-box"></textarea>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px">
      <button id="tf-modal-cancel">取消</button><button id="tf-modal-save" class="primary">保存</button>
    </div>
  </div>
</div>
</section>`;
}

function botMatch(b: RosterBot): boolean {
  const q = ((($('tf-search') as HTMLInputElement).value) || '').trim().toLowerCase();
  if (q && !((b.name || '') + ' ' + (b.cliId || '') + ' ' + (b.capability || '')).toLowerCase().includes(q)) return false;
  const cli = ($('tf-cli') as HTMLInputElement).value; if (cli && b.cliId !== cli) return false;
  if (($('tf-fcap') as HTMLInputElement).checked && !b.capability) return false;
  if (($('tf-frole') as HTMLInputElement).checked && !b.hasTeamRole) return false;
  return true;
}

/** Render one team's deployments → bots + a single 拉群 control. */
function renderTeamBody(t: Team, filtered: RosterBot[]): string {
  const ordered = [...t.deployments].sort((a, b) => (a.local === b.local ? 0 : a.local ? -1 : 1));
  let h = '';
  for (const dep of ordered) {
    const depBots = filtered.filter(x => x.deployment.id === dep.id);
    if (!depBots.length) continue;
    const mine = dep.id === myDeploymentId; // MY bots are editable wherever shown
    const tag = mine ? '本部署' : (dep.stale ? '远端·离线？' : '远端');
    h += `<div style="margin:10px 0 2px"><b>${escapeHtml(dep.name)}</b> <span class="muted" style="font-size:12px">（${tag}）· ${depBots.length} 个</span></div>`;
    h += '<table style="width:100%;border-collapse:collapse;font-size:14px"><tbody>';
    for (const b of depBots) {
      const app = escapeHtml(b.larkAppId);
      const ck = pickedSet(t.key).has(b.larkAppId) ? ' checked' : '';
      const dim = b.deployment.stale ? 'opacity:.55' : '';
      const capCell = mine
        ? `<input class="tf-cap" data-app="${app}" value="${escapeHtml(b.capability || '')}" placeholder="能力标签…" style="width:92%;padding:3px 6px">`
        : (b.capability ? escapeHtml(b.capability) : '<span class="muted">—</span>');
      const roleCell = mine
        ? `<button class="tf-role" data-app="${app}" data-name="${escapeHtml(b.name)}">${b.hasTeamRole ? '已设·改' : '设置'}</button>`
        : (b.hasTeamRole ? '有角色' : '<span class="muted">—</span>');
      h += `<tr style="${dim}"><td style="padding:4px 8px"><input type="checkbox" class="tf-pick" data-tk="${escapeHtml(t.key)}" data-app="${app}"${ck}></td>`
        + `<td style="padding:4px 8px">${escapeHtml(b.name)}</td><td style="padding:4px 8px" class="muted">${escapeHtml(b.cliId)}</td>`
        + `<td style="padding:4px 8px">${capCell}</td><td style="padding:4px 8px">${roleCell}</td></tr>`;
    }
    h += '</tbody></table>';
  }
  if (!h) h = '<p class="muted" style="margin:8px 0 0">没有符合条件的机器人。</p>';
  h += `<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">`
    + `<input class="tf-gname" data-tk="${escapeHtml(t.key)}" placeholder="群名（如：跨团队排障）" style="min-width:200px">`
    + `<button class="tf-grp primary" data-tk="${escapeHtml(t.key)}">把勾选的机器人拉一个群</button>`
    + `<span class="muted" style="font-size:13px">勾选机器人 → 拉到一个飞书群（自动含 owner）</span>`
    + `<span class="tf-gout" data-tk="${escapeHtml(t.key)}" style="font-size:13px;display:block;flex-basis:100%"></span></div>`;
  return h;
}

function renderTeams(): void {
  const el = $('tf-teams');
  const teams = allTeams();
  if (!teams.length) { el.innerHTML = '<p class="muted">还没有团队。生成邀请码让别人加入你，或用上方「加入别人的团队」。</p>'; $('tf-count').textContent = ''; return; }
  let html = ''; let shown = 0, total = 0;
  for (const t of teams) {
    const filtered = t.bots.filter(botMatch);
    shown += filtered.length; total += t.bots.length;
    const visible = new Set(filtered.map(b => b.larkAppId)); // prune picks now hidden by filter
    [...pickedSet(t.key)].forEach(a => { if (!visible.has(a)) pickedSet(t.key).delete(a); });
    const col = collapsedTeams.has(t.key);
    const conn = t.kind === 'remote'
      ? (t.ok ? ' <span class="ok" style="font-size:12px">已连接</span>' : ` <span class="err" style="font-size:12px">连接失败：${escapeHtml(t.error || '')}</span>`)
      : '';
    const leave = t.kind === 'remote'
      ? `<button class="tf-leave ghost" data-hub="${escapeHtml(t.hubUrl!)}" data-team="${escapeHtml(t.teamId!)}" style="font-size:12px">退出</button>` : '';
    html += `<div class="card" style="margin:0 0 12px;padding:12px 14px;background:var(--bg-soft,#f6f7f9)">`
      + `<div class="tf-team-h" data-tk="${escapeHtml(t.key)}" style="cursor:pointer;display:flex;align-items:center;gap:8px;flex-wrap:wrap">`
      + `<b style="font-size:15px">${col ? '▸' : '▾'} ${escapeHtml(t.label)}</b>`
      + (t.sub ? ` <span class="muted" style="font-size:12px">${escapeHtml(t.sub)}</span>` : '')
      + conn
      + ` <span class="muted" style="font-size:12px">· ${t.deployments.length} 个部署 · ${t.bots.length} 个机器人</span>`
      + `<span style="margin-left:auto">${leave}</span></div>`;
    if (!col) {
      html += (t.kind === 'remote' && !t.ok)
        ? '<p class="muted" style="margin:8px 0 0">无法获取该团队花名册。</p>'
        : renderTeamBody(t, filtered);
    }
    html += '</div>';
  }
  el.innerHTML = html;
  $('tf-count').textContent = `· 共 ${shown} / ${total} 个机器人`;
  wireTeams();
}

function wireTeams(): void {
  const el = $('tf-teams');
  el.querySelectorAll<HTMLElement>('.tf-team-h').forEach(h => {
    h.onclick = () => { const k = h.dataset.tk!; if (collapsedTeams.has(k)) collapsedTeams.delete(k); else collapsedTeams.add(k); renderTeams(); };
  });
  el.querySelectorAll<HTMLInputElement>('.tf-pick').forEach(cb => {
    cb.onchange = () => { const s = pickedSet(cb.dataset.tk!); if (cb.checked) s.add(cb.dataset.app!); else s.delete(cb.dataset.app!); };
  });
  el.querySelectorAll<HTMLInputElement>('.tf-cap').forEach(inp => {
    inp.onchange = async () => {
      const app = inp.dataset.app!, val = inp.value;
      await jput('/api/team/local-bots/' + encodeURIComponent(app) + '/capability', { capability: val });
      allTeams().forEach(t => { const bb = t.bots.find(b => b.larkAppId === app); if (bb) bb.capability = val.trim() || null; });
    };
  });
  el.querySelectorAll<HTMLButtonElement>('.tf-role').forEach(btn => { btn.onclick = () => openRoleModal(btn.dataset.app!, btn.dataset.name || ''); });
  el.querySelectorAll<HTMLButtonElement>('.tf-leave').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation(); // don't also toggle the team's collapse
      if (!confirm('退出该远端团队？将通知对方 Hub 移除你的部署。')) return;
      await jpost('/api/team/leave-remote', { hubUrl: btn.dataset.hub, teamId: btn.dataset.team });
      pickedByTeam.delete(`${btn.dataset.hub}::${btn.dataset.team}`);
      loadRemote();
    };
  });
  el.querySelectorAll<HTMLButtonElement>('.tf-grp').forEach(btn => {
    btn.onclick = async () => {
      const k = btn.dataset.tk!; const t = teamByKey(k); if (!t) return;
      const apps = [...pickedSet(k)];
      const out = el.querySelector<HTMLElement>(`.tf-gout[data-tk="${CSS.escape(k)}"]`)!;
      if (!apps.length) { out.innerHTML = '<span class="err">请先勾选至少一个机器人</span>'; return; }
      const name = (el.querySelector<HTMLInputElement>(`.tf-gname[data-tk="${CSS.escape(k)}"]`)?.value || '').trim() || '协作群';
      out.innerHTML = '<span class="muted">建群中…</span>';
      const r = t.kind === 'local'
        ? await jpost('/api/team/federated-group', { name, larkAppIds: apps })
        : await jpost('/api/team/remote-group', { hubUrl: t.hubUrl, teamId: t.teamId, name, larkAppIds: apps });
      renderGroupResult(out, r.body as any, r.status);
      if ((r.body as any)?.ok) { pickedSet(k).clear(); if (t.kind === 'local') loadLocal(); }
    };
  });
}

/** Shared 拉群-result renderer. */
function renderGroupResult(out: HTMLElement, b: any, status: number): void {
  if (b?.ok && b.chatId) {
    const link = b.shareLink || ('https://applink.feishu.cn/client/chat/open?openChatId=' + encodeURIComponent(b.chatId));
    const invalid = (b.invalidBotIds || []).length ? `<span class="err"> · 未加入的机器人：${escapeHtml((b.invalidBotIds || []).join(', '))}</span>` : '';
    const invOwners = (b.invalidOwnerUnionIds || []).length ? `<span class="err"> · ${(b.invalidOwnerUnionIds || []).length} 个 owner 未能拉进</span>` : '';
    const miss = b.missingOperatorIdentity ? `<span class="err"> · 你未绑定飞书身份，没把你自己拉进群（去「本部署」绑定）</span>` : '';
    const by = b.delegatedTo ? `（由「${escapeHtml(b.delegatedTo)}」建群）` : '';
    out.innerHTML = `<span class="ok">群已创建</span>${by} · <a href="${escapeHtml(link)}" target="_blank">在飞书打开</a>${invalid}${invOwners}${miss}`;
  } else {
    const e = b?.error || status;
    const msg = e === 'no_creator_available' ? '没有可用的建群发起方（相关部署都没有在线机器人，或不可达）'
      : e === 'delegation_timeout' ? '委托对方部署建群超时（可能已建，去飞书确认，勿重复点）'
      : `建群失败：${e}`;
    out.innerHTML = `<span class="err">${escapeHtml(String(msg))}</span>`;
  }
}

async function openRoleModal(app: string, name: string): Promise<void> {
  const r = await jget('/api/team/local-bots/' + encodeURIComponent(app) + '/role');
  $('tf-modal-title').textContent = '团队角色 · ' + name;
  ($('tf-modal-text') as HTMLTextAreaElement).value = (r.body as any)?.role || '';
  $('tf-modal').dataset.app = app;
  $('tf-modal').style.display = 'flex';
}

function refreshCliOptions(): void {
  const clis = Array.from(new Set(allTeams().flatMap(t => t.bots.map(x => x.cliId)).filter(Boolean))).sort();
  const sel = $('tf-cli') as HTMLSelectElement; const cur = sel.value;
  sel.innerHTML = '<option value="">全部 CLI</option>' + clis.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  sel.value = cur;
}

async function loadLocal(): Promise<void> {
  const r = await jget('/api/team/local');
  const b = r.body as LocalResp;
  if (!b?.ok) { localTeam = null; renderTeams(); return; }
  myDeploymentId = b.deployment.deploymentId;
  $('tf-owner').textContent = b.deployment.ownerName || (b.deployment.ownerUnionId ? '已绑定' : '未绑定');
  ($('tf-teams') as HTMLElement).dataset.hub = b.suggestedHubUrl; // for invite-code display
  localTeam = { kind: 'local', key: 'local', label: '我托管的团队', sub: '', ok: true, deployments: b.deployments || [], bots: b.bots || [] };
  refreshCliOptions();
  renderTeams();
}

async function loadRemote(): Promise<void> {
  const r = await jget('/api/team/remote-roster');
  const list = (r.body as any)?.memberships || [];
  remoteTeams = list.map((m: any) => ({
    kind: 'remote' as const, key: `${m.hubUrl}::${m.teamId}`, label: m.teamName || m.teamId, sub: m.hubUrl,
    ok: !!m.ok, error: m.error, hubUrl: m.hubUrl, teamId: m.teamId,
    deployments: m.roster?.deployments || [], bots: m.roster?.bots || [],
  }));
  refreshCliOptions();
  renderTeams();
}

export function renderTeamFederationPage(root: HTMLElement): void {
  root.innerHTML = pageHtml();
  pickedByTeam.clear(); collapsedTeams.clear();

  ['tf-search', 'tf-cli', 'tf-fcap', 'tf-frole'].forEach(id => { const el = $(id); el.oninput = renderTeams; el.onchange = renderTeams; });

  $('tf-modal-cancel').onclick = () => { $('tf-modal').style.display = 'none'; };
  $('tf-modal-save').onclick = async () => {
    const app = $('tf-modal').dataset.app!;
    await jput('/api/team/local-bots/' + encodeURIComponent(app) + '/role', { role: ($('tf-modal-text') as HTMLTextAreaElement).value });
    $('tf-modal').style.display = 'none';
    loadLocal();
  };

  $('tf-invite').onclick = async () => {
    const r = await jpost('/api/team/local-invite');
    const out = $('tf-invite-out');
    out.style.display = '';
    if ((r.body as any)?.code) {
      const hub = ($('tf-teams') as HTMLElement).dataset.hub || '';
      const code = (r.body as any).code;
      out.innerHTML = `<p class="muted" style="font-size:13px">把下面两项发给<b>别的部署</b>的人，让 ta 在自己 dashboard「团队」页里填（24 小时内、单次有效）：</p>
        <p>Hub 地址：<code>${escapeHtml(hub)}</code></p>
        <p>邀请码：<code style="font-size:16px">${escapeHtml(code)}</code></p>`;
    } else { out.innerHTML = '<span class="err">生成失败。</span>'; }
  };

  $('tf-join').onclick = async () => {
    const hubUrl = ($('tf-hub') as HTMLInputElement).value.trim();
    const inviteCode = ($('tf-code') as HTMLInputElement).value.trim();
    const out = $('tf-join-out');
    out.style.display = '';
    if (!hubUrl || !inviteCode) { out.innerHTML = '<span class="err">请填 Hub 地址和邀请码。</span>'; return; }
    out.innerHTML = '<span class="muted">加入中…</span>';
    const r = await jpost('/api/team/join-remote', { hubUrl, inviteCode });
    if ((r.body as any)?.ok) {
      out.innerHTML = `<span class="ok">已加入「${escapeHtml((r.body as any).teamName || '')}」</span>`;
      ($('tf-code') as HTMLInputElement).value = '';
      loadRemote();
    } else {
      const e = (r.body as any)?.error || r.status;
      const msg = e === 'cannot_join_self' ? '这是你自己的部署，不能加入自己（邀请码要发给别的部署的人用）' : e === 'deployment_already_joined' ? '你的部署已经加入过这个团队了' : e === 'hub_unreachable' ? '连不上对方 Hub（检查地址/网络）' : e === 'hub_timeout' ? '对方 Hub 响应超时' : `加入失败：${e}`;
      out.innerHTML = `<span class="err">${escapeHtml(String(msg))}</span>`;
    }
  };

  $('tf-sync').onclick = async () => { await jpost('/api/team/sync-remote'); loadRemote(); };

  // Bind this deployment's Feishu identity WITHOUT /pair: resolve allowedUsers
  // via the bots' own credentials. One candidate → bind; several → pick.
  $('tf-autobind').onclick = async () => {
    const out = $('tf-bind-out');
    out.style.display = '';
    out.innerHTML = '<span class="muted">识别中…</span>';
    const r = await jpost('/api/team/identity/auto-bind');
    const b: any = r.body;
    if (b?.ok && b.owner) { out.innerHTML = `<span class="ok">已绑定：${escapeHtml(b.owner.name || b.owner.unionId)}</span>`; loadLocal(); return; }
    if (b?.ok && b.needChoice && Array.isArray(b.candidates)) {
      const opts = b.candidates.map((c: any) => `<button class="tf-pickowner ghost" data-union="${escapeHtml(c.unionId)}" style="margin:2px">${escapeHtml(c.name || c.unionId)}</button>`).join(' ');
      out.innerHTML = `识别到多个候选，点你自己：<br>${opts}`;
      out.querySelectorAll<HTMLButtonElement>('.tf-pickowner').forEach(btn => {
        btn.onclick = async () => {
          out.innerHTML = '<span class="muted">绑定中…</span>';
          const r2 = await jpost('/api/team/identity/auto-bind', { unionId: btn.dataset.union });
          const b2: any = r2.body;
          if (b2?.ok && b2.owner) { out.innerHTML = `<span class="ok">已绑定：${escapeHtml(b2.owner.name || b2.owner.unionId)}</span>`; loadLocal(); }
          else { out.innerHTML = `<span class="err">绑定失败：${escapeHtml(String(b2?.error || 'unknown'))}</span>`; }
        };
      });
      return;
    }
    if (b?.error === 'no_candidates') { out.innerHTML = '<span class="err">没识别到身份：请确认机器人配置了 allowedUsers（允许使用者），且机器人有通讯录权限。</span>'; return; }
    out.innerHTML = `<span class="err">绑定失败：${escapeHtml(String(b?.error || 'unknown'))}</span>`;
  };

  void loadLocal();
  void loadRemote();
}
