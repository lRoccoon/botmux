/**
 * Team platform single-page UI, embedded as a string so it ships in dist with
 * no extra build step. Vanilla JS, no framework. Talks to /api/pairing/* and
 * /api/team/* (see team-routes.ts). Served at GET /team (pre-auth; the page
 * self-authenticates via the pairing flow → bmx_session cookie).
 */
export const TEAM_PAGE_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>botmux 团队平台</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, system-ui, "PingFang SC", sans-serif; margin: 0; background: #f6f7f9; color: #1f2329; }
  header { padding: 14px 20px; background: #1f2329; color: #fff; display: flex; justify-content: space-between; align-items: center; }
  header b { font-size: 16px; }
  main { max-width: 920px; margin: 0 auto; padding: 20px; }
  .card { background: #fff; border: 1px solid #e5e6eb; border-radius: 10px; padding: 18px 20px; margin-bottom: 16px; }
  h2 { font-size: 15px; margin: 0 0 12px; color: #4e5969; }
  .code { font: 28px/1.2 ui-monospace, Menlo, monospace; letter-spacing: 4px; background: #f2f3f5; padding: 12px 16px; border-radius: 8px; display: inline-block; }
  button { font: inherit; padding: 8px 16px; border-radius: 8px; border: 1px solid #d0d3d9; background: #fff; cursor: pointer; }
  button.primary { background: #3370ff; color: #fff; border-color: #3370ff; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #f0f1f3; }
  th { color: #86909c; font-weight: 500; }
  .tag { font-size: 12px; padding: 2px 8px; border-radius: 10px; background: #e8f3ff; color: #3370ff; }
  .muted { color: #86909c; }
  .ok { color: #00b42a; } .err { color: #f53f3f; }
  .hide { display: none; }
  .hint { color: #86909c; font-size: 13px; margin-top: 8px; }
  input.capedit { font: inherit; width: 92%; padding: 4px 8px; border: 1px solid #e5e6eb; border-radius: 6px; }
  input.capedit:focus { border-color: #3370ff; outline: none; }
  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center; }
  .modal { background: #fff; border-radius: 10px; padding: 18px 20px; width: min(560px, 92vw); }
  .modal textarea { width: 100%; min-height: 200px; font: 13px/1.5 ui-monospace, Menlo, monospace; padding: 10px; border: 1px solid #e5e6eb; border-radius: 8px; box-sizing: border-box; }
  .modal .row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
</style>
</head>
<body>
<header><b>botmux 团队平台</b><span id="who"></span></header>
<main>
  <!-- Login -->
  <section id="login" class="card hide">
    <h2>登录</h2>
    <div id="login-start"><button class="primary" id="btn-start">开始登录</button>
      <p class="hint">登录走飞书身份配对，不需要密码。</p></div>
    <div id="login-code" class="hide">
      <p>在飞书里给任意一个本团队机器人发送：</p>
      <p><span class="code" id="pair-cmd"></span></p>
      <p class="hint" id="pair-status">等待你在飞书里确认…</p>
    </div>
    <div id="login-err" class="hint err"></div>
  </section>

  <!-- App -->
  <section id="app" class="hide">
    <section class="card">
      <h2>团队花名册 <span class="muted" id="team-meta"></span></h2>
      <table><thead><tr><th>机器人</th><th>CLI</th><th>能力标签</th><th>团队角色</th></tr></thead>
        <tbody id="roster"></tbody></table>
    </section>
    <section class="card">
      <h2>接入点（connectors）</h2>
      <table><thead><tr><th>名称</th><th>来源</th><th>模式</th><th>启用</th></tr></thead>
        <tbody id="connectors"></tbody></table>
      <p class="hint" id="connectors-empty hide"></p>
    </section>
    <section class="card">
      <h2>最近触发</h2>
      <table><thead><tr><th>时间</th><th>connector</th><th>结果</th><th>错误</th></tr></thead>
        <tbody id="logs"></tbody></table>
    </section>
  </section>

  <!-- Team-role edit modal -->
  <div id="modal" class="overlay hide"><div class="modal">
    <h2 id="modal-title">团队角色</h2>
    <p class="hint">团队级角色（该机器人跨群的默认人设）。留空并保存即删除。本群 /role 仍可覆盖。</p>
    <textarea id="modal-text" placeholder="# 角色\n用 Markdown 描述这个机器人的职责/风格…"></textarea>
    <div class="row"><button id="modal-cancel">取消</button><button class="primary" id="modal-save">保存</button></div>
  </div></div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function jget(u){ const r = await fetch(u); return { status:r.status, body: await r.json().catch(()=>({})) }; }
async function jpost(u, b){ const r = await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:b?JSON.stringify(b):undefined}); return { status:r.status, body: await r.json().catch(()=>({})) }; }
async function jput(u, b){ const r = await fetch(u,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})}); return { status:r.status, body: await r.json().catch(()=>({})) }; }

let pollTimer = null;

async function showApp(){
  $('login').classList.add('hide'); $('app').classList.remove('hide');
  const me = await jget('/api/team/me');
  $('who').textContent = me.body?.user?.name ? me.body.user.name + ' · 退出' : '退出';
  $('who').style.cursor = 'pointer';
  $('who').onclick = async () => { await jpost('/api/team/logout'); location.reload(); };

  const r = await jget('/api/team/roster');
  const t = r.body || {};
  $('team-meta').textContent = (t.team?.name || '') + ' · ' + (t.team?.memberCount ?? 0) + ' 名成员';
  $('roster').innerHTML = (t.bots||[]).map(b => {
    const app = esc(b.larkAppId || '');
    return '<tr><td>'+esc(b.name)+'</td><td class="muted">'+esc(b.cliId)+'</td>'
      + '<td><input class="capedit" data-app="'+app+'" value="'+esc(b.capability||'')+'" placeholder="能力标签…"></td>'
      + '<td><button class="roleedit" data-app="'+app+'" data-name="'+esc(b.name)+'">'+(b.hasTeamRole?'已设·改':'设置')+'</button></td></tr>';
  }).join('') || '<tr><td colspan=4 class=muted>暂无机器人</td></tr>';
  document.querySelectorAll('.capedit').forEach(inp => {
    inp.onchange = async () => { await jput('/api/team/bots/'+encodeURIComponent(inp.dataset.app)+'/capability', { capability: inp.value }); };
  });
  document.querySelectorAll('.roleedit').forEach(btn => {
    btn.onclick = () => openRoleModal(btn.dataset.app, btn.dataset.name);
  });

  const c = await jget('/api/team/connectors');
  $('connectors').innerHTML = (c.body?.connectors||[]).map(x =>
    '<tr><td>'+esc(x.name)+'</td><td class="muted">'+esc(x.source?.type||x.source||'')+'</td><td>'+esc(x.target?.mode||'')+'</td><td>'+(x.enabled?'<span class=ok>开</span>':'<span class=muted>关</span>')+'</td></tr>'
  ).join('') || '<tr><td colspan=4 class=muted>还没有接入点</td></tr>';

  const l = await jget('/api/team/trigger-logs?limit=20');
  $('logs').innerHTML = (l.body?.logs||[]).map(x =>
    '<tr><td class="muted">'+esc((x.createdAt||'').replace('T',' ').slice(0,19))+'</td><td>'+esc(x.connectorId||'—')+'</td><td class="'+(x.status==='ok'?'ok':'err')+'">'+esc(x.action||x.status)+'</td><td class="err">'+esc(x.errorCode||'')+'</td></tr>'
  ).join('') || '<tr><td colspan=4 class=muted>暂无触发记录</td></tr>';
}

function showLogin(){ $('app').classList.add('hide'); $('login').classList.remove('hide'); }

async function openRoleModal(app, name){
  if (!app) { alert('该机器人无 app id，无法设置团队角色'); return; }
  const r = await jget('/api/team/bots/' + encodeURIComponent(app) + '/role');
  $('modal-title').textContent = '团队角色 · ' + name;
  $('modal-text').value = r.body?.role || '';
  $('modal').dataset.app = app;
  $('modal').classList.remove('hide');
}
$('modal-cancel').onclick = () => $('modal').classList.add('hide');
$('modal-save').onclick = async () => {
  const app = $('modal').dataset.app;
  await jput('/api/team/bots/' + encodeURIComponent(app) + '/role', { role: $('modal-text').value });
  $('modal').classList.add('hide');
  showApp();
};

$('btn-start').onclick = async () => {
  $('login-err').textContent = '';
  const r = await jpost('/api/pairing/start');
  if (!r.body?.code) { $('login-err').textContent = '发起登录失败，请重试。'; return; }
  const pairingId = r.body.pairingId, code = r.body.code;
  $('pair-cmd').textContent = '/pair ' + code;
  $('login-start').classList.add('hide'); $('login-code').classList.remove('hide');
  pollTimer = setInterval(async () => {
    const s = await jget('/api/pairing/status?pairingId=' + encodeURIComponent(pairingId));
    if (s.body?.status === 'claimed') {
      $('pair-status').textContent = '已确认（' + esc(s.body.name||'') + '），正在登录…';
      clearInterval(pollTimer);
      const c = await jpost('/api/pairing/consume', { pairingId });
      if (c.status === 200) showApp();
      else if (c.body?.reason === 'not_a_member') { $('login-code').classList.add('hide'); $('login-start').classList.remove('hide'); $('login-err').textContent = '你不在该团队中，请联系团队成员把你加入。'; }
      else { $('login-code').classList.add('hide'); $('login-start').classList.remove('hide'); $('login-err').textContent = '登录失败（' + esc(c.body?.reason||'') + '），请重试。'; }
    } else if (s.body?.status === 'not_found') {
      clearInterval(pollTimer); $('login-code').classList.add('hide'); $('login-start').classList.remove('hide'); $('login-err').textContent = '配对码已过期，请重新开始。';
    }
  }, 2000);
};

(async () => {
  const me = await jget('/api/team/me');
  if (me.status === 200 && me.body?.ok) showApp(); else showLogin();
})();
</script>
</body>
</html>`;
