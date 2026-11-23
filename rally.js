/* ==========================================================
   組み立て（サーブから3〜4球目までのラリー）の計算
   ----------------------------------------------------------
   - 打球はそれぞれ「打つ人から見た座標」（自分のコートが x<0、相手の方へ +x に打つ）で計算する
   - 相手の打球は、台の真ん中を中心に180°回して（x→-x、y→-y）、自分から見た座標（＝画面の座標）にする
   - 前の打球が相手コートで弾んだあと、決めたタイミング（上がりっぱな・頂点・落ち際・中陣）の位置を、次の打球の打つ位置にする
   参考：わったさん（YouTube）の「組み立て」の動画。やなぎ・流し・ちょりドラは映像からの推測
   ========================================================== */
import { TABLE, simulate, solveShot, contactRacket } from "./physics.js";

// 打つ人から見た座標 ⇔ 画面（自分）の座標
const flipP = (p) => [-p[0], -p[1], p[2]];
const flipW = (w) => [-w[0], -w[1], w[2]];

/* 打球の決め方
   who：me（自分）／opp（相手）
   tech：技（3Dの体の動きと、図鑑の名前に使う）、form：体の動き（technique と違うときだけ）
   speed（m/秒）、spin：[x, y, z] 回転/秒（打つ人から見た向き）、target：最初のバウンドの場所（打つ人から見た座標。サーブは自分のコート）
   p0：最初の打球（サーブ）の打つ位置。2球目からは前の球から決まる
   timing：前の球をいつ打つか（rise＝上がりっぱな、apex＝頂点、fall＝頂点を過ぎたところ、late＝台から下がって中陣） */
