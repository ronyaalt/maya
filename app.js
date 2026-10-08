// майя - мини-приложение. данные берутся из бэкенда Apps Script (window.MAYA_API), доступ проверяется
// по подписи телеграма (initData) на бэкенде. ?demo - локальный режим с demo.json (только для вёрстки).
(function () {
  'use strict';

  var tg = window.Telegram && window.Telegram.WebApp;
  var API = window.MAYA_API || '';
  var Q = new URLSearchParams(location.search);
  var DEMO = Q.has('demo');
  var TABS = ['home', 'disk', 'procs', 'security', 'apps', 'history'];

  var app = document.getElementById('app');
  var statusEl = document.getElementById('status');
  var toastEl = document.getElementById('toast');

  var data = null;            // ответ op:get
  var tab = TABS.indexOf(Q.get('tab')) >= 0 ? Q.get('tab') : 'home';
  var range = 'd7';
  var treePath = [];          // путь вглубь treemap: массив узлов
  var appsQuery = '';
  var appsSort = 'size';
  var waiting = null;         // { id, label, since } - команда, результат которой ждём
  var pollTimer = null;
  var toastTimer = null;
  var thresholdsDraft = null;

  // ───────── телеграм ─────────

  function initData() {
    if (tg && tg.initData) return tg.initData;
    // запасной путь, если telegram-web-app.js не загрузился: телеграм кладёт данные в hash
    var h = new URLSearchParams(location.hash.slice(1));
    return h.get('tgWebAppData') || '';
  }

  function haptic(kind) {
    try {
      if (!tg || !tg.HapticFeedback) return;
      if (kind === 'tap') tg.HapticFeedback.selectionChanged();
      else tg.HapticFeedback.notificationOccurred(kind);
    } catch (e) { /* старый клиент */ }
  }

  function confirmBox(text, cb) {
    if (tg && tg.showConfirm && tg.isVersionAtLeast && tg.isVersionAtLeast('6.2')) tg.showConfirm(text, cb);
    else cb(window.confirm(text));
  }

  function setupTelegram() {
    if (!tg) return;
    try {
      tg.ready();
      tg.expand();
      if (tg.isVersionAtLeast('6.1')) { tg.setHeaderColor('#F0558D'); tg.setBackgroundColor('#F0558D'); }
      if (tg.isVersionAtLeast('7.10') && tg.setBottomBarColor) tg.setBottomBarColor('#FFF8F4');
      if (tg.isVersionAtLeast('7.7') && tg.disableVerticalSwipes) tg.disableVerticalSwipes();
      tg.BackButton.onClick(goBack);
    } catch (e) { /* ок, работаем без украшений */ }
  }

  function syncBackButton() {
    if (!tg || !tg.BackButton) return;
    try {
      if (tab !== 'home' || treePath.length > 1) tg.BackButton.show(); else tg.BackButton.hide();
    } catch (e) { }
  }

  function goBack() {
    if (tab === 'disk' && treePath.length > 1) { treePath.pop(); render(); return; }
    setTab('home');
  }

  // ───────── сеть ─────────

  function api(op, extra) {
    if (DEMO) return demoApi(op, extra);
    var body = Object.assign({ op: op, initData: initData() }, extra || {});
    // text/plain - «простой» запрос без CORS-префлайта, иначе Apps Script его не пустит
    return fetch(API, { method: 'POST', body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) throw new Error(j.error || 'ошибка');
        return j;
      });
  }

  var demoData = null;
  function demoApi(op) {
    if (op === 'cmd') return Promise.resolve({ ok: true, id: 'demo' });
    if (demoData) return Promise.resolve(demoData);
    return fetch('demo.json').then(function (r) { return r.json(); }).then(function (j) { demoData = j; return j; });
  }

  function load(silent) {
    if (!DEMO && !API) { renderError(new Error('no api')); return Promise.resolve(); }
    if (!DEMO && !initData()) { renderError(new Error('no initData')); return Promise.resolve(); }
    return api('get').then(function (j) {
      data = j;
      if (waiting && j.lastCmd && j.lastCmd.id === waiting.id) {
        toast(j.lastCmd.text || 'готово', j.lastCmd.status === 'ok' ? 'ok' : 'err', 7000);
        haptic(j.lastCmd.status === 'ok' ? 'success' : 'error');
        waiting = null;
        schedulePoll();
      }
      render();
    }).catch(function (e) {
      if (silent && data) return;
      renderError(e);
    });
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    var ms = waiting ? 5000 : 30000;
    if (waiting && Date.now() - waiting.since > 180000) {
      toast('ноут не ответил за 3 минуты - наверное, спит. команда выполнится, когда проснётся', 'err', 7000);
      waiting = null;
      ms = 30000;
    }
    pollTimer = setTimeout(function () {
      if (document.visibilityState === 'visible') load(true).then(schedulePoll); else schedulePoll();
    }, ms);
  }

  function sendCmd(type, args, label) {
    api('cmd', { cmd: { type: type, args: args || {} } }).then(function (r) {
      haptic('success');
      if (DEMO) { toast('демо: команда «' + label + '» ушла бы на ноут', 'ok'); return; }
      waiting = { id: r.id, label: label, since: Date.now() };
      toast('майя приняла: ' + label + '. ноут подхватит секунд за 30, ня', null, 6000);
      schedulePoll();
    }).catch(function (e) {
      haptic('error');
      toast('не вышло: ' + e.message, 'err', 6000);
    });
  }

  // ───────── утилиты ─────────

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function num(n, d) {
    return Number(n || 0).toLocaleString('ru-RU', { maximumFractionDigits: d == null ? 1 : d });
  }

  function bytes(b) {
    b = Number(b) || 0;
    if (b >= 1073741824) return num(b / 1073741824, b >= 10737418240 ? 0 : 1) + ' гб';
    if (b >= 1048576) return num(b / 1048576, 0) + ' мб';
    if (b >= 1024) return num(b / 1024, 0) + ' кб';
    return b + ' б';
  }

  function ago(iso) {
    if (!iso) return 'никогда';
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'только что';
    if (s < 3600) return Math.round(s / 60) + ' мин назад';
    if (s < 86400) return Math.round(s / 3600) + ' ч назад';
    return Math.round(s / 86400) + ' дн назад';
  }

  function hhmm(iso) {
    var d = new Date(iso);
    return d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).toLowerCase();
  }

  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    var w = m10 === 1 && m100 !== 11 ? one : (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many);
    return n + ' ' + w;
  }

  function pct(v, max) { return Math.max(0, Math.min(100, (Number(v) || 0) / (max || 100) * 100)); }

  function bar(p, color, thin) {
    return '<div class="bar' + (thin ? ' thin' : '') + '"><i style="width:' + p.toFixed(1) + '%;--c:' + (color || 'var(--rose)') + '"></i></div>';
  }

  function stk(text, bg, fg, r, cls) {
    return '<span class="stk ' + (cls || '') + '" style="--bg:' + bg + ';--fg:' + fg + ';--r:' + (r || -6) + 'deg">' + esc(text) + '</span>';
  }

  function toast(text, kind, ms) {
    toastEl.textContent = text;
    toastEl.className = 'toast' + (kind ? ' ' + kind : '');
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, ms || 4000);
  }

  function snap() { return data && data.snapshot; }
  function heavy() { var s = snap(); return s && s.heavy; }

  function isAsleep() {
    var seen = data && data.laptopSeen ? new Date(data.laptopSeen).getTime() : 0;
    var s = snap();
    var ts = s && s.ts ? new Date(s.ts).getTime() : 0;
    return Date.now() - Math.max(seen, ts) > 10 * 60 * 1000;
  }

  function mood(score) {
    if (isAsleep()) return { t: 'муся zzz', bg: 'var(--lilac)', fg: 'var(--cocoa)' };
    if (score >= 90) return { t: 'вайб', bg: 'var(--yellow)', fg: 'var(--berry)' };
    if (score >= 75) return { t: 'мур', bg: 'var(--rose)', fg: 'var(--berry)' };
    if (score >= 60) return { t: ':3', bg: 'var(--peach)', fg: 'var(--cocoa)' };
    if (score >= 40) return { t: '· ω ·', bg: 'var(--cream)', fg: 'var(--cocoa)' };
    return { t: '>-<', bg: 'var(--berry)', fg: 'var(--milk)' };
  }

  function scoreColor(score) {
    if (score >= 85) return 'var(--ok)';
    if (score >= 65) return 'var(--yellow)';
    if (score >= 40) return 'var(--peach)';
    return 'var(--berry)';
  }

  var PALETTE = ['var(--rose)', 'var(--yellow)', 'var(--peach)', 'var(--mint)', 'var(--sky)', 'var(--lilac)', 'var(--cream)'];

  // ───────── ачивки ─────────

  var ACH = [
    { st: 'чистюля', bg: 'var(--mint)', d: 'мусора меньше 1 гб', t: function (s) { return s.junkTotal < 1073741824; } },
    { st: 'простор', bg: 'var(--sky)', d: 'на диске свободно 30%+', t: function (s) { return s.minFreePct >= 30; } },
    { st: 'вайб', bg: 'var(--yellow)', d: 'здоровье ноута 90+', t: function (s) { return s.health && s.health.score >= 90; } },
    { st: 'щит', bg: 'var(--lilac)', d: 'defender и файрвол включены', t: function (s) { return s.security && s.security.defender && s.security.firewallAny; } },
    { st: 'без палева', bg: 'var(--peach)', d: 'ни одного подозрительного процесса', t: function (s) { return !(s.suspicious || []).length; } },
    { st: 'свежачок', bg: 'var(--rose)', d: 'перезагружалась меньше недели назад', t: function (s) { return s.uptime && s.uptime.days < 7; } },
    { st: '+1 гб', bg: 'var(--yellow)', d: 'майя спасла 1 гб', t: function (s, d) { return d.totalFreed >= 1073741824; } },
    { st: '+10 гб', bg: 'var(--peach)', d: 'майя спасла 10 гб', t: function (s, d) { return d.totalFreed >= 10737418240; } },
    { st: '+50 гб', bg: 'var(--rose)', d: 'майя спасла 50 гб', t: function (s, d) { return d.totalFreed >= 53687091200; } },
    { st: 'неделя чисто', bg: 'var(--mint)', d: '7 дней мусора меньше 5 гб', t: function (s, d) {
      var h = (d.history && d.history.d7) || [];
      if (h.length < 2 || h[h.length - 1][0] - h[0][0] < 6.5 * 86400000) return false;
      return h.every(function (p) { return p[6] < 5368709120; });
    } }
  ];

  function achievements() {
    var s = snap();
    if (!s) return [];
    return ACH.map(function (a) {
      var got = false;
      try { got = !!a.t(s, data); } catch (e) { got = false; }
      return { st: a.st, bg: a.bg, d: a.d, got: got };
    });
  }

  function achCard(a, i) {
    return '<div class="a' + (a.got ? ' got' : '') + '">' + stk(a.st, a.bg, 'var(--cocoa)', i % 2 ? 4 : -5) + '<p>' + esc(a.d) + '</p></div>';
  }

  // ачивки самой майи (kirza-kit): приходят в снимке как s.maya
  function mayaAchCard() {
    var m = snap().maya;
    if (!m || !m.achievements) return '';
    var list = m.achievements, got = list.filter(function (a) { return a.open; }).length, c = m.counters || {};
    var counters = [['ходов', c.turns], ['с матом', c.mats], ['халяль', c.halal], ['переобулась', c.shoes], ['падений', c.fails], ['кай энджел', c.kai]]
      .map(function (x) { return '<span class="chip">' + esc(x[0]) + ' ' + num(x[1] || 0, 0) + '</span>'; }).join('');
    return '<section class="card tilt-l"><h2>🧚 ачивки майи <small>' + got + ' из ' + list.length + '</small></h2>' +
      '<div class="chips" style="margin-bottom:12px">' + counters + '</div>' +
      '<div class="ach maya">' + list.map(function (a, i) {
        var prog = a.open ? '' : '<p class="muted">' + num(Math.min(a.have, a.need), 0) + ' / ' + num(a.need, 0) + '</p>';
        return '<div class="a' + (a.open ? ' got' : '') + '">' + stk(a.emoji + ' ' + a.title, PALETTE[i % PALETTE.length], 'var(--cocoa)', i % 2 ? 4 : -5) +
          '<p>' + esc(a.text) + '</p>' + prog + '</div>';
      }).join('') + '</div></section>';
  }

  // ───────── рендер ─────────

  function setTab(t) {
    if (t === tab) return;
    tab = t;
    if (t !== 'disk') treePath = [];
    haptic('tap');
    render();
    window.scrollTo(0, 0);
  }

  function renderStatus() {
    if (!data) { statusEl.innerHTML = ''; return; }
    var s = snap();
    if (isAsleep()) {
      var last = data.laptopSeen || (s && s.ts);
      statusEl.className = 'status sleep';
      statusEl.innerHTML = '<span class="dot"></span>ноут спит · ' + esc(ago(last));
    } else {
      statusEl.className = 'status';
      statusEl.innerHTML = '<span class="dot"></span>на связи · ' + esc(s ? ago(s.ts) : '');
    }
  }

  function render() {
    document.querySelectorAll('#tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === tab); });
    renderStatus();
    syncBackButton();
    if (!data) return;
    if (!snap() || !snap().health) {
      app.innerHTML = '<div class="empty">' + stk('муся', 'var(--lilac)', 'var(--cocoa)', -6, 'big') +
        '<p>ноут ещё не присылал данные</p><div class="card">задача снимков отправляет их раз в 5 минут. если ноут включён - загляни чуть позже, ня</div></div>';
      return;
    }
    var html = ({ home: viewHome, disk: viewDisk, procs: viewProcs, security: viewSecurity, apps: viewApps, history: viewHistory }[tab])();
    app.innerHTML = html;
    bindView();
  }

  function renderError(e) {
    var msg = String(e && e.message || e);
    var text;
    if (msg === 'not you') text = 'это приложение только для роньки, ня';
    else if (msg === 'no initData') text = 'открой меня из телеги, через кнопку «майя» у бота';
    else if (msg === 'no api') text = 'сервер ещё не подключён: впиши адрес apps script в config.js';
    else if (msg.indexOf('initData') >= 0 || msg === 'bad signature' || msg === 'no hash') text = 'телега не подтвердила, что это ты. закрой и открой приложение заново';
    else text = 'не достучалась до сервера: ' + msg;
    app.innerHTML = '<div class="empty">' + stk('>-<', 'var(--berry)', 'var(--milk)', 5, 'big') +
      '<p>' + esc(text) + '</p><div class="btns" style="justify-content:center"><button class="btn soft" data-act="reload">попробовать ещё</button></div></div>';
    bindView();
  }

  // --- дом ---

  function viewHome() {
    var s = snap();
    var score = s.health.score;
    var m = mood(score);
    var R = 54, C = 2 * Math.PI * R;
    var donut =
      '<div class="donut"><svg viewBox="0 0 132 132">' +
      '<circle cx="66" cy="66" r="' + R + '" fill="var(--cream)" stroke="var(--cocoa)" stroke-width="3"/>' +
      '<circle cx="66" cy="66" r="' + R + '" fill="none" stroke="' + scoreColor(score) + '" stroke-width="16" stroke-linecap="round" ' +
      'stroke-dasharray="' + (C * score / 100).toFixed(1) + ' ' + C.toFixed(1) + '"/>' +
      '<circle cx="66" cy="66" r="' + (R - 9) + '" fill="none" stroke="var(--cocoa)" stroke-width="2.5"/>' +
      '<circle cx="66" cy="66" r="' + (R + 9) + '" fill="none" stroke="var(--cocoa)" stroke-width="2.5"/>' +
      '</svg><div class="num"><b>' + score + '</b><span>из 100</span></div>' +
      '<span class="mood">' + stk(m.t, m.bg, m.fg, 8) + '</span></div>';

    var disk = (s.disks || []).reduce(function (a, d) { return !a || d.freePct < a.freePct ? d : a; }, null);
    var stats =
      statCard('диск', num(s.minFreePct, 0) + '<small>% своб.</small>', bar(100 - s.minFreePct, s.minFreePct < 15 ? 'var(--berry)' : 'var(--rose)', true),
        disk ? bytes(disk.free) + ' из ' + bytes(disk.total) : '') +
      statCard('память', num(s.ram.pct, 0) + '<small>%</small>', bar(s.ram.pct, 'var(--peach)', true), bytes(s.ram.used) + ' из ' + bytes(s.ram.total)) +
      statCard('проц', num(s.cpu, 0) + '<small>%</small>', bar(s.cpu, 'var(--yellow)', true), 'загрузка сейчас') +
      (s.battery
        ? statCard('батарея', s.battery.pct + '<small>%</small>', bar(s.battery.pct, 'var(--mint)', true), s.battery.charging ? 'на зарядке' : 'от батареи')
        : statCard('аптайм', s.uptime ? uptimeText(s.uptime.days) : '?', '', s.uptime ? 'с ' + hhmm(s.uptime.boot) : ''));

    var junk = (s.junk || []).map(function (j) {
      return '<div class="row jr"><span class="n">' + esc(j.label) + '</span><span class="s">' + bytes(j.size) + '</span>' +
        '<button class="btn sm pink" data-clean="' + esc(j.key) + '" data-label="' + esc(j.label) + '"' + (j.size > 0 ? '' : ' disabled') + '>убрать</button></div>';
    }).join('');

    var ach = achievements();
    var got = ach.filter(function (a) { return a.got; });

    var t = thresholdsDraft || s.thresholds;
    return '' +
      '<section class="card tilt-l"><div class="hero">' + donut +
        '<div><div class="bubble">' + esc(s.health.tldr) + '</div><div class="line">' + esc(s.health.line) + '</div></div>' +
      '</div></section>' +
      '<div class="stats">' + stats + '</div>' +

      '<section class="card tilt-r"><h2>🧹 мусор <small>всего ' + bytes(s.junkTotal) + '</small></h2>' +
        '<div class="list">' + junk + '</div>' +
        '<div class="btns"><button class="btn wide" data-clean="all" data-label="всё сразу">почистить всё сразу</button></div>' +
        '<p class="muted">c:\\windows\\temp и кэш обновлений без прав админа могут не почиститься - это норм</p>' +
      '</section>' +

      '<section class="card"><h2>✨ ачивки <small>' + got.length + ' из ' + ach.length + '</small></h2>' +
        (got.length
          ? '<div class="ach-strip">' + got.map(function (a, i) { return stk(a.st, a.bg, 'var(--cocoa)', i % 2 ? 5 : -5); }).join('') + '</div>'
          : '<p class="muted">пока ни одной. почисти что-нибудь, ня</p>') +
        '<div class="btns"><button class="btn sm soft" data-goto="history">все ачивки</button></div>' +
      '</section>' +

      '<section class="card tilt-l"><h2>🔄 обновить</h2>' +
        '<p class="sub">быстрые цифры обновляются раз в 5 минут, папки/дубли/программы - раз в 6 часов, полный пересчёт идёт минут 10' +
        (heavy() ? ' (последний раз ' + esc(ago(heavy().ts)) + ')' : '') + '</p>' +
        '<div class="btns"><button class="btn soft" data-refresh="0">обновить сейчас</button>' +
        '<button class="btn" data-refresh="1">полный пересчёт</button></div>' +
      '</section>' +

      '<section class="card"><h2>🚨 пороги тревоги</h2>' +
        slider('disk', 'диск: тревога, если свободно меньше', t.diskFreePct, 1, 50, '%') +
        slider('junk', 'мусор: напоминать, если больше', t.junkGB, 1, 100, ' гб') +
        '<div class="btns"><button class="btn" data-act="save-thr">сохранить</button></div>' +
      '</section>';
  }

  function statCard(k, v, barHtml, sub) {
    return '<div class="stat"><div class="k">' + k + '</div><div class="v">' + v + '</div>' + (barHtml || '') +
      (sub ? '<div class="sub" style="margin-top:5px">' + esc(sub) + '</div>' : '') + '</div>';
  }

  function uptimeText(days) {
    if (days < 1) return Math.round(days * 24) + '<small> ч</small>';
    return num(days, 0) + '<small> дн</small>';
  }

  function slider(id, label, val, min, max, unit) {
    return '<div class="slider"><label><span>' + esc(label) + '</span><span id="v-' + id + '">' + val + unit + '</span></label>' +
      '<input type="range" min="' + min + '" max="' + max + '" value="' + val + '" data-slider="' + id + '" data-unit="' + esc(unit) + '"></div>';
  }

  // --- диск ---

  function viewDisk() {
    var s = snap(), h = heavy();
    var drives = (s.disks || []).map(function (d) {
      return '<div class="row"><span class="n">' + esc(d.name) + ': свободно ' + bytes(d.free) + '</span><span class="s">' + num(d.freePct, 0) + '%</span>' +
        bar(100 - d.freePct, d.freePct < 15 ? 'var(--berry)' : 'var(--rose)') + '<div class="meta">занято ' + bytes(d.total - d.free) + ' из ' + bytes(d.total) + '</div></div>';
    }).join('');

    var out = '<section class="card tilt-l"><h2>💽 диски</h2><div class="list">' + drives + '</div>';
    if (h && h.physical && h.physical.length) {
      out += '<hr class="sep"><div class="chips">' + h.physical.map(function (p) {
        var ok = /healthy/i.test(p.health);
        return '<span class="chip ' + (ok ? 'on' : 'off') + '">' + esc(p.name) + ' · ' + (ok ? 'здоров' : esc(p.health)) + '</span>';
      }).join('') + '</div>';
    }
    out += '</section>';

    if (!h) return out + heavyMissing();

    if (!treePath.length) treePath = [h.folders];
    var node = treePath[treePath.length - 1];
    var crumbs = treePath.map(function (n, i) {
      return i === treePath.length - 1 ? '<b>' + esc(n.name) + '</b>' : '<button data-crumb="' + i + '">' + esc(n.name) + '</button><span>/</span>';
    }).join('');
    out += '<section class="card"><h2>📂 что ест место <small>тапни по большому квадрату</small></h2>' +
      '<div class="crumbs">' + crumbs + '</div><div class="tm" id="tm"></div>' +
      '<p class="muted">' + esc(node.name.replace(/:$/, '')) + ' весит ' + bytes(node.size) + ' · считала ' + esc(ago(h.ts)) + '</p></section>';

    var dl = h.downloads || { top: [] };
    out += '<section class="card tilt-r"><h2>📥 старьё в downloads <small>старше ' + dl.days + ' дн</small></h2>' +
      '<p class="sub">' + plural(dl.count, 'файл', 'файла', 'файлов') + ', ' + bytes(dl.size) + '. сама не удаляю - разбирай руками</p>' +
      '<div class="list" style="margin-top:9px">' + (dl.top || []).map(function (f) {
        return '<div class="row"><span class="n">' + esc(f.name) + '</span><span class="s">' + bytes(f.size) + '</span><div class="meta">' + esc(hhmm(f.date)) + '</div></div>';
      }).join('') + '</div></section>';

    var dp = h.dupes || { groups: [] };
    out += '<section class="card"><h2>📑 дубли <small>впустую ' + bytes(dp.wasted) + '</small></h2>' +
      (dp.groups.length ? '<div class="list">' + dp.groups.map(function (g) {
        return '<div class="row"><span class="n">' + g.count + '× ' + bytes(g.size) + '</span><span class="s">−' + bytes(g.wasted) + '</span>' +
          '<div class="meta">' + g.paths.map(esc).join('<br>') + '</div></div>';
      }).join('') + '</div>' : '<p class="muted">дублей не нашла, ня</p>') + '</section>';
    return out;
  }

  function heavyMissing() {
    return '<section class="card"><h2>📂 подробности</h2><p class="sub">папки, дубли и программы ещё не считались. ' +
      'нажми «полный пересчёт» - это пара минут</p><div class="btns"><button class="btn" data-refresh="1">полный пересчёт</button></div></section>';
  }

  // squarified treemap: раскладываем прямоугольники так, чтобы они были поближе к квадратам
  function squarify(items, x, y, w, h) {
    var total = items.reduce(function (a, i) { return a + i.size; }, 0);
    if (!total) return [];
    var nodes = items.filter(function (i) { return i.size > 0; })
      .sort(function (a, b) { return b.size - a.size; })
      .map(function (i) { return { item: i, a: i.size / total * w * h }; });
    var out = [], row = [];
    function worst(r, side) {
      var s = 0, mx = 0, mn = Infinity;
      r.forEach(function (n) { s += n.a; mx = Math.max(mx, n.a); mn = Math.min(mn, n.a); });
      return Math.max(side * side * mx / (s * s), (s * s) / (side * side * mn));
    }
    function lay(r) {
      var s = r.reduce(function (a, n) { return a + n.a; }, 0);
      if (w >= h) {
        var cw = s / h, cy = y;
        r.forEach(function (n) { var ch = n.a / cw; out.push({ item: n.item, x: x, y: cy, w: cw, h: ch }); cy += ch; });
        x += cw; w -= cw;
      } else {
        var rh = s / w, cx = x;
        r.forEach(function (n) { var rw = n.a / rh; out.push({ item: n.item, x: cx, y: y, w: rw, h: rh }); cx += rw; });
        y += rh; h -= rh;
      }
    }
    nodes.forEach(function (n) {
      var side = Math.min(w, h);
      if (!row.length || worst(row.concat([n]), side) <= worst(row, side)) row.push(n);
      else { lay(row); row = [n]; }
    });
    if (row.length) lay(row);
    return out;
  }

  function drawTreemap() {
    var el = document.getElementById('tm');
    if (!el) return;
    var node = treePath[treePath.length - 1];
    var W = el.clientWidth, H = el.clientHeight;
    var rects = squarify(node.children || [], 0, 0, W, H);
    el.innerHTML = rects.map(function (r, i) {
      var it = r.item, drill = it.children && it.children.length;
      var big = r.w > 58 && r.h > 34;
      return '<div class="t' + (drill ? ' drill' : '') + '" data-tile="' + i + '" style="left:' + r.x.toFixed(1) + 'px;top:' + r.y.toFixed(1) +
        'px;width:' + r.w.toFixed(1) + 'px;height:' + r.h.toFixed(1) + 'px;--bg:' + PALETTE[i % PALETTE.length] + '">' +
        (big ? '<b>' + esc(it.name) + '</b><span>' + bytes(it.size) + '</span>' : '') + '</div>';
    }).join('');
    el.querySelectorAll('.t').forEach(function (t) {
      t.addEventListener('click', function () {
        var it = rects[Number(t.dataset.tile)].item;
        if (it.children && it.children.length) { treePath.push(it); haptic('tap'); render(); }
        else toast(it.name + ': ' + bytes(it.size));
      });
    });
  }

  // --- процессы ---

  function viewProcs() {
    var s = snap(), p = s.procs || { cpu: [], mem: [] };
    var maxCpu = Math.max.apply(null, [1].concat(p.cpu.map(function (x) { return x.cpu; })));
    var maxMem = Math.max.apply(null, [1].concat(p.mem.map(function (x) { return x.mem; })));
    var susp = s.suspicious || [];
    return '' +
      '<section class="card ' + (susp.length ? '' : 'tilt-l') + '"><h2>🕵️ подозрительное</h2>' +
        (susp.length
          ? '<div class="list">' + susp.map(function (x) {
              return '<div class="row"><span class="n">' + esc(x.name) + ' <span class="muted">pid ' + x.pid + '</span></span><span class="s">' + esc(x.reason) + '</span>' +
                '<div class="meta">' + esc(x.path) + '</div></div>';
            }).join('') + '</div>'
          : '<p>' + stk('чисто', 'var(--mint)', 'var(--cocoa)', -4, 'sm') + ' майнеров и процессов из temp нет</p>') +
      '</section>' +
      '<section class="card tilt-r"><h2>🔥 жрут проц <small>сейчас, сумма по одноимённым</small></h2><div class="list">' +
        p.cpu.map(function (x) {
          return '<div class="row"><span class="n">' + esc(x.name) + (x.count > 1 ? ' <span class="muted">×' + x.count + '</span>' : '') + '</span>' +
            '<span class="s">' + num(x.cpu) + '%</span>' + bar(pct(x.cpu, maxCpu), 'var(--yellow)', true) + '</div>';
        }).join('') + '</div></section>' +
      '<section class="card"><h2>🧠 жрут память</h2><div class="list">' +
        p.mem.map(function (x) {
          return '<div class="row"><span class="n">' + esc(x.name) + (x.count > 1 ? ' <span class="muted">×' + x.count + '</span>' : '') + '</span>' +
            '<span class="s">' + bytes(x.mem) + '</span>' + bar(pct(x.mem, maxMem), 'var(--peach)', true) + '</div>';
        }).join('') + '</div><p class="muted">всего занято ' + bytes(s.ram.used) + ' из ' + bytes(s.ram.total) + '</p></section>';
  }

  // --- защита ---

  function viewSecurity() {
    var s = snap(), h = heavy(), sec = s.security || {};
    var sigAge = sec.sigUpdated ? ago(sec.sigUpdated) : 'неизвестно';
    var out = '<section class="card tilt-l"><h2>🛡 защита</h2><div class="chips">' +
      '<span class="chip ' + (sec.defender ? 'on' : 'off') + '">defender ' + (sec.defender ? 'вкл' : 'выкл') + '</span>' +
      (sec.firewall || []).map(function (f) { return '<span class="chip ' + (f.enabled ? 'on' : 'off') + '">файрвол ' + esc(f.name.toLowerCase()) + '</span>'; }).join('') +
      '</div><p class="sub" style="margin-top:9px">антивирусные базы обновлены ' + esc(sigAge) + '</p></section>';

    if (!h) return out + heavyMissing();

    var u = h.updates || {};
    out += '<section class="card tilt-r"><h2>🔄 обновления windows <small>' + (u.ok ? u.count + ' ждут' : 'не смогла проверить') + '</small></h2>' +
      ((u.titles || []).length ? '<div class="list">' + u.titles.map(function (t) { return '<div class="sub">· ' + esc(t) + '</div>'; }).join('') + '</div>'
        : '<p class="muted">' + (u.ok ? 'всё стоит, халяль' : '') + '</p>') + '</section>';

    var ports = h.ports || [];
    var open = ports.filter(function (p) { return !p.local && !sysPort(p); });
    var rank = function (p) { return p.local ? 2 : sysPort(p) ? 1 : 0; };
    var nLocal = ports.filter(function (p) { return p.local; }).length;
    out += '<section class="card"><h2>🌐 кто слушает порты <small>' + open.length + ' наружу, ' + (ports.length - open.length - nLocal) + ' windows, ' + nLocal + ' локально</small></h2>' +
      '<p class="sub" style="margin-bottom:9px">«наружу» - программа ждёт подключений из сети. если имя незнакомое - погугли его</p>' +
      '<div class="list">' + ports.slice().sort(function (a, b) { return (rank(a) - rank(b)) || (a.port - b.port); }).map(function (p) {
        return '<div class="row"><span class="n">' + esc(p.proc || '?') + ' <span class="muted">pid ' + p.pid + '</span></span>' +
          '<span class="s">' + p.port + ' ' + (p.local ? stk('локально', 'var(--cream)', 'var(--cocoa)', 0, 'sm') : sysPort(p) ? stk('windows', 'var(--sky)', 'var(--cocoa)', 0, 'sm') : stk('наружу', 'var(--yellow)', 'var(--cocoa)', 0, 'sm')) + '</span></div>';
      }).join('') + '</div></section>';

    var c = h.cloud || {};
    out += '<section class="card tilt-l"><h2>☁️ яндекс.диск</h2><div class="chips">' +
      '<span class="chip ' + (c.running ? 'on' : 'warn') + '">' + (c.running ? 'запущен' : 'не запущен') + '</span>' +
      (c.exists ? '<span class="chip">папка синка ' + bytes(c.size) + '</span>' : '<span class="chip warn">папку синка не нашла</span>') +
      '</div></section>';
    return out;
  }

  // стандартные службы windows, которые всегда слушают порты - не пугаем ими
  var SYS_PROCS = ['system', 'svchost', 'lsass', 'wininit', 'services', 'spoolsv'];
  function sysPort(p) { return SYS_PROCS.indexOf(String(p.proc || '').toLowerCase()) >= 0; }

  // --- программы ---

  function viewApps() {
    var h = heavy();
    if (!h) return heavyMissing();
    var q = appsQuery.trim().toLowerCase();
    var list = (h.apps || []).filter(function (a) {
      return !q || a.name.toLowerCase().indexOf(q) >= 0 || (a.publisher || '').toLowerCase().indexOf(q) >= 0;
    });
    list = list.slice().sort(appsSort === 'size'
      ? function (a, b) { return b.size - a.size; }
      : function (a, b) { return a.name.localeCompare(b.name, 'ru'); });
    var max = Math.max.apply(null, [1].concat((h.apps || []).map(function (a) { return a.size; })));
    var total = (h.apps || []).reduce(function (s, a) { return s + a.size; }, 0);

    var diff = h.appsDiff;
    var diffHtml = '';
    if (diff) {
      var ins = diff.installed || [], rem = diff.removed || [];
      diffHtml = '<section class="card tilt-r"><h2>🆚 за неделю <small>с прошлого понедельничного отчёта</small></h2>' +
        (!ins.length && !rem.length ? '<p class="muted">ничего не ставила и не сносила. скучно живёшь, ронька</p>' :
          ins.map(function (n) { return '<div class="sub">' + stk('+', 'var(--mint)', 'var(--cocoa)', 0, 'sm') + ' ' + esc(n) + '</div>'; }).join('') +
          rem.map(function (n) { return '<div class="sub">' + stk('−', 'var(--rose)', 'var(--cocoa)', 0, 'sm') + ' ' + esc(n) + '</div>'; }).join('')) +
        '</section>';
    }

    return diffHtml +
      '<section class="card"><h2>📦 программы <small>' + (h.apps || []).length + ' шт, ~' + bytes(total) + '</small></h2>' +
      '<div class="toolbar"><input class="search" id="apps-q" placeholder="поиск" value="' + esc(appsQuery) + '">' +
      '<div class="seg"><button data-sort="size" class="' + (appsSort === 'size' ? 'on' : '') + '">вес</button>' +
      '<button data-sort="name" class="' + (appsSort === 'name' ? 'on' : '') + '">аб</button></div></div>' +
      '<div class="list" id="apps-list">' + list.map(function (a) {
        return '<div class="row"><span class="n">' + esc(a.name) + '</span><span class="s">' + (a.size ? bytes(a.size) : '?') + '</span>' +
          bar(pct(a.size, max), 'var(--sky)', true) +
          '<div class="meta">' + esc([a.version, a.publisher].filter(Boolean).join(' · ')) + '</div></div>';
      }).join('') + (list.length ? '' : '<p class="muted">ничего не нашла</p>') + '</div>' +
      '<p class="muted">размер - то, что программа сама о себе сообщает в windows, у части его нет</p></section>';
  }

  // --- история ---

  function viewHistory() {
    var h = (data.history && data.history[range]) || [];
    var ach = achievements();
    var seg = '<div class="seg"><button data-range="d7" class="' + (range === 'd7' ? 'on' : '') + '">7 дней</button>' +
      '<button data-range="d30" class="' + (range === 'd30' ? 'on' : '') + '">30 дней</button></div>';

    var charts = h.length < 2
      ? '<section class="card"><h2>📈 графики</h2><p class="sub">история копится раз в 5 минут, пока ноут включён. загляни через пару часов, ня</p></section>'
      : chartCard('💚 здоровье', h, [{ i: 1, c: 'var(--ok)', name: 'балл' }], 0, 100, function (v) { return num(v, 0); }, 'tilt-l') +
        chartCard('💽 свободно на c:', h, [{ i: 3, c: 'var(--berry)', name: 'свободно' }], null, null, bytes, 'tilt-r') +
        chartCard('🔥 нагрузка', h, [{ i: 4, c: 'var(--peach)', name: 'проц %' }, { i: 5, c: 'var(--sky)', name: 'память %' }], 0, 100, function (v) { return num(v, 0) + '%'; }) +
        chartCard('🧹 мусор', h, [{ i: 6, c: 'var(--rose)', name: 'мусор' }], 0, null, bytes, 'tilt-l');

    var cl = data.cleanups || [];
    return '<div class="toolbar" style="justify-content:center;margin-top:14px">' + seg + '</div>' + charts +
      '<section class="card tilt-r"><h2>🧹 журнал чисток</h2>' +
        '<div class="big-num">' + bytes(data.totalFreed || 0) + '</div><p class="sub">майя спасла тебе за всё время</p>' +
        (cl.length ? '<div class="list" style="margin-top:12px">' + cl.map(function (c) {
          return '<div class="row"><span class="n">' + esc(hhmm(c.ts)) + ' · ' + esc(c.source || '') + '</span><span class="s">' + bytes(c.freed) + '</span>' +
            '<div class="meta">' + esc(c.labels) + '</div></div>';
        }).join('') + '</div>' : '<p class="muted">ещё ни одной чистки</p>') +
      '</section>' +
      '<section class="card"><h2>✨ ачивки <small>' + ach.filter(function (a) { return a.got; }).length + ' из ' + ach.length + '</small></h2>' +
        '<div class="ach">' + ach.map(achCard).join('') + '</div></section>' +
      mayaAchCard();
  }

  function chartCard(title, pts, series, minV, maxV, fmt, cls) {
    var W = 320, H = 130, L = 4, R = 4, T = 10, B = 18;
    var xs = pts.map(function (p) { return p[0]; });
    var x0 = xs[0], x1 = xs[xs.length - 1];
    var vals = [];
    series.forEach(function (s) { pts.forEach(function (p) { vals.push(Number(p[s.i]) || 0); }); });
    var lo = minV != null ? minV : Math.min.apply(null, vals);
    var hi = maxV != null ? maxV : Math.max.apply(null, vals);
    if (hi === lo) { hi = lo + 1; }
    if (minV == null) { var pad = (hi - lo) * 0.15; lo = Math.max(0, lo - pad); hi = hi + pad; }
    function X(t) { return L + (t - x0) / Math.max(1, x1 - x0) * (W - L - R); }
    function Y(v) { return T + (1 - (v - lo) / (hi - lo)) * (H - T - B); }

    var grid = [0.25, 0.5, 0.75].map(function (f) {
      var y = T + f * (H - T - B);
      return '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '" stroke="var(--cocoa)" stroke-opacity=".12" stroke-dasharray="3 4"/>';
    }).join('');
    var paths = series.map(function (s, si) {
      var d = pts.map(function (p, k) { return (k ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(Number(p[s.i]) || 0).toFixed(1); }).join(' ');
      var area = si === 0 && series.length === 1
        ? '<path d="' + d + ' L' + X(x1).toFixed(1) + ' ' + (H - B) + ' L' + X(x0).toFixed(1) + ' ' + (H - B) + ' Z" fill="' + s.c + '" fill-opacity=".28"/>'
        : '';
      return area + '<path d="' + d + '" fill="none" stroke="' + s.c + '" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>';
    }).join('');
    var last = pts[pts.length - 1];
    var lastLabel = series.map(function (s) { return fmt(Number(last[s.i]) || 0); }).join(' / ');
    var day = function (t) { return new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).toLowerCase(); };

    return '<section class="card ' + (cls || '') + '"><h2>' + title + ' <small>сейчас ' + esc(lastLabel) + '</small></h2>' +
      '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '">' + grid + paths +
      '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + (H - B) + '" y2="' + (H - B) + '" stroke="var(--cocoa)" stroke-width="2"/>' +
      '<text class="ax" x="' + L + '" y="' + (H - 4) + '">' + esc(day(x0)) + '</text>' +
      '<text class="ax" x="' + (W - R) + '" y="' + (H - 4) + '" text-anchor="end">' + esc(day(x1)) + '</text>' +
      '<text class="ax" x="' + (W - R) + '" y="' + (T + 2) + '" text-anchor="end">' + esc(fmt(hi)) + '</text>' +
      '</svg>' +
      (series.length > 1 ? '<div class="legend">' + series.map(function (s) { return '<span><i style="--c:' + s.c + '"></i>' + esc(s.name) + '</span>'; }).join('') + '</div>' : '') +
      '</section>';
  }

  // ───────── события ─────────

  function bindView() {
    app.querySelectorAll('[data-clean]').forEach(function (b) {
      b.addEventListener('click', function () {
        var cat = b.dataset.clean, label = b.dataset.label;
        confirmBox('почистить: ' + label + '?', function (ok) { if (ok) sendCmd('cleanup', { category: cat }, 'чистка (' + label + ')'); });
      });
    });
    app.querySelectorAll('[data-refresh]').forEach(function (b) {
      b.addEventListener('click', function () {
        var full = b.dataset.refresh === '1';
        sendCmd('refresh', { full: full }, full ? 'полный пересчёт' : 'обновление');
      });
    });
    app.querySelectorAll('[data-goto]').forEach(function (b) { b.addEventListener('click', function () { setTab(b.dataset.goto); }); });
    app.querySelectorAll('[data-crumb]').forEach(function (b) {
      b.addEventListener('click', function () { treePath = treePath.slice(0, Number(b.dataset.crumb) + 1); haptic('tap'); render(); });
    });
    app.querySelectorAll('[data-range]').forEach(function (b) {
      b.addEventListener('click', function () { range = b.dataset.range; haptic('tap'); render(); });
    });
    app.querySelectorAll('[data-sort]').forEach(function (b) {
      b.addEventListener('click', function () { appsSort = b.dataset.sort; haptic('tap'); render(); });
    });
    app.querySelectorAll('[data-slider]').forEach(function (inp) {
      inp.addEventListener('input', function () {
        var s = snap();
        thresholdsDraft = thresholdsDraft || { diskFreePct: s.thresholds.diskFreePct, junkGB: s.thresholds.junkGB };
        thresholdsDraft[inp.dataset.slider === 'disk' ? 'diskFreePct' : 'junkGB'] = Number(inp.value);
        document.getElementById('v-' + inp.dataset.slider).textContent = inp.value + inp.dataset.unit;
      });
    });
    var q = document.getElementById('apps-q');
    if (q) {
      q.addEventListener('input', function () {
        appsQuery = q.value;
        var pos = q.selectionStart;
        render();
        var q2 = document.getElementById('apps-q');
        q2.focus();
        q2.setSelectionRange(pos, pos);
      });
    }
    app.querySelectorAll('[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.dataset.act === 'reload') { app.innerHTML = '<div class="loading"><p>секунду~</p></div>'; load().then(function () { if (data) schedulePoll(); }); }
        if (b.dataset.act === 'save-thr') {
          var t = thresholdsDraft || snap().thresholds;
          sendCmd('thresholds', { diskFreePct: t.diskFreePct, junkGB: t.junkGB }, 'новые пороги');
          thresholdsDraft = null;
        }
      });
    });
    drawTreemap();
  }

  document.querySelectorAll('#tabs button').forEach(function (b) {
    b.addEventListener('click', function () { setTab(b.dataset.tab); });
  });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') load(true); });
  window.addEventListener('resize', function () { if (tab === 'disk') drawTreemap(); });

  setupTelegram();
  load().then(function () { if (data) schedulePoll(); });
})();
