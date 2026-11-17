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
      { who: "opp", tech: "bs-serve", label: "下回転サーブ（バック前に短く）", p0: [-1.6, 0.1, 0.93], speed: 6, spin: [0, -35, 0], target: [-1.2, 0] },
      { who: "me", tech: "chiquita", label: "チキータ", speed: 11, spin: [0, 55, 45], target: [1.0, -0.2], timing: "apex" },
      { who: "opp", tech: "block", label: "ブロック（バック側へ）", speed: 9, spin: [0, 15, 0], target: [0.95, -0.35], timing: "rise" },
      { who: "me", tech: "bh-loop", label: "バックドライブでストレート", speed: 15, spin: [0, 50, 0], target: [1.05, 0.55], timing: "apex" },
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
      { who: "me", tech: "pendulum", label: "順横回転サーブ", p0: [-1.6, 0.45, 0.95], speed: 7, spin: [0, -15, -45], target: [-1.0, 0.3] },
      { who: "opp", tech: "fh-push", form: "fhPush", label: "ツッツキ（フォア側へ流す）", speed: 6, spin: [0, -20, 15], target: [1.0, 0.55], timing: "apex" },
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
      { who: "me", tech: "reverse", label: "巻き込みサーブ（下回転）", p0: [-1.6, 0.0, 0.95], speed: 7, spin: [0, -30, 40], target: [-1.0, 0.0] },
      { who: "opp", tech: "push", label: "ツッツキ（浮いた返球）", speed: 6, spin: [0, -10, -10], target: [1.05, 0.0], timing: "apex" },
      { who: "me", tech: "fh-loop-under", label: "3球目ドライブ", speed: 13, spin: [0, 70, 0], target: [1.05, -0.35], timing: "apex" },
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
      { who: "me", tech: "reverse", label: "巻き込みサーブ（ハーフロング）", p0: [-1.6, 0.0, 0.95], speed: 8, spin: [0, -20, 40], target: [-0.95, 0.0] },
      { who: "opp", tech: "fh-loop-under", label: "ドライブ", speed: 12, spin: [0, 70, 0], target: [1.0, 0.1], timing: "fall" },
      { who: "me", tech: "counter", label: "カウンタードライブ", speed: 18, spin: [0, 50, 0], target: [1.05, 0.35], timing: "rise" },
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
      { who: "me", tech: "pendulum", label: "ロングサーブ（相手のフォアへ）", p0: [-1.6, 0.4, 0.95], speed: 9, spin: [0, 10, -30], target: [-1.2, 0.45] },
      { who: "opp", tech: "fh-loop-top", label: "ドライブ（バック側へ）", speed: 14, spin: [0, 45, 0], target: [1.0, -0.35], timing: "fall" },
      { who: "me", tech: "bh-loop", label: "バックドライブでクロス", speed: 15, spin: [0, 50, 0], target: [1.05, -0.4], timing: "rise" },
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
      { who: "opp", tech: "bs-serve", label: "下回転サーブ（フォア前に短く）", p0: [-1.6, 0.1, 0.93], speed: 6, spin: [0, -35, 0], target: [-1.15, 0.2] },
      { who: "me", tech: "nagashi", form: "fhNagashi", label: "流し", speed: 6.5, spin: [0, -10, -20], target: [1.0, 0.5], timing: "apex" },
      { who: "opp", tech: "push", label: "ツッツキ（バック側へ深く）", speed: 6, spin: [0, -20, 0], target: [1.1, -0.4], timing: "apex" },
      { who: "me", tech: "fh-loop-under", label: "回り込んでフォア強打", speed: 15, spin: [0, 60, 0], target: [1.05, -0.3], timing: "apex" },
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
      { who: "opp", tech: "bs-serve", label: "下回転サーブ（ハーフロング）", p0: [-1.6, 0.3, 0.93], speed: 7, spin: [0, -30, 0], target: [-1.2, 0.3] },
      { who: "me", tech: "chori", form: "fhChori", label: "ちょりドラ", speed: 10, spin: [0, 50, 0], target: [1.0, 0.2], timing: "apex" },
      { who: "opp", tech: "block", label: "ブロック", speed: 10, spin: [0, 20, 0], target: [1.0, 0.25], timing: "rise" },
      { who: "me", tech: "fh-loop-top", label: "1歩下がって中陣ドライブ", speed: 16, spin: [0, 55, 0], target: [1.05, 0.3], timing: "late" },
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