export const PATTERNS = [
  {
    id: "chiquita-straight",
    name: "チキータ → バックストレート",
    who: "receive",
    tips: [
      "チキータのときは、ボールの位置まで、できるだけ体を台の中に入れる",
      "ストレートへの攻撃は、打点を上げると効果的",
    ],
    shots: [
      { who: "opp", tech: "bs-serve", short: "下回転サーブ", label: "下回転サーブ（バック前に短く）", p0: [-1.6, 0.1, 0.93], speed: 6, spin: [0, -35, 0], target: [-1.2, 0] },
      { who: "me", tech: "chiquita", label: "チキータ", speed: 11, spin: [0, 55, 45], target: [1.0, -0.2], timing: "apex" },
      { who: "opp", tech: "block", short: "ブロック", label: "ブロック（バック側へ）", speed: 9, spin: [0, 15, 0], target: [0.95, -0.35], timing: "rise" },
      { who: "me", tech: "bh-loop", short: "バックストレート", label: "バックドライブでストレート", speed: 15, spin: [0, 50, 0], target: [1.05, 0.55], timing: "apex" },
    ],
  },
  {
    id: "pendulum-yanagi",
    name: "順横サーブ → やなぎ",
    who: "serve",
    tips: [
      "わったさんの大好きな技術。上のレベルになるほど質が高い",
      "自分で回転をかけるのではなく、相手の回転を利用する意識で",
      "やなぎ：フォア側の遠い球に大きく踏み込み、腕を伸ばして、ラケットを低く寝かせたまま横に払う（映像からの推測）",
    ],
    shots: [
      { who: "me", tech: "pendulum", short: "順横サーブ", label: "順横回転サーブ", p0: [-1.6, 0.45, 0.95], speed: 7, spin: [0, -15, -45], target: [-1.0, 0.3] },
      { who: "opp", tech: "fh-push", form: "fhPush", short: "ツッツキ", label: "ツッツキ（フォア側へ流す）", speed: 6, spin: [0, -20, 15], target: [1.0, 0.55], timing: "apex" },
      { who: "me", tech: "yanagi", form: "fhYanagi", label: "やなぎ", speed: 9, spin: [0, 15, -35], target: [1.0, 0.3], timing: "apex" },
    ],
  },
  {
    id: "reverse-updown",
    name: "上下回転の巻き込みサーブ",
    who: "serve",
    tips: [
      "最短で勝つなら、とにかく巻き込みサーブ",
      "初中級者が相手なら、順横回転よりもサービスエースが取りやすい",
      "同じフォームで上回転と下回転を出し分ける。浮いたレシーブを3球目で打つ",
    ],
    shots: [
      { who: "me", tech: "reverse", short: "巻き込みサーブ", label: "巻き込みサーブ（下回転）", p0: [-1.6, 0.0, 0.95], speed: 7, spin: [0, -30, 40], target: [-1.0, 0.0] },
      { who: "opp", tech: "push", short: "ツッツキ", label: "ツッツキ（浮いた返球）", speed: 6, spin: [0, -10, -10], target: [1.05, 0.0], timing: "apex" },
      { who: "me", tech: "fh-loop-under", short: "ドライブ", label: "3球目ドライブ", speed: 13, spin: [0, 70, 0], target: [1.05, -0.35], timing: "apex" },
    ],
  },
  {
    id: "halflong-counter",
    name: "ハーフロング → カウンター",
    who: "serve",
    tips: [
      "相手が右利きなら巻き込みサーブ、左利きなら順横サーブが良い",
      "ハーフロング（台からぎりぎり出るくらいの長さ）で、相手にドライブさせる",
      "カウンターは上から押さえつけないと、相手の回転に負ける",
    ],
    shots: [
      { who: "me", tech: "reverse", short: "ハーフロング", label: "巻き込みサーブ（ハーフロング）", p0: [-1.6, 0.0, 0.95], speed: 8, spin: [0, -20, 40], target: [-0.95, 0.0] },
      { who: "opp", tech: "fh-loop-under", label: "ドライブ", speed: 12, spin: [0, 70, 0], target: [1.0, 0.1], timing: "fall" },
      { who: "me", tech: "counter", short: "カウンター", label: "カウンタードライブ", speed: 18, spin: [0, 50, 0], target: [1.05, 0.35], timing: "rise" },
    ],
  },
  {
    id: "fhlong-bhcross",
    name: "フォアロング → バッククロス",
    who: "serve",
    tips: [
      "フォアへのロングサーブは、特にフォア主体の選手に効く",
      "相手を左右に振り回せれば、試合を有利に運べる",
    ],
    shots: [
      { who: "me", tech: "pendulum", short: "ロングサーブ", label: "ロングサーブ（相手のフォアへ）", p0: [-1.6, 0.4, 0.95], speed: 9, spin: [0, 10, -30], target: [-1.2, 0.45] },
      { who: "opp", tech: "fh-loop-top", short: "ドライブ", label: "ドライブ（バック側へ）", speed: 14, spin: [0, 45, 0], target: [1.0, -0.35], timing: "fall" },
      { who: "me", tech: "bh-loop", short: "バッククロス", label: "バックドライブでクロス", speed: 15, spin: [0, 50, 0], target: [1.05, -0.4], timing: "rise" },
    ],
  },
  {
    id: "nagashi-pivot",
    name: "流し → 回り込み強打",
    who: "receive",
    tips: [
      "台上に自信がある人におすすめ",
      "流し：台上の短い球を、フォアで横に払うように流して返す（映像からの推測）",
      "返ってきた球を回り込んで、フォアで強く打つ",
    ],
    shots: [
      { who: "opp", tech: "bs-serve", short: "下回転サーブ", label: "下回転サーブ（フォア前に短く）", p0: [-1.6, 0.1, 0.93], speed: 6, spin: [0, -35, 0], target: [-1.15, 0.2] },
      { who: "me", tech: "nagashi", form: "fhNagashi", label: "流し", speed: 6.5, spin: [0, -10, -20], target: [1.0, 0.5], timing: "apex" },
      { who: "opp", tech: "push", short: "ツッツキ", label: "ツッツキ（バック側へ深く）", speed: 6, spin: [0, -20, 0], target: [1.1, -0.4], timing: "apex" },
      { who: "me", tech: "fh-loop-under", short: "回り込み強打", label: "回り込んでフォア強打", speed: 15, spin: [0, 60, 0], target: [1.05, -0.3], timing: "apex" },
    ],
  },
  {
    id: "chori-middrive",
    name: "ちょりドラ → 中陣ドライブ",
    who: "receive",
    tips: [
      "地味に見えて、わったさんのプレーを支える大事な技術",
      "ちょりドラのあと1歩下がるのが、5球目を安定させるポイント",
      "ちょりドラ：台の近くで、短め〜ハーフロングの球を小さな振りでドライブする（映像からの推測）",
    ],
    shots: [
      { who: "opp", tech: "bs-serve", short: "下回転サーブ", label: "下回転サーブ（ハーフロング）", p0: [-1.6, 0.3, 0.93], speed: 7, spin: [0, -30, 0], target: [-1.2, 0.3] },
      { who: "me", tech: "chori", form: "fhChori", label: "ちょりドラ", speed: 10, spin: [0, 50, 0], target: [1.0, 0.2], timing: "apex" },
      { who: "opp", tech: "block", label: "ブロック", speed: 10, spin: [0, 20, 0], target: [1.0, 0.25], timing: "rise" },
      { who: "me", tech: "fh-loop-top", short: "中陣ドライブ", label: "1歩下がって中陣ドライブ", speed: 16, spin: [0, 55, 0], target: [1.05, 0.3], timing: "late" },
    ],
  },
];

