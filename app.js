/* ==========================================================
   卓球フィードバックノート
   ----------------------------------------------------------
   流れ：技を選ぶ → 練習 → 動画 → AIのフィードバック → 振り返り → 記録
   - 動画から連続写真を切り出して Gemini（Firebase AI Logic）に送る
   - 記録は Firestore の tt_users/{uid} に保存（動画本体は保存しない）
   ========================================================== */
(() => {
  "use strict";

  const FIREBASE_SDK = "https://www.gstatic.com/firebasejs/12.19.0";
  // フォームの分析はじっくり見てほしいので、いつものモデルを先に使い、だめなときだけ軽いモデルで作り直す
  const MAIN_MODEL = "gemini-3.8-flash";
  const FAST_MODEL = "gemini-3.5-flash-lite";
  const AI_TIMEOUT_MS = 60_000;

  // 連続写真：AIに送る大きさ／保存する大きさ／一覧のサムネイルの大きさ（長辺px）
  const AI_FRAME_SIDE = 512;
  const SAVE_FRAME_SIDE = 360;
  const COVER_SIDE = 160;

  const LS = {
    profile: "ttNote.profile",
    sessions: "ttNote.sessions", // 記録のキャッシュ（ログインしていないときは、これが本体）
    bests: "ttNote.bests",
  };

  const DEFAULT_PROFILE = {
    hand: "右",
    grip: "シェークハンド",
    rubber: "両面裏ソフト",
    style: "ドライブ型",
    level: "中級（ドライブ・サーブを練習中）",
    goal: "",
  };

  const TECHS = window.TT_TECHNIQUES;
  const CATS = window.TT_CATEGORIES;
  const techById = Object.fromEntries(TECHS.map((t) => [t.id, t]));

  const RATING_SCORE = { "◎": 3, "○": 2, "△": 1 };

  const REFLECT_HINTS = ["ボールが浮いた", "ネットにかかった", "オーバーした", "打点が遅れた", "足が止まった", "回転がかからない", "安定しなかった", "うまくいった！"];

  /* ---------- 要素 ---------- */
  const $ = (id) => document.getElementById(id);
  const el = new Proxy({}, { get: (_, id) => $(id) });

  /* ---------- 状態 ---------- */
  const state = {
    tab: "home",
    profile: loadJSON(LS.profile, DEFAULT_PROFILE),
    sessions: loadJSON(LS.sessions, []), // 新しい順
    bests: loadJSON(LS.bests, {}), // { techId: sessionId }
    chartTech: null,
    flow: null,
    openSessionId: null,
    framesCache: new Map(), // sessionId -> 保存した連続写真
    shotIds: new Set(), // 3Dの軌道が見られる技
  };

  /* ==========================================================
   * 共通の小物
   * ========================================================== */
  function loadJSON(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key));
      if (v == null) return structuredClone(fallback);
      return Array.isArray(fallback) ? v : { ...fallback, ...v };
    } catch {
      return structuredClone(fallback);
    }
  }
  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      console.error(err);
    }
  }
  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
  function fmtDate(ts, withTime = false) {
    const d = new Date(ts);
    const base = `${d.getMonth() + 1}/${d.getDate()}（${WEEK[d.getDay()]}）`;
    return withTime ? `${base} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}` : base;
  }
  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function scoreOf(feedback) {
    const vals = (feedback?.checks || []).map((c) => RATING_SCORE[c.rating]).filter(Boolean);
    if (!vals.length) return null;
    return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length / 3) * 100);
  }
  function ratingClass(r) {
    return { "◎": "r3", "○": "r2", "△": "r1" }[r] || "";
  }
  function showMsg(node, text) {
    node.textContent = text;
    node.classList.toggle("hidden", !text);
  }
  function persistLocal() {
    saveJSON(LS.sessions, state.sessions);
    saveJSON(LS.bests, state.bests);
  }

  /* ==========================================================
   * タブ・画面切り替え
   * ========================================================== */
  const TAB_TITLES = { home: "ホーム", book: "技の図鑑", record: "記録", settings: "設定", flow: "練習" };

  function showTab(tab) {
    state.tab = tab;
    for (const name of ["home", "book", "record", "settings", "flow"]) {
      $(`tab${name[0].toUpperCase()}${name.slice(1)}`).classList.toggle("hidden", name !== tab);
    }
    el.tabBar.classList.toggle("hidden", tab === "flow");
    el.flowCloseBtn.classList.toggle("hidden", tab !== "flow");
    el.headerTitle.textContent = TAB_TITLES[tab];
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    if (tab === "home") renderHome();
    if (tab === "book") renderBook();
    if (tab === "record") renderRecord();
    window.scrollTo(0, 0);
  }

  function openModal(modal) {
    modal.classList.remove("hidden");
  }
  function closeModal(modal) {
    modal.classList.add("hidden");
  }

  /* ==========================================================
   * ホーム
   * ========================================================== */
  function renderHome() {
    const now = new Date();
    el.heroDate.textContent = `${now.getMonth() + 1}月${now.getDate()}日（${WEEK[now.getDay()]}）`;
    const s = state.sessions;
    el.statCount.textContent = s.length;
    el.statMonth.textContent = s.filter((x) => {
      const d = new Date(x.ts);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    }).length;
    el.statTechs.textContent = new Set(s.map((x) => x.techId)).size;
    el.homeLoginNudge.classList.toggle("hidden", !cloud.ready || !!cloud.user);

    // いまの課題：技ごとに、いちばん新しい記録の「直す点」の1つ目
    const seen = new Set();
    const focus = [];
    for (const x of s) {
      if (seen.has(x.techId)) continue;
      seen.add(x.techId);
      const fix = x.feedback?.fixes?.[0];
      const action = x.advice?.actions?.[0];
      if (fix || action) focus.push({ x, text: fix ? fix.point : action, how: fix?.how || "" });
      if (focus.length >= 3) break;
    }
    el.focusCard.classList.toggle("hidden", !focus.length);
    el.focusList.innerHTML = focus
      .map(
        ({ x, text, how }) => `
        <button class="w-full text-left text-sm" data-session="${x.id}">
          <span class="check-chip">${escapeHtml(techById[x.techId]?.name || "")}</span>
          <b class="text-slate-800">${escapeHtml(text)}</b>
          ${how ? `<span class="block text-xs text-slate-500 mt-0.5">${escapeHtml(how)}</span>` : ""}
        </button>`
      )
      .join("");

    el.recentList.innerHTML = s.length
      ? s.slice(0, 3).map(sessionItemHtml).join("")
      : `<p class="empty-note">まだ記録がありません。「練習をはじめる」から記録しよう</p>`;

    renderBadges(el.badgeGrid);
  }

  function sessionItemHtml(x) {
    const tech = techById[x.techId];
    const thumb = x.cover
      ? `<img class="log-thumb" src="${x.cover}" alt="" />`
      : `<span class="log-thumb">${tech?.icon || "🏓"}</span>`;
    const best = state.bests[x.techId] === x.id ? "⭐ " : "";
    const sub = x.feedback?.fixes?.[0]?.point || x.reflection || x.feedback?.summary || "";
    const score = x.score != null ? `<span class="log-score">${x.score}点</span>` : `<span class="log-score none">メモ</span>`;
    return `
      <button class="log-item" data-session="${x.id}">
        ${thumb}
        <span class="flex-1 min-w-0">
          <span class="block text-xs text-slate-500">${fmtDate(x.ts)}</span>
          <span class="block font-bold text-sm truncate">${best}${escapeHtml(tech?.name || "（消えた技）")}</span>
          <span class="block text-xs text-slate-500 truncate">${escapeHtml(sub)}</span>
        </span>
        ${score}
      </button>`;
  }

  /* ---------- バッジ ---------- */
  const BADGES = [
    { id: "first", icon: "🏓", name: "はじめての記録", test: (s) => s.length >= 1 },
    { id: "ten", icon: "🔟", name: "記録10回", test: (s) => s.length >= 10 },
    { id: "variety", icon: "🌈", name: "5種類の技", test: (s) => new Set(s.map((x) => x.techId)).size >= 5 },
    { id: "ai10", icon: "🎥", name: "AIに10回見てもらう", test: (s) => s.filter((x) => x.feedback).length >= 10 },
    { id: "reflect10", icon: "📝", name: "振り返り10回", test: (s) => s.filter((x) => x.reflection).length >= 10 },
    { id: "best", icon: "⭐", name: "ベストを決めた", test: () => Object.keys(state.bests).length >= 1 },
    { id: "score90", icon: "🎯", name: "90点以上", test: (s) => s.some((x) => x.score >= 90) },
    {
      id: "up",
      icon: "📈",
      name: "自己ベスト更新",
      test: (s) => {
        const max = {};
        for (const x of [...s].reverse()) {
          if (x.score == null) continue;
          if (max[x.techId] != null && x.score > max[x.techId]) return true;
          max[x.techId] = Math.max(max[x.techId] ?? -1, x.score);
        }
        return false;
      },
    },
  ];
  function earnedBadges() {
    return new Set(BADGES.filter((b) => b.test(state.sessions)).map((b) => b.id));
  }
  function renderBadges(container) {
    const got = earnedBadges();
    container.innerHTML = BADGES.map(
      (b) => `<div class="badge-tile ${got.has(b.id) ? "" : "locked"}"><div class="badge-icon">${b.icon}</div><p>${b.name}</p></div>`
    ).join("");
  }

  /* ==========================================================
   * 図鑑
   * ========================================================== */
  function renderBook() {
    el.bookList.innerHTML = CATS.map((cat) => {
      const items = TECHS.filter((t) => t.cat === cat.id)
        .map((t) => {
          const mine = state.sessions.filter((x) => x.techId === t.id);
          const last = mine.find((x) => x.score != null);
          const meta = mine.length ? `${mine.length}回${last ? `・前回 ${last.score}点` : ""}` : "まだ練習していない";
          return `
            <button class="tech-item" data-tech="${t.id}">
              <span class="tech-icon">${t.icon}</span>
              <span class="flex-1 min-w-0">
                <span class="block font-bold text-sm">${escapeHtml(t.name)}${state.bests[t.id] ? " ⭐" : ""}</span>
                <span class="block text-xs text-slate-500 truncate">${escapeHtml(t.summary)}</span>
              </span>
              <span class="text-xs text-slate-400 whitespace-nowrap">${meta}</span>
            </button>`;
        })
        .join("");
      return `<section><p class="cat-title">${cat.name}</p><div class="space-y-2">${items}</div></section>`;
    }).join("");
  }

  function openTech(techId) {
    const t = techById[techId];
    if (!t) return;
    el.techTitle.textContent = `${t.icon} ${t.name}`;
    const mine = state.sessions.filter((x) => x.techId === t.id);
    const scored = mine.filter((x) => x.score != null);
    const best = state.sessions.find((x) => x.id === state.bests[t.id]);
    const lastFix = mine.find((x) => x.feedback?.fixes?.length)?.feedback.fixes[0];
    const list = (arr) => `<ul>${arr.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>`;
    el.techBody.innerHTML = `
      <div class="tech-body">
        <p class="text-sm text-slate-600">${escapeHtml(t.summary)}</p>
        ${state.shotIds.has(t.id) ? `<button class="traj-open-btn" data-traj="${t.id}">🎥 ボールの軌道を3Dで見る<span>回転でどう曲がるか・スロー再生・動画で保存</span></button>` : ""}
        ${
          mine.length
            ? `<div class="grid grid-cols-3 gap-2 mt-3">
                <div class="stat-card"><p class="stat-label">練習</p><p class="stat-value">${mine.length}<small>回</small></p></div>
                <div class="stat-card"><p class="stat-label">前回</p><p class="stat-value">${scored[0]?.score ?? "-"}<small>点</small></p></div>
                <div class="stat-card"><p class="stat-label">最高</p><p class="stat-value">${scored.length ? Math.max(...scored.map((x) => x.score)) : "-"}<small>点</small></p></div>
              </div>`
            : ""
        }
        ${lastFix ? `<div class="mt-3 text-sm bg-amber-50 text-amber-900 rounded-lg p-3"><b>前回の課題：</b>${escapeHtml(lastFix.point)}<br><span class="text-xs">${escapeHtml(lastFix.how)}</span></div>` : ""}
        ${best ? `<button class="mt-2 text-xs link-btn" data-session="${best.id}">⭐ ベストの回（${fmtDate(best.ts)}）を見る</button>` : ""}
        ${scored.length >= 2 ? `<h3>フォーム点の推移</h3><div class="chart-host relative">${chartSvg(scored)}</div>` : ""}
        <h3>コツ</h3>${list(t.tips)}
        <h3>よくあるミス</h3>${list(t.mistakes)}
        <h3>チェック項目（AIが ◎○△ で評価）</h3>
        <div>${t.checks.map((c) => `<span class="check-chip">${escapeHtml(c)}</span>`).join("")}</div>
        <h3>おすすめ練習</h3>
        <ul>${t.drills.map((d) => `<li><b>${escapeHtml(d.name)}</b>：${escapeHtml(d.how)}</li>`).join("")}</ul>
        <h3>動画の撮り方</h3>
        <p class="text-sm text-slate-700">📱 ${escapeHtml(t.film)}</p>
      </div>`;
    el.techStartBtn.onclick = () => {
      closeModal(el.techModal);
      startFlow(t.id);
    };
    openModal(el.techModal);
  }

  /* ==========================================================
   * 記録タブ
   * ========================================================== */
  function renderRecord() {
    // グラフ：点数のある記録がある技だけ
    const techIds = [...new Set(state.sessions.filter((x) => x.score != null).map((x) => x.techId))];
    if (!techIds.includes(state.chartTech)) state.chartTech = techIds[0] || null;
    el.chartTechChips.innerHTML = techIds
      .map(
        (id) =>
          `<button class="pick-chip whitespace-nowrap ${id === state.chartTech ? "selected" : ""}" data-chart-tech="${id}">${escapeHtml(techById[id]?.name || id)}</button>`
      )
      .join("");
    const series = state.sessions.filter((x) => x.techId === state.chartTech && x.score != null);
    el.chartBox.innerHTML = series.length
      ? `<div class="chart-host relative">${chartSvg(series)}</div>`
      : `<p class="empty-note">AIにフォームを見てもらうと、ここに点数の推移が出ます</p>`;

    // 一覧
    const usedTechs = [...new Set(state.sessions.map((x) => x.techId))];
    const current = el.recordFilter.value;
    el.recordFilter.innerHTML =
      `<option value="">すべての技</option>` +
      usedTechs.map((id) => `<option value="${id}">${escapeHtml(techById[id]?.name || id)}</option>`).join("");
    el.recordFilter.value = usedTechs.includes(current) ? current : "";
    const list = state.sessions.filter((x) => !el.recordFilter.value || x.techId === el.recordFilter.value);
    el.recordList.innerHTML = list.length ? list.map(sessionItemHtml).join("") : `<p class="empty-note">まだ記録がありません</p>`;
  }

  /**
   * フォーム点の折れ線グラフ（1系列なので凡例なし。⭐ベストはオレンジの点）
   * sessions は新しい順で渡す
   */
  function chartSvg(sessions) {
    const pts = [...sessions].reverse().slice(-20);
    const W = 320, H = 150, L = 28, R = 10, T = 12, B = 22;
    const x = (i) => (pts.length === 1 ? (L + W - R) / 2 : L + ((W - L - R) * i) / (pts.length - 1));
    const y = (v) => T + ((H - T - B) * (100 - v)) / 100;
    const grid = [0, 50, 100]
      .map((v) => `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis-text" x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${v}</text>`)
      .join("");
    const path = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.score).toFixed(1)}`).join("");
    const first = pts[0], last = pts[pts.length - 1];
    const labels =
      `<text class="axis-text" x="${x(0)}" y="${H - 4}" text-anchor="${pts.length === 1 ? "middle" : "start"}">${fmtDate(first.ts).replace(/（.）/, "")}</text>` +
      (pts.length > 1 ? `<text class="axis-text" x="${x(pts.length - 1)}" y="${H - 4}" text-anchor="end">${fmtDate(last.ts).replace(/（.）/, "")}</text>` : "");
    const dots = pts
      .map((p, i) => {
        const best = state.bests[p.techId] === p.id;
        return `<circle class="dot ${best ? "best" : ""}" cx="${x(i)}" cy="${y(p.score)}" r="${best ? 6 : 5}"/>
          <circle class="hit" cx="${x(i)}" cy="${y(p.score)}" r="14" data-tip="${fmtDate(p.ts)} ${p.score}点${best ? " ⭐" : ""}" data-session="${p.id}" data-x="${x(i)}" data-y="${y(p.score)}"/>`;
      })
      .join("");
    return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="フォーム点の推移">${grid}<path class="series" d="${path}"/>${labels}${dots}</svg>`;
  }

  // グラフの点：ホバー（またはタップ）で日付と点数、クリックで記録を開く
  function initChartHover() {
    document.addEventListener("pointerover", (e) => {
      const hit = e.target.closest?.(".hit");
      if (!hit) return;
      const host = hit.closest(".chart-host");
      const svg = hit.ownerSVGElement;
      const scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
      host.querySelector(".chart-tip")?.remove();
      const tip = document.createElement("div");
      tip.className = "chart-tip";
      tip.textContent = hit.dataset.tip;
      tip.style.left = `${hit.dataset.x * scale}px`;
      tip.style.top = `${hit.dataset.y * scale - 6}px`;
      host.appendChild(tip);
    });
    document.addEventListener("pointerout", (e) => {
      if (e.target.closest?.(".hit")) e.target.closest(".chart-host")?.querySelector(".chart-tip")?.remove();
    });
  }

  /* ==========================================================
   * 記録の詳細
   * ========================================================== */
  async function openSession(id) {
    const x = state.sessions.find((s) => s.id === id);
    if (!x) return;
    state.openSessionId = id;
    const tech = techById[x.techId];
    el.sessionTitle.textContent = `${tech?.icon || "🏓"} ${tech?.name || ""}`;
    el.sessionBody.innerHTML = `
      <p class="text-xs text-slate-500">${fmtDate(x.ts, true)}${x.feel ? `　手ごたえ ${"★".repeat(x.feel)}${"☆".repeat(5 - x.feel)}` : ""}</p>
      ${x.focus?.length ? `<p class="text-sm mt-2"><b>意識したこと：</b>${x.focus.map(escapeHtml).join("、")}</p>` : ""}
      <div id="sessionFrames" class="mt-3"></div>
      ${x.feedback ? `<div class="mt-3">${feedbackHtml(x.feedback, x.score)}</div>` : ""}
      ${x.reflection ? `<div class="card mt-3 bg-slate-50"><p class="font-bold text-sm">📝 振り返り</p><p class="text-sm mt-1 whitespace-pre-wrap">${escapeHtml(x.reflection)}</p></div>` : ""}
      ${x.advice ? `<div class="mt-3">${adviceHtml(x.advice)}</div>` : ""}`;
    renderBestBtn(x);
    openModal(el.sessionModal);

    if (x.hasFrames) {
      el.sessionFrames.innerHTML = `<p class="text-xs text-slate-400">写真を読み込み中…</p>`;
      const frames = await loadFrames(x.id).catch(() => null);
      if (state.openSessionId !== id) return;
      el.sessionFrames.innerHTML = frames?.length
        ? `<div class="frame-grid">${pickEven(frames, 8).map((f) => `<img src="${f}" alt="" />`).join("")}</div>`
        : "";
    }
  }

  function renderBestBtn(x) {
    const on = state.bests[x.techId] === x.id;
    el.bestBtn.textContent = on ? "⭐ ベストの回" : "☆ ベストにする";
    el.bestBtn.classList.toggle("on", on);
    el.bestBtn.disabled = !x.hasFrames && !on;
    el.bestBtn.title = x.hasFrames ? "" : "写真がない記録はベストにできません";
  }

  async function toggleBest() {
    const x = state.sessions.find((s) => s.id === state.openSessionId);
    if (!x) return;
    if (state.bests[x.techId] === x.id) delete state.bests[x.techId];
    else state.bests[x.techId] = x.id;
    persistLocal();
    renderBestBtn(x);
    refreshCurrentTab();
    await pushUserDoc();
  }

  async function deleteSession() {
    const x = state.sessions.find((s) => s.id === state.openSessionId);
    if (!x || !confirm("この記録を消しますか？（元に戻せません）")) return;
    state.sessions = state.sessions.filter((s) => s.id !== x.id);
    if (state.bests[x.techId] === x.id) delete state.bests[x.techId];
    persistLocal();
    closeModal(el.sessionModal);
    refreshCurrentTab();
    if (cloud.user && !x.local) {
      const { doc, deleteDoc } = cloud.fs;
      await Promise.all([
        deleteDoc(doc(cloud.db, "tt_users", cloud.user.uid, "sessions", x.id)),
        deleteDoc(doc(cloud.db, "tt_users", cloud.user.uid, "frames", x.id)),
      ]).catch((err) => console.error(err));
      await pushUserDoc();
    }
  }

  function refreshCurrentTab() {
    if (state.tab === "home") renderHome();
    if (state.tab === "book") renderBook();
    if (state.tab === "record") renderRecord();
  }

  function pickEven(arr, n) {
    if (arr.length <= n) return arr;
    return Array.from({ length: n }, (_, i) => arr[Math.round((i * (arr.length - 1)) / (n - 1))]);
  }

  /* ---------- フィードバック・助言の表示 ---------- */
  function feedbackHtml(fb, score) {
    const good = (fb.good || []).map((g) => `<div class="fb-good">${escapeHtml(g)}</div>`).join("");
    const fixes = (fb.fixes || [])
      .map(
        (f, i) => `<div class="fb-fix"><b>${i + 1}. ${escapeHtml(f.point)}</b>
          <p class="text-xs text-slate-500 mt-0.5">${escapeHtml(f.why)}</p>
          <p class="mt-1">👉 ${escapeHtml(f.how)}</p></div>`
      )
      .join("");
    const checks = (fb.checks || [])
      .map(
        (c) => `<div class="rating-row"><span class="rating ${ratingClass(c.rating)}">${escapeHtml(c.rating)}</span>
          <span><b>${escapeHtml(c.item)}</b><span class="block text-xs text-slate-500">${escapeHtml(c.comment)}</span></span></div>`
      )
      .join("");
    const drills = (fb.drills || []).map((d) => `<li><b>${escapeHtml(d.name)}</b>：${escapeHtml(d.how)}</li>`).join("");
    return `
      <div class="card">
        <div class="flex items-center gap-4">
          <div class="text-center"><p class="score-big">${score ?? "-"}</p><p class="text-xs text-slate-500 font-bold">フォーム点</p></div>
          <p class="text-sm flex-1">${escapeHtml(fb.summary)}</p>
        </div>
        ${fb.visible === false ? `<p class="text-xs bg-amber-50 text-amber-800 rounded-lg p-2 mt-3">写真から技の動きがよく見えなかったようです。撮り方や範囲を変えると、より正確になります。</p>` : ""}
      </div>
      ${fb.compare ? `<div class="card mt-3 bg-amber-50"><div class="fb-block"><h3>⭐ ベストの回と比べて</h3><p class="text-sm text-slate-700">${escapeHtml(fb.compare)}</p></div></div>` : ""}
      ${good ? `<div class="card mt-3 fb-block"><h3>👍 良かった点</h3><div class="fb-list">${good}</div></div>` : ""}
      ${fixes ? `<div class="card mt-3 fb-block"><h3>🔧 直す点（優先順）</h3><div class="fb-list">${fixes}</div></div>` : ""}
      ${checks ? `<div class="card mt-3 fb-block"><h3>✅ チェック項目</h3><div>${checks}</div><p class="text-xs text-slate-400 mt-2">◎よくできている ○だいたいできている △課題あり −写真から判断できない</p></div>` : ""}
      ${drills ? `<div class="card mt-3 fb-block tech-body"><h3>🏓 次の練習メニュー</h3><ul>${drills}</ul></div>` : ""}`;
  }

  function adviceHtml(a) {
    const causes = (a.causes || []).map((c) => `<div class="fb-fix"><b>${escapeHtml(c.cause)}</b><p class="text-xs text-slate-600 mt-0.5">${escapeHtml(c.detail)}</p></div>`).join("");
    const actions = (a.actions || []).map((s) => `<li>${escapeHtml(s)}</li>`).join("");
    return `
      <div class="card fb-block tech-body">
        <h3 style="margin-top:0">💬 AIコーチの助言</h3>
        ${causes ? `<p class="text-xs font-bold text-slate-500 mb-1">考えられる原因</p><div class="fb-list">${causes}</div>` : ""}
        ${actions ? `<p class="text-xs font-bold text-slate-500 mt-3 mb-1">次の練習で意識すること</p><ul>${actions}</ul>` : ""}
        ${a.nextDrill?.name ? `<p class="text-xs font-bold text-slate-500 mt-3 mb-1">おすすめメニュー</p><p class="text-sm"><b>${escapeHtml(a.nextDrill.name)}</b>：${escapeHtml(a.nextDrill.how)}</p>` : ""}
        ${a.cheer ? `<p class="text-sm mt-3 text-sky-700 font-bold">${escapeHtml(a.cheer)}</p>` : ""}
      </div>`;
  }

  /* ==========================================================
   * 練習の流れ
   * ========================================================== */
  function startFlow(techId = null) {
    state.flow = {
      id: newId(),
      techId: null,
      focus: [],
      video: null, // { url, duration }
      start: 0,
      len: 3,
      aiFrames: [],
      saveFrames: [],
      cover: null,
      feedback: null,
      reflection: "",
      feel: 0,
      advice: null,
      compareUsed: false,
    };
    renderPick();
    if (techId) selectTech(techId);
    resetVideoUI();
    el.reflectText.value = "";
    showFlowStep("flowPick");
    showTab("flow");
  }

  function showFlowStep(id) {
    const order = ["flowPick", "flowVideo", "flowResult", "flowReflect", "flowDone"];
    order.forEach((s) => $(s).classList.toggle("hidden", s !== id));
    const n = order.indexOf(id) + 1;
    document.querySelectorAll("#stepper .step").forEach((li) => {
      const k = Number(li.dataset.step);
      li.classList.toggle("active", k === n);
      li.classList.toggle("done", k < n);
    });
    el.stepper.classList.toggle("hidden", id === "flowDone");
    window.scrollTo(0, 0);
  }

  function closeFlow() {
    const f = state.flow;
    const dirty = f && (f.feedback || el.reflectText.value.trim()) && !f.saved;
    if (dirty && !confirm("記録せずに閉じますか？（フィードバックは消えます）")) return;
    if (f?.video?.url) URL.revokeObjectURL(f.video.url);
    el.videoEl.removeAttribute("src");
    state.flow = null;
    showTab("home");
  }

  /* ---------- STEP1：技を選ぶ ---------- */
  function renderPick() {
    // よく練習する技を上に出すため、カテゴリごとに並べる
    el.pickTechList.innerHTML = CATS.map((cat) => {
      const chips = TECHS.filter((t) => t.cat === cat.id)
        .map((t) => `<button class="pick-chip" data-pick="${t.id}">${t.icon} ${escapeHtml(t.name)}</button>`)
        .join("");
      return `<div><p class="cat-title">${cat.name}</p><div class="flex flex-wrap gap-2">${chips}</div></div>`;
    }).join("");
    el.pickFocusCard.classList.add("hidden");
    el.pickNextBtn.disabled = true;
    el.pickFocusFree.value = "";
  }

  function selectTech(techId) {
    const f = state.flow;
    const t = techById[techId];
    f.techId = techId;
    f.focus = [];
    el.pickTechList.querySelectorAll("[data-pick]").forEach((b) => b.classList.toggle("selected", b.dataset.pick === techId));
    el.pickFocusList.innerHTML = t.checks
      .map((c) => `<label class="step-item"><input type="checkbox" value="${escapeHtml(c)}" /><span>${escapeHtml(c)}</span></label>`)
      .join("");
    const last = state.sessions.find((x) => x.techId === techId && (x.feedback?.fixes?.length || x.advice?.actions?.length));
    const lastFix = last?.feedback?.fixes?.[0];
    const lastAction = last?.advice?.actions?.[0];
    el.pickLastFix.classList.toggle("hidden", !last);
    if (last) {
      el.pickLastFix.innerHTML = `📌 前回（${fmtDate(last.ts)}）の課題：<b>${escapeHtml(lastFix?.point || lastAction)}</b>${lastFix?.how ? `<br>${escapeHtml(lastFix.how)}` : ""}`;
    }
    el.pickFocusCard.classList.remove("hidden");
    el.pickNextBtn.disabled = false;
  }

  function onFocusChange(e) {
    const boxes = [...el.pickFocusList.querySelectorAll("input")];
    const checked = boxes.filter((b) => b.checked);
    if (checked.length > 2) e.target.checked = false; // 意識するのは2つまで
  }

  function goVideo() {
    const f = state.flow;
    f.focus = [...el.pickFocusList.querySelectorAll("input:checked")].map((b) => b.value);
    const free = el.pickFocusFree.value.trim();
    if (free) f.focus.push(free);
    const t = techById[f.techId];
    el.filmTip.textContent = `📱 撮り方：${t.film}。スマホを置いて固定し、10〜30秒くらい撮ると見やすいです。`;
    const best = bestSessionFor(f.techId);
    el.compareRow.classList.toggle("hidden", !best);
    if (best) el.compareDate.textContent = fmtDate(best.ts);
    showFlowStep("flowVideo");
  }

  function bestSessionFor(techId) {
    const id = state.bests[techId];
    const x = state.sessions.find((s) => s.id === id);
    return x?.hasFrames && cloud.user ? x : null;
  }

  /* ---------- STEP2：動画 ---------- */
  function resetVideoUI() {
    el.videoEditor.classList.add("hidden");
    el.analyzeBtn.disabled = true;
    el.framePreview.innerHTML = "";
    showMsg(el.videoMsg, "");
    el.videoCapture.value = "";
    el.videoPick.value = "";
    el.rangeLenChips.querySelectorAll(".len-chip").forEach((b) => b.classList.toggle("selected", b.dataset.len === "3"));
  }

  function onVideoChosen(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const f = state.flow;
    if (f.video?.url) URL.revokeObjectURL(f.video.url);
    const url = URL.createObjectURL(file);
    f.video = { url, duration: 0 };
    f.aiFrames = [];
    showMsg(el.videoMsg, "");
    el.framePreview.innerHTML = "";
    el.videoEl.src = url;
    el.videoEl.load();
    el.videoEditor.classList.remove("hidden");
    el.analyzeBtn.disabled = true;
    el.rangeLabel.textContent = "動画を読み込み中…";
  }

  function onVideoLoaded() {
    const f = state.flow;
    if (!f?.video) return;
    let d = el.videoEl.duration;
    if (!isFinite(d) || d <= 0) d = 30; // 長さが分からない動画は30秒とみなす
    f.video.duration = d;
    f.start = 0;
    el.rangeStart.max = Math.max(0, d - Math.min(f.len, d)).toFixed(1);
    el.rangeStart.value = 0;
    updateRangeLabel();
    el.analyzeBtn.disabled = false;
  }

  function updateRangeLabel() {
    const f = state.flow;
    if (!f?.video) return;
    const len = Math.min(f.len, f.video.duration);
    el.rangeLabel.textContent = `${f.start.toFixed(1)}秒 〜 ${(f.start + len).toFixed(1)}秒（全体 ${f.video.duration.toFixed(1)}秒）を見せます`;
  }

  function setRangeStart(v) {
    const f = state.flow;
    const max = Number(el.rangeStart.max);
    f.start = Math.max(0, Math.min(max, v));
    el.rangeStart.value = f.start;
    updateRangeLabel();
  }

  function setRangeLen(len) {
    const f = state.flow;
    f.len = len;
    el.rangeLenChips.querySelectorAll(".len-chip").forEach((b) => b.classList.toggle("selected", Number(b.dataset.len) === len));
    if (f.video) {
      el.rangeStart.max = Math.max(0, f.video.duration - Math.min(len, f.video.duration)).toFixed(1);
      setRangeStart(f.start);
    }
  }

  // 動画の t 秒の場面に移動する（seeked が来ないブラウザ向けに時間切れも用意）
  function seekTo(video, t) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        video.removeEventListener("seeked", done);
        resolve();
      };
      const timer = setTimeout(done, 2500);
      video.addEventListener("seeked", done);
      video.currentTime = t;
    });
  }

  function drawScaled(video, side, quality) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const scale = Math.min(1, side / Math.max(vw, vh));
    const c = el.workCanvas;
    c.width = Math.round(vw * scale);
    c.height = Math.round(vh * scale);
    c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", quality);
  }

  /** 選んだ範囲から連続写真を切り出す */
  async function extractFrames() {
    const f = state.flow;
    const video = el.videoEl;
    // iPhone では一度再生しないと場面を移動できないことがある
    if (video.readyState < 2) {
      await video.play().catch(() => {});
      video.pause();
    }
    if (!video.videoWidth) throw new Error("動画を読み込めませんでした。別の動画でお試しください（iPhoneで撮った動画は「互換性優先」の形式だと確実です）");
    const len = Math.min(f.len, f.video.duration);
    const n = f.len >= 5 ? 20 : 16;
    const ai = [], save = [], times = [];
    for (let i = 0; i < n; i++) {
      const t = Math.min(f.video.duration - 0.05, f.start + (len * (i + 0.5)) / n);
      await seekTo(video, t);
      ai.push(drawScaled(video, AI_FRAME_SIDE, 0.75));
      save.push(drawScaled(video, SAVE_FRAME_SIDE, 0.6));
      times.push(t);
    }
    await seekTo(video, f.start);
    f.cover = drawScaled(video, COVER_SIDE, 0.6);
    f.aiFrames = ai;
    f.saveFrames = save;
    f.frameTimes = times;
    el.framePreview.innerHTML = pickEven(save, 8).map((s) => `<img src="${s}" alt="" />`).join("");
  }

  /* ---------- STEP3：AIのフィードバック ---------- */
  async function analyze() {
    const f = state.flow;
    showMsg(el.videoMsg, "");
    el.analyzeBtn.disabled = true;
    try {
      el.analyzeBtn.textContent = "写真を切り出し中…";
      await extractFrames();
    } catch (err) {
      console.error(err);
      showMsg(el.videoMsg, err.message);
      el.analyzeBtn.disabled = false;
      el.analyzeBtn.textContent = "AIにフィードバックしてもらう";
      return;
    }
    el.analyzeBtn.textContent = "AIにフィードバックしてもらう";
    el.analyzeBtn.disabled = false;
    await runAnalysis();
  }

  async function runAnalysis() {
    const f = state.flow;
    showFlowStep("flowResult");
    el.analyzing.classList.remove("hidden");
    el.resultBody.classList.add("hidden");
    el.resultActions.classList.add("hidden");
    el.resultRetry.classList.add("hidden");
    showMsg(el.resultMsg, "");

    try {
      // ベストの回の写真（比べる設定のときだけ）
      let compare = null;
      const best = bestSessionFor(f.techId);
      if (best && el.compareToggle.checked) {
        el.analyzePhase.textContent = "ベストの回の写真を読み込み中";
        const frames = await loadFrames(best.id).catch(() => null);
        if (frames?.length) compare = { session: best, frames: pickEven(frames, 10) };
      }
      f.compareUsed = !!compare;
      const fb = await requestFeedback(f, compare);
      f.feedback = fb;
      f.score = scoreOf(fb);
      el.resultBody.innerHTML =
        `<div class="card mb-3"><p class="text-xs font-bold text-slate-500 mb-2">AIが見た場面</p><div class="frame-strip">${pickEven(f.saveFrames, 8)
          .map((s) => `<img src="${s}" alt="" />`)
          .join("")}</div></div>` + feedbackHtml(fb, f.score);
      el.resultBody.classList.remove("hidden");
      el.resultActions.classList.remove("hidden");
    } catch (err) {
      console.error(err);
      showMsg(el.resultMsg, err.message);
      el.resultRetry.classList.remove("hidden");
    } finally {
      el.analyzing.classList.add("hidden");
    }
  }

  function profileText() {
    const p = state.profile;
    return [
      `- 利き手：${p.hand}`,
      `- グリップ：${p.grip}`,
      `- ラバー：${p.rubber}`,
      `- 戦型：${p.style}`,
      `- レベル：${p.level}`,
      p.goal ? `- 目標・悩み：${p.goal}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  async function requestFeedback(f, compare) {
    const t = techById[f.techId];
    const len = Math.min(f.len, f.video.duration);
    const prompt = `あなたは経験豊富な卓球のコーチです。選手の練習動画から切り出した連続写真（時間順）を見て、フォームのフィードバックをしてください。

# 選手
${profileText()}
${state.profile.hand === "左" ? "※左利きなので、技の説明の左右は逆になります。\n" : ""}
# 練習した技：${t.name}
- 技の要点：${t.tips.join(" / ")}
- よくあるミス：${t.mistakes.join(" / ")}
# 今回意識したこと：${f.focus.length ? f.focus.join("、") : "（特になし）"}

# 写真
- 「今回」の写真：${f.aiFrames.length}枚。動画の${len.toFixed(1)}秒間を等間隔に切り出したもの
${compare ? `- 「ベスト」の写真：${compare.frames.length}枚。同じ技で、本人がいちばん良かったと選んだ回（${fmtDate(compare.session.ts)}）。今回の写真のあとに続く` : ""}

# 出力のルール
- checks は次の項目を、この順番ですべて評価する：${t.checks.join("、")}
  rating は "◎"（よくできている）"○"（だいたいできている）"△"（課題がある）"-"（写真から判断できない）のどれか1文字
- 写真に写っていないことを推測で断定しない。判断できない項目は "-" にして、comment に撮り方の提案を書く
- good は1〜3個。具体的に
- fixes は優先度の高い順に最大3個。point＝何を直すか（短く）、why＝今どうなっていて、なぜ大事か、how＝具体的な直し方（練習中に意識する短い言葉を含める）
- 意識したことができていたかを、summary か good / fixes で必ず触れる
- drills は次の練習メニューを1〜2個
- compare は「ベスト」の写真があるときだけ、ベストと比べて良くなった点・違う点を2〜3文で。ないときは空文字
- summary は2文以内
- 写真に卓球の動きがほとんど写っていない、または別の技に見えるときは visible を false にし、summary でそのことを伝える
- 中学生にも分かるやさしい日本語で。専門用語は使ってよいが、必要なら短く説明する`;

    const parts = [prompt, "【今回】"];
    f.aiFrames.forEach((d) => parts.push(imagePart(d)));
    if (compare) {
      parts.push("【ベスト】");
      compare.frames.forEach((d) => parts.push(imagePart(d)));
    }
    const { Schema } = requireAI();
    const schema = Schema.object({
      properties: {
        visible: Schema.boolean({ description: "写真から技の動きが確認できたか" }),
        summary: Schema.string(),
        good: Schema.array({ items: Schema.string() }),
        fixes: Schema.array({
          items: Schema.object({ properties: { point: Schema.string(), why: Schema.string(), how: Schema.string() } }),
        }),
        checks: Schema.array({
          items: Schema.object({
            properties: {
              item: Schema.string(),
              rating: Schema.string({ description: "◎ ○ △ - のどれか" }),
              comment: Schema.string(),
            },
          }),
        }),
        drills: Schema.array({ items: Schema.object({ properties: { name: Schema.string(), how: Schema.string() } }) }),
        compare: Schema.string(),
      },
    });
    const obj = await callAI(parts, schema);
    return normalizeFeedback(obj, t);
  }

  function imagePart(dataUrl) {
    return { inlineData: { mimeType: "image/jpeg", data: dataUrl.split(",")[1] } };
  }

  function normalizeFeedback(obj, t) {
    const str = (v) => (typeof v === "string" ? v.trim() : "");
    const arr = (v) => (Array.isArray(v) ? v : []);
    const checks = arr(obj.checks).map((c) => {
      let rating = str(c.rating).replace("-", "−").replace("－", "−");
      if (!["◎", "○", "△"].includes(rating)) rating = rating === "〇" || rating === "o" ? "○" : "−";
      return { item: str(c.item), rating, comment: str(c.comment) };
    });
    return {
      visible: obj.visible !== false,
      summary: str(obj.summary),
      good: arr(obj.good).map(str).filter(Boolean).slice(0, 3),
      fixes: arr(obj.fixes)
        .map((x) => ({ point: str(x.point), why: str(x.why), how: str(x.how) }))
        .filter((x) => x.point)
        .slice(0, 3),
      checks: checks.filter((c) => c.item).slice(0, t.checks.length + 2),
      drills: arr(obj.drills)
        .map((d) => ({ name: str(d.name), how: str(d.how) }))
        .filter((d) => d.name)
        .slice(0, 2),
      compare: str(obj.compare),
    };
  }

  /* ---------- STEP4：振り返り ---------- */
  function goReflect() {
    const f = state.flow;
    el.reflectChips.innerHTML = REFLECT_HINTS.map((h) => `<button class="pick-chip text-xs" data-hint="${escapeHtml(h)}">${escapeHtml(h)}</button>`).join("");
    renderFeel();
    el.adviceBox.classList.toggle("hidden", !f.advice);
    if (f.advice) el.adviceBox.innerHTML = adviceHtml(f.advice);
    showMsg(el.reflectMsg, "");
    updateReflectButtons();
    showFlowStep("flowReflect");
  }

  function renderFeel() {
    const f = state.flow;
    el.feelStars.innerHTML = [1, 2, 3, 4, 5]
      .map((n) => `<button class="feel-star ${n <= f.feel ? "on" : ""}" data-feel="${n}" aria-label="${n}">★</button>`)
      .join("");
  }

  function updateReflectButtons() {
    const f = state.flow;
    const has = el.reflectText.value.trim().length > 0;
    el.adviceBtn.disabled = !has;
    el.adviceBtn.textContent = f.advice ? "書き直したので、もう一度助言をもらう" : "AIに助言をもらう";
    el.saveBtn.textContent = f.advice ? "記録する" : has || f.feedback ? "このまま記録する" : "記録する";
    el.saveBtn.className = f.advice ? "btn-primary btn-cta w-full mt-3" : "btn-ghost w-full mt-3 py-3 font-bold";
  }

  async function requestAdvice() {
    const f = state.flow;
    const t = techById[f.techId];
    const text = el.reflectText.value.trim();
    if (!text) return;
    el.adviceBtn.disabled = true;
    el.adviceBtn.innerHTML = `<span class="inline-flex items-center gap-2"><span class="spinner" style="width:1.1rem;height:1.1rem"></span>AIが考え中…</span>`;
    showMsg(el.reflectMsg, "");

    // 同じ技の最近の振り返りと課題（くり返している悩みに気づいてもらう）
    const history = state.sessions
      .filter((x) => x.techId === f.techId)
      .slice(0, 3)
      .map((x) => `- ${fmtDate(x.ts)}：課題「${x.feedback?.fixes?.map((y) => y.point).join("、") || "なし"}」／振り返り「${(x.reflection || "なし").slice(0, 120)}」`)
      .join("\n");
    const fb = f.feedback;
    const fbText = fb
      ? `要約：${fb.summary}\n直す点：${fb.fixes.map((x) => x.point).join("、") || "なし"}\n△の項目：${fb.checks.filter((c) => c.rating === "△").map((c) => c.item).join("、") || "なし"}`
      : "（今回は動画なし）";

    const prompt = `あなたは経験豊富な卓球のコーチです。選手が練習のあとに書いた振り返りを読んで、原因と対策を助言してください。

# 選手
${profileText()}

# 練習した技：${t.name}
- 技の要点：${t.tips.join(" / ")}
- よくあるミス：${t.mistakes.join(" / ")}
# 今回意識したこと：${f.focus.length ? f.focus.join("、") : "（特になし）"}
# 今日の手ごたえ：${f.feel ? `${f.feel} / 5` : "未入力"}

# 今回の動画へのAIのフィードバック
${fbText}

# 同じ技の最近の記録
${history || "（まだなし）"}

# 選手の振り返り
${text}

# 出力のルール
- causes：振り返りに書かれた問題の、考えられる原因を1〜3個（cause は短く、detail で理由）。動画のフィードバックや最近の記録と結びつけられるときは結びつける
- 同じ悩みをくり返しているときは、そのことに触れる
- actions：次の練習で意識することを2〜3個。練習中に思い出せる短い言葉で
- nextDrill：次にやるとよい練習メニューを1つ（name と how）
- cheer：前向きなひとこと（1文）
- 中学生にも分かるやさしい日本語で`;

    try {
      const { Schema } = requireAI();
      const schema = Schema.object({
        properties: {
          causes: Schema.array({ items: Schema.object({ properties: { cause: Schema.string(), detail: Schema.string() } }) }),
          actions: Schema.array({ items: Schema.string() }),
          nextDrill: Schema.object({ properties: { name: Schema.string(), how: Schema.string() } }),
          cheer: Schema.string(),
        },
      });
      const obj = await callAI([prompt], schema);
      const str = (v) => (typeof v === "string" ? v.trim() : "");
      f.advice = {
        causes: (obj.causes || []).map((c) => ({ cause: str(c.cause), detail: str(c.detail) })).filter((c) => c.cause).slice(0, 3),
        actions: (obj.actions || []).map(str).filter(Boolean).slice(0, 3),
        nextDrill: { name: str(obj.nextDrill?.name), how: str(obj.nextDrill?.how) },
        cheer: str(obj.cheer),
      };
      f.adviceFor = text;
      el.adviceBox.innerHTML = adviceHtml(f.advice);
      el.adviceBox.classList.remove("hidden");
      el.adviceBox.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      console.error(err);
      showMsg(el.reflectMsg, err.message);
    } finally {
      updateReflectButtons();
    }
  }

  async function saveFlow() {
    const f = state.flow;
    if (f.saved) return;
    const before = earnedBadges();
    const reflection = el.reflectText.value.trim();
    const session = {
      id: f.id,
      ts: Date.now(),
      techId: f.techId,
      focus: f.focus,
      feedback: f.feedback,
      score: f.feedback ? scoreOf(f.feedback) : null,
      compared: f.compareUsed,
      reflection,
      feel: f.feel || 0,
      // 振り返りを書き直したあとに助言をもらい直していなければ、古い助言も一緒に残す（読み返したときの参考）
      advice: f.advice,
      cover: f.feedback ? f.cover : null,
      hasFrames: !!(f.feedback && f.saveFrames.length && cloud.user),
    };
    if (!cloud.user) session.local = true;
    el.saveBtn.disabled = true;
    try {
      if (cloud.user) {
        const { doc, setDoc } = cloud.fs;
        const uid = cloud.user.uid;
        const writes = [setDoc(doc(cloud.db, "tt_users", uid, "sessions", session.id), session)];
        if (session.hasFrames) {
          writes.push(setDoc(doc(cloud.db, "tt_users", uid, "frames", session.id), { frames: f.saveFrames, times: f.frameTimes }));
          state.framesCache.set(session.id, f.saveFrames);
        }
        await Promise.all(writes);
      }
    } catch (err) {
      console.error(err);
      // クラウドに書けなくても、この端末には残す（次にログインしたときに送る）
      session.local = true;
      session.hasFrames = false;
    } finally {
      el.saveBtn.disabled = false;
    }
    f.saved = true;
    state.sessions.unshift(session);
    persistLocal();

    // 完了画面
    const after = earnedBadges();
    const newOnes = BADGES.filter((b) => after.has(b.id) && !before.has(b.id));
    el.newBadges.classList.toggle("hidden", !newOnes.length);
    el.newBadges.innerHTML = newOnes.length
      ? `<p class="font-bold mb-2">🎉 バッジを獲得！</p><div class="grid grid-cols-4 gap-2">${newOnes
          .map((b) => `<div class="badge-tile"><div class="badge-icon">${b.icon}</div><p>${b.name}</p></div>`)
          .join("")}</div>`
      : "";
    const t = techById[f.techId];
    const count = state.sessions.filter((x) => x.techId === f.techId).length;
    el.doneNote.textContent =
      `${t.name}の記録は${count}回目です。` + (session.local ? "（ログインしていないので、この端末だけに保存しました）" : "");
    showFlowStep("flowDone");
  }

  /* ==========================================================
   * AI（Firebase AI Logic 経由の Gemini）
   * ========================================================== */
  function requireAI() {
    if (!cloud.ai) {
      throw new Error(
        location.protocol === "file:"
          ? "AIを使うには、公開URL（GitHub Pages）から開いてください"
          : "AIの準備ができていません。通信を確認して、ページを再読み込みしてください"
      );
    }
    return cloud.aiMod;
  }

  async function callAI(parts, schema) {
    requireAI();
    const { getGenerativeModel, ThinkingLevel } = cloud.aiMod;
    if (cloud.appCheck) {
      el.analyzePhase.textContent = "アプリの確認中";
      await cloud.appCheckMod.getToken(cloud.appCheck).catch(() => {});
    }
    const attempts = [
      { label: "AIが分析中", model: MAIN_MODEL, thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } },
      { label: "予備のAIで分析中", model: FAST_MODEL },
    ];
    const failures = [];
    for (const a of attempts) {
      el.analyzePhase.textContent = `${a.label}（${a.model}）`;
      const model = getGenerativeModel(cloud.ai, {
        model: a.model,
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: schema,
          ...(a.thinkingConfig && { thinkingConfig: a.thinkingConfig }),
        },
      });
      try {
        const result = await model.generateContent(parts, { timeout: AI_TIMEOUT_MS });
        const text = result.response.text();
        if (!text) throw new Error("AIから回答が得られませんでした");
        return JSON.parse(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ""));
      } catch (err) {
        console.error(err);
        const msg = String(err?.message || err);
        if (/App Check/i.test(msg)) throw new Error(`アプリの確認（App Check）に失敗しました。ページを再読み込みしてください。\n${msg}`);
        if (/blocked|SAFETY/i.test(msg)) throw new Error("写真がブロックされました。別の動画でお試しください。");
        failures.push(`${a.model}: ${/abort|timeout|timed out/i.test(msg) ? `${AI_TIMEOUT_MS / 1000}秒で時間切れ` : msg}`);
      }
    }
    const detail = failures.join("\n");
    if (/429|quota|RESOURCE_EXHAUSTED/i.test(detail)) {
      throw new Error(`AIが混み合っているか、無料枠の上限に達しています。少し時間をおいてお試しください。\n\n${detail}`);
    }
    throw new Error(`AIが応答しませんでした。少し時間をおいてお試しください。\n\n${detail}`);
  }

  /* ==========================================================
   * アカウント（Firebase Authentication + Cloud Firestore）
   *  - tt_users/{uid}            … プロフィール・ベストの回
   *  - tt_users/{uid}/sessions/* … 練習の記録（一覧に出す小さい情報）
   *  - tt_users/{uid}/frames/*   … 記録ごとの連続写真（開いたときだけ読む）
   * ========================================================== */
  const cloud = {
    ready: false,
    user: null,
    auth: null,
    db: null,
    authMod: null,
    fs: null,
    aiMod: null,
    ai: null,
    appCheck: null,
    appCheckMod: null,
  };

  async function initCloud() {
    const config = window.FIREBASE_CONFIG;
    if (!config) return;
    if (location.protocol === "file:") {
      setAccountUI(null, "ログインとAIは公開URL（GitHub Pages）から開いたときに使えます");
      el.loginBtn.disabled = true;
      return;
    }
    try {
      const [appMod, authMod, fsMod, aiMod] = await Promise.all([
        import(`${FIREBASE_SDK}/firebase-app.js`),
        import(`${FIREBASE_SDK}/firebase-auth.js`),
        import(`${FIREBASE_SDK}/firebase-firestore.js`),
        import(`${FIREBASE_SDK}/firebase-ai.js`),
      ]);
      const app = appMod.initializeApp(config);
      await initAppCheck(app);
      cloud.authMod = authMod;
      cloud.fs = fsMod;
      cloud.aiMod = aiMod;
      cloud.auth = authMod.getAuth(app);
      cloud.db = fsMod.getFirestore(app);
      cloud.ai = aiMod.getAI(app, { backend: new aiMod.GoogleAIBackend() });
      cloud.ready = true;
      authMod.onAuthStateChanged(cloud.auth, async (user) => {
        cloud.user = user;
        setAccountUI(user);
        if (user) {
          closeModal(el.authModal);
          await pullFromCloud().catch((err) => {
            console.error(err);
            setAccountUI(user, "記録を読み込めませんでした（Firestore のルールを確認してください）");
          });
        }
        refreshCurrentTab();
      });
    } catch (err) {
      console.error(err);
      setAccountUI(null, "アカウント機能を読み込めませんでした");
    }
  }

  async function initAppCheck(app) {
    const conf = window.FIREBASE_APP_CHECK;
    if (!conf?.siteKey) return;
    const mod = await import(`${FIREBASE_SDK}/firebase-app-check.js`);
    const Provider = conf.provider === "recaptcha-enterprise" ? mod.ReCaptchaEnterpriseProvider : mod.ReCaptchaV3Provider;
    cloud.appCheckMod = mod;
    cloud.appCheck = mod.initializeAppCheck(app, { provider: new Provider(conf.siteKey), isTokenAutoRefreshEnabled: true });
  }

  function setAccountUI(user, note) {
    el.loginBtn.classList.toggle("hidden", !!user);
    el.logoutBtn.classList.toggle("hidden", !user);
    el.accountName.textContent = user ? user.displayName || user.email : "ログインしていません";
    el.accountNote.textContent = note || (user ? "記録はアカウントに保存され、ほかの端末でも見られます" : "ログインすると記録が保存されます");
    el.accountAvatar.innerHTML = user?.photoURL
      ? `<img src="${escapeHtml(user.photoURL)}" alt="" referrerpolicy="no-referrer" />`
      : escapeHtml((user?.displayName || user?.email || "?").slice(0, 1).toUpperCase());
  }

  async function loginGoogle() {
    const { GoogleAuthProvider, signInWithPopup } = cloud.authMod;
    try {
      await signInWithPopup(cloud.auth, new GoogleAuthProvider());
    } catch (err) {
      if (err.code === "auth/popup-closed-by-user" || err.code === "auth/cancelled-popup-request") return;
      console.error(err);
      authMsg(err.code === "auth/unauthorized-domain" ? "このURLはFirebaseで許可されていません（承認済みドメインに追加してください）" : `ログインに失敗しました（${err.code || err.message}）`);
    }
  }

  async function loginEmail(e) {
    e.preventDefault();
    const { signInWithEmailAndPassword } = cloud.authMod;
    el.authSubmitBtn.disabled = true;
    try {
      await signInWithEmailAndPassword(cloud.auth, el.authEmail.value.trim(), el.authPassword.value);
      el.authPassword.value = "";
    } catch (err) {
      console.error(err);
      authMsg(
        { "auth/invalid-credential": "メールアドレスかパスワードが違います", "auth/invalid-email": "メールアドレスの形式が正しくありません", "auth/too-many-requests": "何度も失敗したため、しばらく待ってからお試しください" }[err.code] ||
          `ログインに失敗しました（${err.code || err.message}）`
      );
    } finally {
      el.authSubmitBtn.disabled = false;
    }
  }

  function authMsg(text) {
    el.authMsg.textContent = text;
    el.authMsg.className = "text-sm mt-2 rounded-lg p-2 msg-error";
  }

  async function logout() {
    if (!confirm("ログアウトしますか？（記録はアカウントに残ります）")) return;
    await cloud.authMod.signOut(cloud.auth);
    // この端末のキャッシュは消す（ログインしていない間の記録は残す）
    state.sessions = state.sessions.filter((x) => x.local);
    state.bests = {};
    state.framesCache.clear();
    persistLocal();
    refreshCurrentTab();
  }

  async function pullFromCloud() {
    const { doc, getDoc, setDoc, collection, getDocs, query, orderBy, limit } = cloud.fs;
    const uid = cloud.user.uid;
    const userRef = doc(cloud.db, "tt_users", uid);
    const [userSnap, sessSnap] = await Promise.all([
      getDoc(userRef),
      getDocs(query(collection(cloud.db, "tt_users", uid, "sessions"), orderBy("ts", "desc"), limit(500))),
    ]);
    const data = userSnap.exists() ? userSnap.data() : null;
    if (data?.profile) {
      state.profile = { ...DEFAULT_PROFILE, ...data.profile };
      saveJSON(LS.profile, state.profile);
      renderProfile();
    }
    const remote = sessSnap.docs.map((d) => d.data());
    const remoteIds = new Set(remote.map((x) => x.id));

    // ログインしていない間に記録したものをアカウントに送る
    const locals = state.sessions.filter((x) => x.local && !remoteIds.has(x.id));
    for (const x of locals) {
      const { local, ...rest } = x;
      await setDoc(doc(cloud.db, "tt_users", uid, "sessions", x.id), rest);
      remote.push(rest);
    }
    state.sessions = remote.sort((a, b) => b.ts - a.ts);
    state.bests = data?.bests || {};
    persistLocal();
    if (!data || locals.length) await pushUserDoc();
  }

  async function pushUserDoc() {
    if (!cloud.user) return;
    const { doc, setDoc } = cloud.fs;
    await setDoc(doc(cloud.db, "tt_users", cloud.user.uid), { profile: state.profile, bests: state.bests, updatedAt: Date.now() }).catch((err) =>
      console.error(err)
    );
  }

  async function loadFrames(id) {
    if (state.framesCache.has(id)) return state.framesCache.get(id);
    if (!cloud.user) return null;
    const { doc, getDoc } = cloud.fs;
    const snap = await getDoc(doc(cloud.db, "tt_users", cloud.user.uid, "frames", id));
    const frames = snap.exists() ? snap.data().frames || [] : [];
    state.framesCache.set(id, frames);
    return frames;
  }

  /* ==========================================================
   * プロフィール
   * ========================================================== */
  const PROFILE_FIELDS = { hand: "pfHand", grip: "pfGrip", rubber: "pfRubber", style: "pfStyle", level: "pfLevel", goal: "pfGoal" };
  function renderProfile() {
    for (const [key, id] of Object.entries(PROFILE_FIELDS)) $(id).value = state.profile[key] ?? "";
  }
  let profileTimer = null;
  function onProfileChange() {
    for (const [key, id] of Object.entries(PROFILE_FIELDS)) state.profile[key] = $(id).value.trim();
    saveJSON(LS.profile, state.profile);
    clearTimeout(profileTimer);
    profileTimer = setTimeout(async () => {
      await pushUserDoc();
      el.profileSaved.textContent = "保存しました";
      setTimeout(() => (el.profileSaved.textContent = ""), 1500);
    }, 600);
  }

  /* ==========================================================
   * イベント
   * ========================================================== */
  function bindEvents() {
    document.querySelectorAll(".tab-btn").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

    // 一覧のどこからでも：記録・技を開く、タブへ移動
    document.addEventListener("click", (e) => {
      const s = e.target.closest("[data-session]");
      if (s) {
        closeModal(el.techModal);
        openSession(s.dataset.session);
        return;
      }
      const tr = e.target.closest("[data-traj]");
      if (tr) return openTrajectory(tr.dataset.traj, tr);
      const t = e.target.closest("[data-tech]");
      if (t) return openTech(t.dataset.tech);
      const g = e.target.closest("[data-goto]");
      if (g) return showTab(g.dataset.goto);
      const c = e.target.closest("[data-chart-tech]");
      if (c) {
        state.chartTech = c.dataset.chartTech;
        renderRecord();
      }
    });

    // モーダルを閉じる
    document.querySelectorAll(".modal-backdrop").forEach((m) => {
      m.addEventListener("click", (e) => {
        if (e.target === m || e.target.closest(".modal-close")) closeModal(m);
      });
    });

    el.startBtn.addEventListener("click", () => startFlow());
    el.flowCloseBtn.addEventListener("click", closeFlow);
    el.recordFilter.addEventListener("change", renderRecord);

    // STEP1
    el.pickTechList.addEventListener("click", (e) => {
      const b = e.target.closest("[data-pick]");
      if (!b) return;
      selectTech(b.dataset.pick);
      el.pickFocusCard.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    el.pickFocusList.addEventListener("change", onFocusChange);
    el.pickNextBtn.addEventListener("click", goVideo);

    // STEP2
    el.videoCapture.addEventListener("change", onVideoChosen);
    el.videoPick.addEventListener("change", onVideoChosen);
    el.videoEl.addEventListener("loadedmetadata", onVideoLoaded);
    el.videoEl.addEventListener("error", () => {
      if (!state.flow?.video) return;
      showMsg(el.videoMsg, "この動画はブラウザで再生できない形式です。別の動画でお試しください");
      el.analyzeBtn.disabled = true;
    });
    el.rangeStart.addEventListener("input", () => {
      setRangeStart(Number(el.rangeStart.value));
      el.videoEl.currentTime = state.flow.start; // つまみに合わせて場面を表示
    });
    el.rangeHereBtn.addEventListener("click", () => setRangeStart(el.videoEl.currentTime));
    el.rangeLenChips.addEventListener("click", (e) => {
      const b = e.target.closest("[data-len]");
      if (b) setRangeLen(Number(b.dataset.len));
    });
    el.analyzeBtn.addEventListener("click", analyze);
    el.skipVideoBtn.addEventListener("click", goReflect);

    // STEP3
    el.toReflectBtn.addEventListener("click", goReflect);
    el.retryAnalyzeBtn.addEventListener("click", runAnalysis);
    el.retrySkipBtn.addEventListener("click", goReflect);

    // STEP4
    el.reflectChips.addEventListener("click", (e) => {
      const b = e.target.closest("[data-hint]");
      if (!b) return;
      const cur = el.reflectText.value.trim();
      el.reflectText.value = cur ? `${cur}。${b.dataset.hint}` : b.dataset.hint;
      updateReflectButtons();
    });
    el.reflectText.addEventListener("input", updateReflectButtons);
    el.feelStars.addEventListener("click", (e) => {
      const b = e.target.closest("[data-feel]");
      if (!b) return;
      state.flow.feel = Number(b.dataset.feel);
      renderFeel();
    });
    el.adviceBtn.addEventListener("click", requestAdvice);
    el.saveBtn.addEventListener("click", saveFlow);
    el.doneBtn.addEventListener("click", () => {
      state.flow = null;
      el.videoEl.removeAttribute("src");
      showTab("home");
    });

    // 記録の詳細
    el.bestBtn.addEventListener("click", toggleBest);
    el.deleteBtn.addEventListener("click", deleteSession);

    // アカウント
    const openAuth = () => {
      if (!cloud.ready) return alert("ログインは公開URL（GitHub Pages）から開いたときに使えます");
      el.authMsg.className = "hidden";
      openModal(el.authModal);
    };
    el.loginBtn.addEventListener("click", openAuth);
    el.homeLoginBtn.addEventListener("click", openAuth);
    el.logoutBtn.addEventListener("click", logout);
    el.authGoogleBtn.addEventListener("click", loginGoogle);
    el.authForm.addEventListener("submit", loginEmail);

    // プロフィール
    Object.values(PROFILE_FIELDS).forEach((id) => {
      $(id).addEventListener("change", onProfileChange);
      $(id).addEventListener("input", onProfileChange);
    });

    initChartHover();
  }

  /* ==========================================================
   * ボールの軌道（3D）。three.js は重いので、ボタンを押したときに読み込む
   * ========================================================== */
  async function openTrajectory(techId, btn) {
    const label = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = "3Dを準備中…";
    try {
      const mod = await import("./trajectory-view.js");
      mod.openTrajectory(techById[techId]);
    } catch (err) {
      console.error(err);
      alert(`3Dの表示を読み込めませんでした。通信を確認してください。\n${err.message}`);
    } finally {
      btn.disabled = false;
      btn.innerHTML = label;
    }
  }

  /* ==========================================================
   * 起動
   * ========================================================== */
  bindEvents();
  renderProfile();
  setAccountUI(null);
  showTab("home");
  initCloud();
  import("./physics.js")
    .then((m) => (state.shotIds = new Set(Object.keys(m.SHOTS))))
    .catch((err) => console.error(err));
})();
