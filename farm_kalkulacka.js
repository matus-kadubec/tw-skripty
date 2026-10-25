/*
 * Farm kalkulačka z oznámenia – Divoké kmene / Tribal Wars
 * ---------------------------------------------------------
 * Spusti na otvorenom oznámení o útoku, kde boli úspešní špehovia.
 * Skript:
 *   1. prečíta zo stránky vyšpehované suroviny a úrovne budov,
 *   2. načíta nastavenia sveta (rýchlosť, rýchlosť a nosnosť jednotiek),
 *   3. načíta, koľko vojakov máš doma v útočiacej dedine,
 *   4. spočíta, koľko surovín tam bude, keď armáda dorazí,
 *   5. navrhne armádu, ktorá to unesie s čo najmenším odpadom nosnosti.
 * Nič neposiela sám – iba ti pripraví odkaz na zhromaždisko. Klikáš ty.
 */
(async function () {
  'use strict';

  // ---------- 0. Sme na správnej stránke? ----------
  // "game_data" je objekt, ktorý hra vkladá do každej stránky (info o hráčovi, dedine, svete).
  if (typeof game_data === 'undefined' || !document.querySelector('#attack_info_def')) {
    alert('Farm kalkulačka: otvor oznámenie o útoku a spusti skript znova.');
    return;
  }
  document.getElementById('fc-panel')?.remove(); // ak už panel existuje, zavri ho

  // ---------- 1. Konštanty ----------
  const FARM_UNITS = ['spear', 'sword', 'axe', 'archer', 'light', 'marcher', 'heavy', 'knight'];
  const UNITS = FARM_UNITS.filter(u => !Array.isArray(game_data.units) || game_data.units.includes(u));
  const POP = { spear: 1, sword: 1, axe: 1, archer: 1, light: 4, marcher: 5, heavy: 6, knight: 10 };
  const LABEL = {
    spear: 'Kopijník', sword: 'Šermiar', axe: 'Sekerník', archer: 'Lukostrelec',
    light: 'Ľahká jazda', marcher: 'Jazdecký lukostrelec', heavy: 'Ťažká jazda', knight: 'Paladin'
  };
  // Záložné hodnoty pre svet s rýchlosťou 1 (minúty na pole, nosnosť)
  const BASE = {
    spear: { speed: 18, carry: 25 }, sword: { speed: 22, carry: 15 }, axe: { speed: 18, carry: 10 },
    archer: { speed: 18, carry: 10 }, light: { speed: 10, carry: 80 }, marcher: { speed: 10, carry: 50 },
    heavy: { speed: 11, carry: 50 }, knight: { speed: 10, carry: 100 }
  };
  const RES = ['wood', 'stone', 'iron']; // "stone" = hlina (tak to volá hra)
  const RES_LABEL = { wood: 'Drevo', stone: 'Hlina', iron: 'Železo' };

  const num = t => parseInt(String(t).replace(/[^\d]/g, ''), 10) || 0; // "12.345" -> 12345
  const fmt = n => Math.round(n).toLocaleString('sk-SK');
  const fmtTime = min => {
    const s = Math.round(min * 60);
    return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  // ---------- 2. Vzorce z hry ----------
  // Produkcia za hodinu: úroveň 1 = 30, úroveň 30 = 2400 (krát rýchlosť sveta)
  const prodPerHour = (lvl, speed, bonus) =>
    (lvl > 0 ? 30 * Math.pow(1.163118, lvl - 1) : 5) * speed * (1 + bonus / 100);
  // Sklad: úroveň 1 = 1 000, úroveň 30 = 400 000 (na každú surovinu)
  const storageCap = lvl => 1000 * Math.pow(1.2294934, Math.max(1, lvl) - 1);
  // Skrýša: úroveň 1 = 150, úroveň 10 = 2 000 (na každú surovinu)
  const hideCap = lvl => (lvl > 0 ? 150 * Math.pow(1.3335, lvl - 1) : 0);

  // ---------- 3. Nastavenia sveta (s 24 h cache, aby sme nezaťažovali server) ----------
  async function loadWorld() {
    const key = 'fc_world_' + game_data.world;
    try {
      const c = JSON.parse(localStorage.getItem(key));
      if (c && Date.now() - c.time < 86400000) return c.data;
    } catch (e) { /* poškodená cache – ignoruj */ }

    const data = { speed: 1, unitSpeed: 1, units: {}, ok: false };
    try {
      const xml = async url => new DOMParser().parseFromString(await (await fetch(url)).text(), 'text/xml');
      const cfg = await xml('/interface.php?func=get_config');
      data.speed = parseFloat(cfg.querySelector('speed')?.textContent) || 1;
      data.unitSpeed = parseFloat(cfg.querySelector('unit_speed')?.textContent) || 1;
      const ui = await xml('/interface.php?func=get_unit_info');
      for (const u of FARM_UNITS) {
        const n = ui.querySelector(u);
        if (n) data.units[u] = {
          speed: parseFloat(n.querySelector('speed').textContent),
          carry: parseFloat(n.querySelector('carry').textContent)
        };
      }
      data.ok = true;
      localStorage.setItem(key, JSON.stringify({ time: Date.now(), data }));
    } catch (e) {
      console.warn('Farm kalkulačka: nepodarilo sa načítať nastavenia sveta', e);
    }
    for (const u of FARM_UNITS) {
      if (!data.units[u]) data.units[u] = { speed: BASE[u].speed / (data.speed * data.unitSpeed), carry: BASE[u].carry };
    }
    return data;
  }

  // ---------- 4. Čítanie oznámenia ----------
  function parseVillage(sel) {
    const a = document.querySelector(sel + ' .village_anchor');
    if (!a) return null;
    const m = a.textContent.match(/(\d{1,3})\|(\d{1,3})/);
    const id = a.dataset.id || (a.querySelector('a')?.href.match(/[?&]id=(\d+)/) || [])[1];
    return m ? { id, x: +m[1], y: +m[2] } : null;
  }

  function parseReport() {
    const r = {
      res: { wood: 0, stone: 0, iron: 0 },
      lvl: { wood: 0, stone: 0, iron: 0, storage: 1, hide: 0 },
      hasRes: false, hasBuildings: false
    };
    // Suroviny: <span class="nowrap"><span class="icon header wood"></span>1.234</span>
    document.querySelectorAll('#attack_spy_resources .nowrap').forEach(span => {
      const icon = span.querySelector('.icon');
      if (!icon) return;
      for (const k of RES) if (icon.classList.contains(k)) { r.res[k] = num(span.textContent); r.hasRes = true; }
    });
    // Budovy: skryté pole s JSON zoznamom, napr. [{"id":"wood","level":"12"}, ...]
    const b = document.querySelector('#attack_spy_building_data');
    if (b) {
      try {
        JSON.parse(b.value).forEach(x => { if (x.id in r.lvl) r.lvl[x.id] = parseInt(x.level, 10) || 0; });
        r.hasBuildings = true;
      } catch (e) { /* nepodarilo sa – zadáš ručne */ }
    }
    r.att = parseVillage('#attack_info_att');
    r.def = parseVillage('#attack_info_def');
    // Je útočník naozaj moja dedina? (napr. preposlané oznámenie od spoluhráča)
    const attPlayer = document.querySelector('#attack_info_att a[href*="info_player"]')?.textContent.trim();
    r.attIsMine = !!r.att && attPlayer === game_data.player.name;
    r.hoursSince = parseHoursSince();
    return r;
  }

  // Koľko hodín ubehlo od bitky (porovná dátum v oznámení s časom servera)
  function parseHoursSince() {
    const txt = document.querySelector('#content_value')?.innerText || '';
    let d = null, m;
    if ((m = txt.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})\s+(\d{1,2}):(\d{2}):(\d{2})/))) {
      let y = +m[3]; if (y < 100) y += 2000;
      d = new Date(y, m[2] - 1, +m[1], +m[4], +m[5], +m[6]);
    } else if ((m = txt.match(/([A-Za-z]{3})\w*\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/))) {
      const mi = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[1].toLowerCase());
      if (mi >= 0) d = new Date(+m[3], mi, +m[2], +m[4], +m[5], +m[6]);
    }
    const sd = document.querySelector('#serverDate')?.textContent.match(/(\d+)\/(\d+)\/(\d+)/);
    const st = document.querySelector('#serverTime')?.textContent.match(/(\d+):(\d+):(\d+)/);
    if (!d || !sd || !st) return null;
    const now = new Date(+sd[3], sd[2] - 1, +sd[1], +st[1], +st[2], +st[3]);
    const h = (now - d) / 3600000;
    return h >= 0 && h < 24 * 60 ? h : null;
  }

  // ---------- 5. Koľko vojakov mám doma ----------
  async function loadAvailable(villageId) {
    const avail = {};
    try {
      const html = await (await fetch(`/game.php?village=${villageId}&screen=place`)).text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      for (const u of UNITS) {
        const el = doc.querySelector('#units_entry_all_' + u); // text typu "(123)"
        if (el) avail[u] = num(el.textContent);
      }
    } catch (e) {
      console.warn('Farm kalkulačka: nepodarilo sa načítať jednotky', e);
    }
    return avail;
  }

  // ---------- 6. Zostavenie armády ----------
  // need = koľko surovín treba odniesť; types = povolené jednotky; avail = koľko ich je doma
  function buildArmy(need, types, units, avail) {
    const max = u => (avail[u] ?? Infinity);
    // Najprv jednotky, ktoré unesú najviac na 1 miesto na farme (populáciu)
    const sorted = types.filter(u => units[u].carry > 0)
      .sort((a, b) => units[b].carry / POP[b] - units[a].carry / POP[a]);
    const army = {};
    let left = need;

    // a) Iba "plné" jednotky – žiadna nebude mať prázdne miesto
    for (const u of sorted) {
      const n = Math.min(max(u), Math.floor(left / units[u].carry));
      if (n > 0) { army[u] = n; left -= n * units[u].carry; }
    }
    // b) Zvyšok: jednotka, ktorá ho pokryje s najmenším odpadom
    while (left > 0) {
      const free = sorted.filter(u => (army[u] || 0) < max(u));
      if (!free.length) break; // nemáš dosť vojakov
      const fits = free.filter(u => units[u].carry >= left);
      const pick = fits.length
        ? fits.reduce((a, b) => (units[a].carry <= units[b].carry ? a : b))
        : free.reduce((a, b) => (units[a].carry >= units[b].carry ? a : b));
      army[pick] = (army[pick] || 0) + 1;
      left -= units[pick].carry;
    }
    let cap = 0, pop = 0;
    for (const u in army) { cap += army[u] * units[u].carry; pop += army[u] * POP[u]; }
    return { army, cap, pop, short: left > 0 };
  }

  // ---------- 7. Hlavný výpočet ----------
  // Pre každú rýchlosť (napr. "iba jazda" vs. "aj pechota") spočíta samostatnú variantu,
  // lebo pomalšia armáda ide dlhšie a medzitým sa v dedine nahromadí viac surovín.
  function calculate(p, world) {
    const dist = Math.hypot(p.src.x - p.def.x, p.src.y - p.def.y);
    const cap = storageCap(p.lvl.storage);
    const hide = hideCap(p.lvl.hide);
    const speeds = [...new Set(p.selected.map(u => world.units[u].speed))].sort((a, b) => a - b);

    const options = speeds.map(s => {
      const types = p.selected.filter(u => world.units[u].speed <= s);
      const hours = p.hoursSince + (dist * s) / 60;
      let need = 0;
      for (const k of RES) {
        const amount = Math.min(cap, p.res[k] + prodPerHour(p.lvl[k], world.speed, p.bonus) * hours);
        need += Math.max(0, Math.floor(amount - hide));
      }
      const a = buildArmy(need, types, world.units, p.avail);
      const used = Object.keys(a.army);
      const slowest = used.length ? Math.max(...used.map(u => world.units[u].speed)) : s;
      return { need, travelMin: dist * slowest, ...a };
    });
    return { dist, cap, hide, options };
  }

  function pickBest(options, prio) {
    const ok = options.filter(o => !o.short && o.need > 0);
    if (!ok.length) return null;
    if (prio === 'fast') return ok.reduce((a, b) => (b.travelMin < a.travelMin ? b : a));
    return ok.reduce((a, b) => (b.pop < a.pop ? b : a));
  }

  function placeLink(srcId, targetId, army) {
    let url = `/game.php?village=${srcId}&screen=place&target=${targetId}`;
    if (game_data.player.sitter && game_data.player.sitter !== '0') url += '&t=' + game_data.player.id;
    for (const u in army) url += `&${u}=${army[u]}`;
    return url;
  }

  // ---------- 8. Spustenie ----------
  const report = parseReport();
  if (!report.def) { alert('Farm kalkulačka: nenašiel som cieľovú dedinu v oznámení.'); return; }

  const src = report.attIsMine ? report.att : { id: game_data.village.id, x: +game_data.village.x, y: +game_data.village.y };
  const [world, avail] = await Promise.all([loadWorld(), loadAvailable(src.id)]);

  let prefs = {};
  try { prefs = JSON.parse(localStorage.getItem('fc_prefs')) || {}; } catch (e) { /* nič */ }
  const selectedDefault = prefs.selected || ['light'];

  // ---------- 9. Panel ----------
  const panel = document.createElement('div');
  panel.id = 'fc-panel';
  panel.innerHTML = `
    <style>
      #fc-panel{position:fixed;top:60px;right:20px;width:440px;max-height:85vh;overflow:auto;z-index:99999;
        background:#f4e4bc;border:2px solid #7d510f;padding:10px;font:12px Verdana,Arial,sans-serif;color:#000;
        box-shadow:0 4px 14px rgba(0,0,0,.35)}
      #fc-panel h3{margin:0 0 8px;font-size:14px}
      #fc-panel fieldset{border:1px solid #c1a264;margin:0 0 8px;padding:6px}
      #fc-panel legend{font-weight:bold;padding:0 4px}
      #fc-panel .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:4px 8px}
      #fc-panel label{display:flex;align-items:center;gap:4px}
      #fc-panel input[type=number]{width:70px}
      #fc-panel table{width:100%;border-collapse:collapse;margin-top:6px}
      #fc-panel th,#fc-panel td{border:1px solid #c1a264;padding:3px;text-align:left;vertical-align:top}
      #fc-panel tr.best{background:#d6f0b0}
      #fc-panel .warn{color:#a00;margin:4px 0}
      #fc-panel .close{float:right;cursor:pointer;font-weight:bold}
      #fc-panel img{width:16px;height:16px;vertical-align:middle}
    </style>
    <span class="close" title="Zavrieť">✕</span>
    <h3>Farm kalkulačka</h3>
    ${!report.hasRes ? '<div class="warn">Suroviny neboli vyšpehované – doplň ich ručne.</div>' : ''}
    ${!report.hasBuildings ? '<div class="warn">Budovy neboli vyšpehované – doplň úrovne ručne (potrebuješ aspoň toľko špehov, aby videli budovy).</div>' : ''}
    ${!world.ok ? '<div class="warn">Nastavenia sveta sa nenačítali – počítam s rýchlosťou 1. Skontroluj výsledky.</div>' : ''}
    ${!report.attIsMine ? '<div class="warn">Útočník nie je tvoja dedina – počítam z aktuálne vybranej dediny.</div>' : ''}

    <fieldset><legend>Vyšpehované suroviny</legend><div class="grid">
      ${RES.map(k => `<label>${RES_LABEL[k]} <input type="number" min="0" data-res="${k}" value="${report.res[k]}"></label>`).join('')}
    </div></fieldset>

    <fieldset><legend>Úrovne budov</legend><div class="grid">
      ${RES.map(k => `<label>${RES_LABEL[k]} <input type="number" min="0" max="30" data-lvl="${k}" value="${report.lvl[k]}"></label>`).join('')}
      <label>Sklad <input type="number" min="1" max="30" data-lvl="storage" value="${report.lvl.storage}"></label>
      <label>Skrýša <input type="number" min="0" max="10" data-lvl="hide" value="${report.lvl.hide}"></label>
    </div></fieldset>

    <fieldset><legend>Ďalšie</legend><div class="grid">
      <label title="Koľko hodín ubehlo od bitky v oznámení">Hodín od bitky <input type="number" min="0" step="0.1" id="fc-hours" value="${report.hoursSince !== null ? report.hoursSince.toFixed(2) : '0'}"></label>
      <label title="Bonusová dedina, napr. +100 % produkcie">Bonus % <input type="number" min="0" id="fc-bonus" value="${prefs.bonus || 0}"></label>
      <label>Priorita <select id="fc-prio">
        <option value="pop" ${prefs.prio !== 'fast' ? 'selected' : ''}>Menej vojakov</option>
        <option value="fast" ${prefs.prio === 'fast' ? 'selected' : ''}>Rýchlejší príchod</option>
      </select></label>
    </div>
    ${report.hoursSince === null ? '<div class="warn">Čas bitky sa nepodarilo prečítať – doplň hodiny ručne.</div>' : ''}
    </fieldset>

    <fieldset><legend>Jednotky na farmenie (doma máš)</legend><div class="grid">
      ${UNITS.map(u => `<label title="${LABEL[u]}"><input type="checkbox" data-unit="${u}" ${selectedDefault.includes(u) ? 'checked' : ''}>
        <img src="/graphic/unit/unit_${u}.png" alt="${LABEL[u]}"> ${avail[u] ?? '?'}</label>`).join('')}
    </div></fieldset>

    <div id="fc-out"></div>`;
  document.body.appendChild(panel);
  panel.querySelector('.close').onclick = () => panel.remove();

  // ---------- 10. Prepočet pri každej zmene ----------
  function recalc() {
    const val = sel => parseFloat(panel.querySelector(sel).value) || 0;
    const p = {
      res: {}, lvl: {}, src, def: report.def, avail,
      hoursSince: val('#fc-hours'), bonus: val('#fc-bonus'),
      selected: [...panel.querySelectorAll('[data-unit]:checked')].map(c => c.dataset.unit)
    };
    RES.forEach(k => { p.res[k] = val(`[data-res="${k}"]`); p.lvl[k] = val(`[data-lvl="${k}"]`); });
    p.lvl.storage = val('[data-lvl="storage"]');
    p.lvl.hide = val('[data-lvl="hide"]');
    const prio = panel.querySelector('#fc-prio').value;
    localStorage.setItem('fc_prefs', JSON.stringify({ selected: p.selected, bonus: p.bonus, prio }));

    const out = panel.querySelector('#fc-out');
    if (!p.selected.length) { out.innerHTML = '<div class="warn">Vyber aspoň jednu jednotku.</div>'; return; }

    const r = calculate(p, world);
    const best = pickBest(r.options, prio);
    const armyText = a => Object.keys(a).map(u => `<img src="/graphic/unit/unit_${u}.png" title="${LABEL[u]}"> ${a[u]}`).join('<br>') || '–';

    out.innerHTML = `
      <div>Vzdialenosť <b>${r.dist.toFixed(1)}</b> polí · sklad ${fmt(r.cap)} · skrýša ${fmt(r.hide)} (na surovinu)</div>
      <table>
        <tr><th>Cesta</th><th>Korisť</th><th>Armáda</th><th>Nosnosť</th><th></th></tr>
        ${r.options.map(o => `
          <tr class="${o === best ? 'best' : ''}">
            <td>${fmtTime(o.travelMin)}</td>
            <td>${fmt(o.need)}</td>
            <td>${armyText(o.army)}</td>
            <td>${fmt(o.cap)}${o.need ? ` (${Math.round((o.need / o.cap) * 100)} %)` : ''}<br>pop ${o.pop}
              ${o.short ? '<div class="warn">Málo vojakov!</div>' : ''}</td>
            <td>${o.need > 0 && Object.keys(o.army).length
              ? `<a class="btn" href="${placeLink(src.id, report.def.id, o.army)}">Poslať</a>` : ''}</td>
          </tr>`).join('')}
      </table>
      ${best ? '' : '<div class="warn">Žiadna varianta nepokryje celú korisť (alebo tam nič nie je).</div>'}
      <div style="margin-top:6px;color:#555">Zelený riadok = odporúčaná varianta. Percento ukazuje, ako plne bude armáda naložená.</div>`;
  }

  panel.addEventListener('input', recalc);
  panel.addEventListener('change', recalc);
  recalc();
})();