/** 前の打球（打つ人から見た座標の軌道）から、相手が打つ位置と時刻を探す */
function hitPoint(sim, timing) {
  const pts = sim.points;
  const b = sim.bounces.find((x) => x.p[0] > 0); // 相手コートでのバウンド
  if (!b) return null;
  // バウンドのあと、次のバウンド（または床）までの間
  const next = sim.bounces.find((x) => x.t > b.t + 1e-6);
  const tEnd = next ? next.t : Infinity;
  const after = pts.filter((p) => p.t > b.t + 1e-6 && p.t < tEnd && p.p[2] > 0.55);
  if (after.length < 3) return null;
  const apexI = after.reduce((m, p, i) => (p.p[2] > after[m].p[2] ? i : m), 0);
  const apex = after[apexI];
  let pick;
  if (timing === "rise") pick = after[Math.max(1, Math.round(apexI * 0.4))];
  else if (timing === "apex") pick = apex;
  else {
    // 頂点を過ぎて、fall：頂点より12cm下がったところ、late：台の端から1m近く下がった中陣（ボールの高さ0.8mくらいまで）
    const drop = timing === "late" ? Math.max(0.05, apex.p[2] - 0.8) : 0.12;
    pick = after.slice(apexI).find((p) => p.p[2] <= apex.p[2] - drop) || after.at(-1);
  }
  return { p: pick.p, t: pick.t };
}

/**
 * パターンのラリーを計算する
 * 返り値の shots：{ ...定義, own：{p0, v0, spin}（打つ人から見た座標）, sim（画面の座標の軌道。次の人が打つ時刻まで）, t0（ラリーの中で打つ時刻）, ok }
 */
export function buildRally(pattern) {
  const out = [];
  let t0 = 0;
  let prev = null; // { simOwn, who }
  for (const def of pattern.shots) {
    let p0own;
    if (!prev) p0own = def.p0;
    else {
      const hp = hitPoint(prev.simOwn, def.timing || "apex");
      if (!hp) break; // 前の球が入らなかった
      // 前の打球（前の人から見た座標）→ 画面 → この人から見た座標
      const world = prev.who === "opp" ? flipP(hp.p) : hp.p;
      p0own = def.who === "opp" ? flipP(world) : world;
      t0 = prev.t0 + hp.t;
      // 前の球の軌道は、ここで切る
      out.at(-1).sim = cut(out.at(-1).sim, hp.t);
    }
    const solved = solveShot({ p0: p0own, speed: def.speed, spin: def.spin, target: def.target });
    const w0 = def.spin.map((n) => n * 2 * Math.PI);
    const simOwn = simulate(p0own, solved.v0, w0, { maxT: 2.5 });
    const sim = def.who === "opp" ? flipSim(simOwn) : simOwn;
    const okBounce = def.target[0] < 0 ? simOwn.bounces.length >= 2 && simOwn.bounces[1].p[0] > 0 : simOwn.bounces[0]?.p[0] > 0;
    out.push({
      ...def,
      own: { p0: p0own, v0: solved.v0, spin: def.spin },
      contact: contactRacket(solved.v0, def.spin),
      sim,
      t0,
      ok: !simOwn.net && okBounce,
    });
    prev = { simOwn, who: def.who, t0 };
  }
  // 最後の打球は、相手コートで弾んだ少しあとで止める
  const last = out.at(-1);
  if (last) {
    const b = last.sim.bounces.find((x) => (last.who === "me" ? x.p[0] > 0 : x.p[0] < 0));
    if (b) last.sim = cut(last.sim, b.t + 0.12);
  }
  return out;
}

function cut(sim, t) {
  const points = sim.points.filter((p) => p.t <= t);
  return { ...sim, points, bounces: sim.bounces.filter((b) => b.t <= t) };
}

function flipSim(sim) {
  return {
    ...sim,
    points: sim.points.map((p) => ({ t: p.t, p: flipP(p.p), w: flipW(p.w) })),
    bounces: sim.bounces.map((b) => ({ t: b.t, p: flipP(b.p) })),
  };
}

/* ----------------------------------------------------------
   上から見た図解（SVG）
   - 自分のコートが下、相手のコートが上。打つ位置に番号、打球の線、バウンドの印
   - t：ラリーの中の時刻（ここまでの線を描く。Infinity ならすべて）
   - mirror：左利きのとき -1（左右を反転）
   ---------------------------------------------------------- */
const COLORS = { me: { line: "#fbbf24", dot: "#ff7a1a" }, opp: { line: "#7dd3fc", dot: "#0ea5e9" } };
const CIRC = ["1", "2", "3", "4", "5", "6"];

export function shortLabel(shot) {
  return shot.short || String(shot.label).split("（")[0];
}

export function rallyDiagram(shots, { t = Infinity, mirror = 1, labels = true, ball = true } = {}) {
  const S = 100; // 1m = 100
  const W = TABLE.W * S, L = TABLE.L * S;
  const mx = 72, my = 78;
  const vw = W + mx * 2, vh = L + my * 2;
  // 台より後ろは縮めて描く（中陣で打つ位置も入るように）
  const depth = (x) => {
    const a = Math.abs(x), half = TABLE.L / 2;
    const d = a <= half ? a : half + (a - half) * 0.5;
    return Math.sign(x) * d;
  };
  const px = (p) => mx + W / 2 - p[1] * S * mirror;
  const py = (p) => my + L / 2 - depth(p[0]) * S;
  const pt = (p) => `${px(p).toFixed(1)},${py(p).toFixed(1)}`;

  let svg = `<svg viewBox="0 0 ${vw} ${vh}" xmlns="http://www.w3.org/2000/svg" class="rally-svg">
    <defs>
      <marker id="arMe" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${COLORS.me.line}"/></marker>
      <marker id="arOpp" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${COLORS.opp.line}"/></marker>
    </defs>
    <rect x="${mx}" y="${my}" width="${W}" height="${L}" rx="4" fill="#1d4ed8" stroke="#fff" stroke-width="2"/>
    <line x1="${mx + W / 2}" y1="${my}" x2="${mx + W / 2}" y2="${my + L}" stroke="#ffffff" stroke-opacity="0.45" stroke-width="1"/>
    <line x1="${mx - 10}" y1="${my + L / 2}" x2="${mx + W + 10}" y2="${my + L / 2}" stroke="#fff" stroke-width="2.5" stroke-dasharray="7 5"/>
    <text x="${mx + W / 2}" y="${vh - 8}" text-anchor="middle" class="rally-side">自分</text>
    <text x="${mx + W / 2}" y="16" text-anchor="middle" class="rally-side">相手</text>`;

  let ballPos = null;
  shots.forEach((s, i) => {
    if (t < s.t0) return;
    const local = t - s.t0;
    const pts = s.sim.points.filter((p) => p.t <= local);
    const done = local >= s.sim.points.at(-1).t;
    const c = COLORS[s.who];
    if (pts.length > 1) {
      svg += `<polyline points="${pts.map((p) => pt(p.p)).join(" ")}" fill="none" stroke="${c.line}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"${done ? ` marker-end="url(#${s.who === "me" ? "arMe" : "arOpp"})"` : ""}/>`;
    }
    for (const b of s.sim.bounces) {
      if (b.t > local) continue;
      svg += `<circle cx="${px(b.p).toFixed(1)}" cy="${py(b.p).toFixed(1)}" r="4" fill="none" stroke="${c.line}" stroke-width="2"/>`;
    }
    if (!done || i === shots.length - 1) ballPos = pts.at(-1)?.p || s.sim.points[0].p;
  });
  // 打つ位置の番号（線の上に重ねる）。近くに前の番号があるときは、重ならないようにずらす
  const placed = [];
  const labelsAt = [];
  shots.forEach((s, i) => {
    if (t < s.t0 && i > 0) return;
    const p = s.sim.points[0].p;
    let x = px(p), y = py(p);
    while (placed.some((q) => Math.hypot(q[0] - x, q[1] - y) < 20)) x += x < vw / 2 ? -20 : 20;
    placed.push([x, y]);
    const c = COLORS[s.who];
    svg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="11" fill="${c.dot}" stroke="#fff" stroke-width="2"/>
      <text x="${x.toFixed(1)}" y="${(y + 4.5).toFixed(1)}" text-anchor="middle" class="rally-num">${CIRC[i]}</text>`;
    if (labels) {
      // 台の外側（左右の空いている方）に技の名前を書く。近くに名前があれば上下にずらす
      const text = shortLabel(s);
      const tw = text.length * 12 + 4; // 文字の幅（だいたい）
      let right = x >= vw / 2;
      if (right && x + 15 + tw > vw) right = false; // 右にはみ出すなら左へ
      if (!right && x - 15 - tw < 0) right = true; // 左にはみ出すなら右へ
      let ly = y + 4;
      while (labelsAt.some((q) => q[0] === right && Math.abs(q[1] - ly) < 14)) ly += y < vh / 2 ? 15 : -15;
      labelsAt.push([right, ly]);
      svg += `<text x="${(x + (right ? 15 : -15)).toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${right ? "start" : "end"}" class="rally-label">${text}</text>`;
    }
  });
  if (ball && ballPos && Number.isFinite(t)) {
    svg += `<circle cx="${px(ballPos).toFixed(1)}" cy="${py(ballPos).toFixed(1)}" r="6" fill="#fff" stroke="#0a1020" stroke-width="1.5"/>`;
  }
  return svg + "</svg>";
}
