/* ==========================================================
   ボールの軌道を3Dで見る画面（three.js）
   - physics.js で計算した軌道を、台・ネット・選手と一緒に再生する
   - 選手は技ごとにスイングし、打った瞬間にラケットがボールの位置に来る
   - 計算はすべて右利きで行い、左利きのときは表示するときに左右を反転する（物理は左右対称なので、そのまま正しい軌道になる）
   - 「インパクト」視点：打球の瞬間を拡大・超スローにして、ラケットの角度とこする向きを見せる
   - スロー再生、視点の切り替え、回転なしの軌道との比較、動画として保存
   ========================================================== */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SHOTS, TABLE, solveShot, simulate, contactRacket } from "./physics.js";

// 物理の座標（x:長さ, y:横, z:高さ）→ three.js の座標（y が上）
// 左利きのときは MIRROR = -1 にして、横方向（物理の y）を反転して表示する
let MIRROR = 1;
const toV3 = (p) => new THREE.Vector3(p[0], p[2], -p[1] * MIRROR);
// 回転の軸（軸性ベクトル）は、鏡に映すと向きが逆になる
const toAxis = (w) => toV3(w).multiplyScalar(MIRROR);
// 説明の文の「右」「左」を入れかえる（左利き用）
export const swapLR = (text) =>
  String(text).replace(/左右/g, "\0").replace(/[右左]/g, (c) => (c === "右" ? "左" : "右")).replace(/\0/g, "左右");
const lr = (text) => (MIRROR < 0 ? swapLR(text) : text);

/* ---------- 小さなベクトル計算（物理の座標のまま使う） ---------- */
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lerp = (a, b, k) => a + (b - a) * k;
const lerpV = (a, b, k) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const smooth = (k) => k * k * (3 - 2 * k);
// 時刻 t のときの値を、[時刻, 値] の表から読む（間はなめらかにつなぐ）
function keyed(keys, t) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, v0] = keys[i - 1], [t1, v1] = keys[i];
      return lerp(v0, v1, smooth((t - t0) / (t1 - t0)));
    }
  }
  return keys.at(-1)[1];
}
// 2本の骨（太もも＋すね、上腕＋前腕）の曲がる関節の位置を求める
function solveJoint(a, c, l1, l2, poleDir) {
  let d = sub(c, a);
  const dist = clamp(len(d), 0.05, (l1 + l2) * 0.999);
  const dir = unit(d);
  const x = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  let p = sub(poleDir, mul(dir, dot(poleDir, dir)));
  p = len(p) < 1e-6 ? [0, 0, -1] : unit(p);
  return add(add(a, mul(dir, x)), mul(p, h));
}
// ベクトル v を、軸 k（単位ベクトル）のまわりに ang ラジアン回す
function rotAround(v, k, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
}
// 時刻 t のときのベクトルを、[時刻, ベクトル] の表から読む
const keyedV = (keys, t) => [0, 1, 2].map((i) => keyed(keys.map(([kt, v]) => [kt, v[i]]), t));
// a から n に垂直な成分だけを取り出す
const perp = (a, n) => sub(a, mul(n, dot(a, n)));

// 腕が届かないときは、手をとどく所まで引き寄せる
function reach(a, c, maxLen) {
  const d = sub(c, a);
  const l = len(d);
  return l <= maxLen ? c : add(a, mul(d, maxLen / l));
}

const VIEWS = {
  back: { label: "後ろ", pos: [-4.5, 2.3, -1.2], target: [0.0, 0.8, 0] },
  side: { label: "横", pos: [-1.1, 1.25, 3.5], target: [-1.0, 0.9, 0] },
  top: { label: "上", pos: [-0.4, 4.8, 0.01], target: [-0.4, 0.76, 0] },
  front: { label: "相手側", pos: [3.4, 1.6, 0.0], target: [-0.6, 0.85, 0] },
  impact: { label: "インパクト" }, // 打つ瞬間の拡大（位置は技ごとに計算）
  grip: { label: "持ち方" }, // ラケットを持つ手を追いかける
  eye: { label: "自分視点" }, // 選手の目の高さから見る
};
const RATES = [
  { label: "1/4", value: 0.25 },
  { label: "1/2", value: 0.5 },
  { label: "等速", value: 1 },
];
const T_START = -0.75; // 打つ0.75秒前から再生する（相手の球が来る／トス）
const END_PAUSE = 0.9; // 最後まで行ったら少し止まってからくり返す（秒）
const MAX_VISUAL_SPIN = 2.5; // 画面上のボールの回転は、見える速さ（回転/秒）までにおさえる
const IMPACT_SLOW = 0.1; // インパクト視点では、打つ瞬間の前後をさらに遅くする
const BALL_SCALE = 1.6;
const GRIP = 0.12; // ラケットの真ん中から、にぎる所までの長さ // 実物は直径4cm。見やすいように少し大きく描く

export const hasShot = (techId) => !!SHOTS[techId];

let current = null; // 開いている画面（1つだけ）

/** 図鑑の技を開く */
export function openTrajectory(tech, { lefty = false } = {}) {
  const shot = SHOTS[tech.id];
  if (!shot) return;
  closeTrajectory();
  MIRROR = lefty ? -1 : 1;
  current = new TrajectoryView({ title: `${tech.icon} ${tech.name}`, shot: { ...shot, form: FORM_BY_TECH[tech.id] }, solved: solveShot(shot) });
}

/**
 * 打球を自分で決めて開く（スマホのスイングから作った打球など）
 * shot: { p0, v0, spin, stroke, note }
 */
export function openCustomShot({ title, shot, contact = null, startView = "back", lefty = false }) {
  closeTrajectory();
  MIRROR = lefty ? -1 : 1;
  const w0 = shot.spin.map((n) => n * 2 * Math.PI);
  const solved = {
    v0: shot.v0,
    withSpin: simulate(shot.p0, shot.v0, w0),
    noSpin: simulate(shot.p0, shot.v0, w0, { spin: false }),
  };
  current = new TrajectoryView({ title, shot, solved, startView, contact });
}

/** 動作確認用：開いている画面 */
export const _currentView = () => current;

export function closeTrajectory() {
  current?.dispose();
  current = null;
}

/* ==========================================================
 * 選手（マネキンのような簡単な人の形。右利き）
 * ========================================================== */

/* ==========================================================
 * 関節で決める動き（右利き。左利きは表示のときに左右反転する）
 * ----------------------------------------------------------
 * 技ごとに「構え・引き・打球・振り抜き」の姿勢を関節の角度で決め、その間をなめらかな曲線でつなぐ。
 *  - yaw：体のひねり（度。プラス＝左へ回る）、lean：前傾（度）、crouch：沈み込み（m）
 *  - shift：重心の移動 [前, 左]（m。左がマイナス＝利き手側の足へ）
 *  - up：上腕の向き [左右, 上下]（度）、fore：前腕の向き [左右, 上下]（度）
 *      左右：0＝体の正面、マイナス＝利き手側（右）、プラス＝反対側（左）。上下：0＝水平、マイナス＝下
 *  - cock：手首の角度（ラケットの先を前腕からどれだけ曲げるか。度）、pro：前腕のひねり（打つ瞬間からの差。度）
 * 打つ瞬間は、前腕のひねりと手首を計算で調整して、ラケット面を物理計算の向きにぴったり合わせる。
 * 参考：卓球レポート（バタフライ）「ようこそ卓球 基本技術編」「基本のバックハンド」の連続写真
 * ========================================================== */
const P = (yaw, lean, crouch, shift, up, fore, cock, pro = 0) => ({ yaw, lean, crouch, shift, up, fore, cock, pro });
const FORMS = {
  // フォアロング：腰を小さくひねり、ラケットは腰の横（体より後ろに引かない）、体の斜め前で軽く押す、斜め上へ小さく
  fhLong: {
    stance: "fh", tBack: -0.22, tFollow: 0.15,
    ready: P(0, 18, 0.05, [0, 0], [-35, -55], [-5, 0], 20),
    back: P(-25, 18, 0.06, [-0.02, -0.04], [-70, -62], [-45, -15], 15, -10),
    contact: P(-5, 18, 0.05, [0.02, -0.01], [-40, -45], [-5, 10], 15),
    follow: P(18, 16, 0.04, [0.04, 0.03], [-15, -20], [35, 50], 10, 10),
  },
  // フォアドライブ：腰を大きくひねり、利き手側の足に重心をかけてひざの高さまで低く引く → 床を蹴って斜め上へ → 反対の足へ重心、頭の高さへ
  fhDrive: {
    stance: "fh", tBack: -0.28, tFollow: 0.18,
    ready: P(0, 22, 0.06, [0, 0], [-35, -55], [-5, 0], 20),
    back: P(-45, 26, 0.13, [-0.03, -0.09], [-80, -78], [-60, -70], 5, -15),
    contact: P(-10, 22, 0.07, [0, -0.02], [-45, -50], [-10, 20], 10),
    follow: P(32, 14, 0.03, [0.05, 0.09], [-5, 30], [40, 85], 0, 15),
  },
  // カウンター：ドライブを小さく、早く
  fhCounter: {
    stance: "fh", tBack: -0.2, tFollow: 0.14,
    ready: P(0, 22, 0.06, [0, 0], [-35, -55], [-5, 0], 20),
    back: P(-30, 22, 0.08, [-0.02, -0.05], [-70, -55], [-40, -10], 10, -10),
    contact: P(-8, 22, 0.06, [0.01, -0.01], [-40, -40], [-5, 15], 10),
    follow: P(22, 18, 0.04, [0.04, 0.05], [-15, -5], [30, 50], 5, 10),
  },
  // フォアツッツキ：面を開くように手首を小さく曲げ、体より後ろに引かず、ひじを伸ばしながら斜め下へ
  fhPush: {
    stance: "fh", stepIn: true, tBack: -0.18, tFollow: 0.13,
    ready: P(0, 32, 0.07, [0, 0], [-30, -45], [0, 10], 25),
    back: P(-8, 34, 0.08, [0, -0.04], [-38, -42], [-10, 22], 30, 10),
    contact: P(-3, 36, 0.08, [0.03, -0.06], [-30, -32], [5, 2], 20),
    follow: P(0, 37, 0.08, [0.05, -0.07], [-25, -22], [12, -15], 15),
  },
  // ストップ：ツッツキをさらに小さく、止めるように
  fhStop: {
    stance: "fh", stepIn: true, tBack: -0.15, tFollow: 0.1,
    ready: P(0, 32, 0.07, [0, 0], [-30, -45], [0, 10], 25),
    back: P(-4, 34, 0.08, [0, -0.04], [-33, -40], [-4, 15], 25, 5),
    contact: P(-2, 36, 0.08, [0.03, -0.06], [-30, -34], [3, 6], 20),
    follow: P(-1, 36, 0.08, [0.04, -0.06], [-28, -30], [6, 2], 18),
  },
  // フリック：台上で前にはじく
  fhFlick: {
    stance: "fh", stepIn: true, tBack: -0.16, tFollow: 0.13,
    ready: P(0, 32, 0.07, [0, 0], [-30, -45], [0, 10], 25),
    back: P(-12, 34, 0.08, [0, -0.04], [-40, -42], [-20, -8], 5, -10),
    contact: P(-4, 35, 0.08, [0.03, -0.05], [-30, -32], [5, 5], 15),
    follow: P(8, 33, 0.07, [0.05, -0.04], [-20, -18], [25, 35], 25, 10),
  },
  // バック打ち：胸の前に構え、手首を内側に曲げておなかの前に引き寄せ、面を立てて前にはじき、顔の高さへ前上に
  bhLong: {
    stance: "bh", tBack: -0.2, tFollow: 0.15,
    ready: P(0, 12, 0.03, [0, 0], [-15, -50], [45, 10], 25),
    back: P(10, 14, 0.04, [-0.01, 0], [-10, -55], [75, -20], 55, -10),
    contact: P(0, 12, 0.03, [0.02, 0], [-15, -40], [20, 5], 15),
    follow: P(-8, 10, 0.02, [0.03, 0], [-20, -15], [-5, 45], 0, 10),
  },
  // ブロック：振らずに当てる。ほとんど動かさない
  bhBlock: {
    stance: "bh", tBack: -0.15, tFollow: 0.1,
    ready: P(0, 15, 0.04, [0, 0], [-15, -50], [40, 5], 20),
    back: P(3, 15, 0.04, [0, 0], [-15, -48], [40, 3], 22),
    contact: P(0, 15, 0.04, [0.01, 0], [-15, -45], [28, 5], 18),
    follow: P(-2, 15, 0.04, [0.02, 0], [-15, -42], [20, 8], 15),
  },
  // バックドライブ：前傾を深く、手首を大きくひねって面をかぶせ、ひじを前に出して支点に、手首を利かせて斜め上へ
  bhDrive: {
    stance: "bh", tBack: -0.25, tFollow: 0.17,
    ready: P(0, 22, 0.05, [0, 0], [-15, -50], [45, 5], 25),
    back: P(12, 28, 0.08, [-0.01, 0], [-5, -60], [60, -50], 70, -15),
    contact: P(0, 25, 0.06, [0.02, 0], [-15, -40], [25, 10], 15),
    follow: P(-12, 18, 0.03, [0.04, 0], [-20, 0], [10, 65], -20, 15),
  },
  // バックツッツキ：面を上に向けて自分の方へ小さく引き寄せ、前傾を深め、ひじを伸ばしながら斜め下へ
  bhPush: {
    stance: "bh", stepIn: true, tBack: -0.18, tFollow: 0.13,
    ready: P(0, 30, 0.06, [0, 0], [-10, -45], [40, 15], 25),
    back: P(5, 33, 0.07, [0, -0.03], [-5, -45], [55, 25], 30, 10),
    contact: P(0, 35, 0.07, [0.03, -0.05], [-10, -30], [25, 0], 20),
    follow: P(-3, 36, 0.07, [0.05, -0.06], [-15, -20], [10, -15], 15),
  },
  // チキータ：ひじを高く上げ、手首を深く曲げてラケットの先を下に、手首を解放して振り抜く
  bhChiquita: {
    stance: "bh", stepIn: true, tBack: -0.2, tFollow: 0.14,
    ready: P(0, 32, 0.07, [0, 0], [-10, -45], [40, 15], 25),
    back: P(10, 36, 0.08, [0, -0.04], [-20, -12], [95, -55], 95, -20),
    contact: P(0, 35, 0.08, [0.03, -0.05], [-15, -18], [35, -15], 35),
    follow: P(-15, 30, 0.07, [0.05, -0.04], [-25, 0], [-25, 30], -15, 20),
  },
  // サーブ：体はフォア側を向いて前傾、トスで上体を軽く起こし、ラケットは胸の高さに引き、重心を移しながら後ろから前へ
  serve: {
    stance: "serve", heading: -40, tBack: -0.3, tFollow: 0.16,
    ready: P(0, 28, 0.06, [0, 0], [0, -50], [30, 5], 20),
    toss: P(-5, 14, 0.04, [0, -0.02], [-15, -45], [15, 5], 25), // トスを上げる（上体を起こす）
    back: P(-15, 22, 0.06, [-0.02, -0.07], [-45, -10], [-5, 15], 30, 10),
    contact: P(0, 28, 0.07, [0.01, 0.01], [10, -35], [40, 0], 20),
    follow: P(15, 28, 0.06, [0.03, 0.07], [30, -55], [60, -25], 15, -5),
  },
  // YG・巻き込みサーブ：ラケットを体の内側（左）から外側（右）へ振る
  serveOut: {
    stance: "serve", heading: -40, tBack: -0.3, tFollow: 0.16,
    ready: P(0, 28, 0.06, [0, 0], [0, -50], [30, 5], 20),
    toss: P(-5, 14, 0.04, [0, -0.02], [-15, -45], [15, 5], 25),
    back: P(10, 24, 0.06, [-0.01, 0.03], [0, -60], [95, -5], 40, -10), // 腕を胸の近くにたたむ
    contact: P(0, 28, 0.07, [0.01, 0], [0, -25], [40, 5], 20),
    follow: P(-12, 28, 0.06, [0.02, -0.05], [-10, -5], [-20, -10], 0, 10), // 前へ伸ばしながら振り出す
  },
};
const FORM_BY_TECH = {
  "fh-hit": "fhLong", "fh-loop-under": "fhDrive", "fh-loop-top": "fhDrive", counter: "fhCounter",
  "fh-push": "fhPush", stop: "fhStop", flick: "fhFlick",
  "bh-hit": "bhLong", block: "bhBlock", "bh-loop": "bhDrive", push: "bhPush", chiquita: "bhChiquita",
  "bs-serve": "serve", pendulum: "serve", yg: "serveOut", reverse: "serveOut", squat: "serve",
};
// 足の位置（腰から見た位置：前・左。m）。stepIn の技は利き手側の足を台の下へ踏み込む
const STANCES = {
  fh: { footR: [-0.14, -0.3], footL: [0.18, 0.28] },
  bh: { footR: [0.02, -0.3], footL: [0.02, 0.3] },
  serve: { footR: [-0.12, -0.24], footL: [0.2, 0.26] },
};
const PELVIS_H = 0.9; // まっすぐ立ったときの腰の高さ

// なめらかな曲線（エルミート補間）で、[時刻, 値] の表から値を読む。途中の点では速さを保つ
function spline(keys, t) {
  if (t <= keys[0][0]) return keys[0][1];
  if (t >= keys.at(-1)[0]) return keys.at(-1)[1];
  let i = 0;
  while (t > keys[i + 1][0]) i++;
  const [t1, p1] = keys[i], [t2, p2] = keys[i + 1];
  const m1 = i > 0 ? (p2 - keys[i - 1][1]) / (t2 - keys[i - 1][0]) : 0;
  const m2 = i + 2 < keys.length ? (keys[i + 2][1] - p1) / (keys[i + 2][0] - t1) : 0;
  const h = t2 - t1, u = (t - t1) / h;
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * p1 + (u3 - 2 * u2 + u) * h * m1 + (-2 * u3 + 3 * u2) * p2 + (u3 - u2) * h * m2;
}
const rad = (d) => (d * Math.PI) / 180;

class Player {
  constructor(scene, shot, contact) {
    this.shot = shot;
    this.contact = contact;
    // 技の形（図鑑の技は FORM_BY_TECH、スマホのスイングは打球の回転から選ぶ）
    const drive = (shot.spin?.[1] || 0) > 40;
    this.formKey = shot.form || (shot.stroke === "serve" ? "serve" : shot.stroke === "bh" ? (drive ? "bhDrive" : "bhLong") : drive ? "fhDrive" : "fhLong");
    const form = FORMS[this.formKey];
    this.form = form;
    this.n = contact.n;
    this.c0 = sub(shot.p0, mul(contact.n, 0.02 + 0.006)); // 打つ瞬間のラケットの真ん中（ボールのすぐ後ろ）
    this.heading = rad(form.heading || 0);

    // 時刻ごとの姿勢の表：構え（止まる）→（サーブはトス）→ 引き → 打球 → 振り抜き → 少し止まる → 構えに戻る
    const ph = [
      [T_START, form.ready],
      [-0.5, form.toss || form.ready],
      [form.tBack, form.back],
      [0, form.contact],
      [form.tFollow, form.follow],
      [0.32, form.follow],
      [0.75, form.ready],
    ];
    this.phases = ph;
    const keysOf = (get) => ph.map(([t, p]) => [t, get(p)]);
    this.tracks = {
      yaw: keysOf((p) => p.yaw), lean: keysOf((p) => p.lean), crouch: keysOf((p) => p.crouch),
      sf: keysOf((p) => p.shift[0]), sl: keysOf((p) => p.shift[1]),
      uAz: keysOf((p) => p.up[0]), uEl: keysOf((p) => p.up[1]), fAz: keysOf((p) => p.fore[0]), fEl: keysOf((p) => p.fore[1]),
      cock: keysOf((p) => p.cock), pro: keysOf((p) => p.pro),
    };

    // 打つ瞬間に、ラケットがボールの位置・向きに来るように合わせる
    //  1) 前腕のひねりと手首の曲げで、ラケット面を物理計算の向きに合わせる
    //  2) 上腕の上下の角度を少し変えて、ラケットの高さを合わせる
    //  3) 体ごと前後左右に動かして、ラケットの位置を合わせる
    //  4) 引きと振り抜きの腕の角度を少し変えて、打つ瞬間のラケットの動く向きを、物理計算の振る向きにそろえる
    this.pro0 = 0;
    this.flex0 = 0;
    this.elevFix = 0;
    this.zFix = 0;
    this.origin = [0, 0];
    // 前腕の向きを少し変えてみて、手首の曲げがいちばん小さくて済む向きを選ぶ
    let bestFix = { cost: Infinity, fix: 0 };
    for (const fix of [-40, -30, -20, -10, 0, 10, 20, 30, 40]) {
      this.fAzFix = fix;
      this.solveFace();
      const ang = Math.acos(clamp(dot(this.pose(0).n, this.n), -1, 1));
      const cost = ang * 3 + Math.abs(this.flex0) + Math.abs(rad(fix)) * 0.3;
      if (cost < bestFix.cost) bestFix = { cost, fix };
    }
    this.fAzFix = bestFix.fix;
    for (let k = 0; k < 3; k++) {
      this.solveFace();
      this.solveHeight();
    }
    this.solveSwing();
    const c = this.pose(0).racketCenter;
    this.origin = [this.c0[0] - c[0], this.c0[1] - c[1]];

    // 足の位置（打つ瞬間の腰の位置から決め、動かさない）
    const p0 = this.pose(0);
    const st = STANCES[form.stance];
    const F = [Math.cos(this.heading), Math.sin(this.heading), 0], Lv = [-Math.sin(this.heading), Math.cos(this.heading), 0];
    const base = [p0.pelvis[0], p0.pelvis[1], 0.04];
    const at = (fl) => add(add(base, mul(F, fl[0])), mul(Lv, fl[1]));
    this.footR = form.stepIn ? at([0.42, -0.26]) : at(st.footR);
    this.footL = at(st.footL);
    this.pelvis0 = p0.pelvis;
    this.build(scene);
  }

  /** 時刻 t の関節の角度など */
  params(t) {
    const v = {};
    for (const [k, keys] of Object.entries(this.tracks)) v[k] = spline(keys, t);
    return v;
  }

  /**
   * 関節の角度から、体とラケットの位置を計算する（物理の座標）
   * pro0・flex0・elevFix・origin は、打つ瞬間を合わせるための補正
   */
  pose(t) {
    const v = this.params(t);
    const yaw = this.heading + rad(v.yaw);
    const H0 = [Math.cos(this.heading), Math.sin(this.heading), 0], L0 = [-Math.sin(this.heading), Math.cos(this.heading), 0];
    const pelvis = add(add([this.origin[0], this.origin[1], PELVIS_H - v.crouch + (this.zFix || 0)], mul(H0, v.sf)), mul(L0, v.sl));
    // 体の向き：ひねり（yaw）と前傾（lean）
    const Fh = [Math.cos(yaw), Math.sin(yaw), 0];
    const Lf = [-Math.sin(yaw), Math.cos(yaw), 0];
    const lean = rad(v.lean);
    const U = add(mul(Fh, Math.sin(lean)), [0, 0, Math.cos(lean)]); // 背骨の向き
    const F = add(mul(Fh, Math.cos(lean)), [0, 0, -Math.sin(lean)]); // 胸の正面
    const chest = add(pelvis, mul(U, 0.36));
    const neck = add(pelvis, mul(U, 0.5));
    const head = add(neck, add(mul(U, 0.11), mul(F, 0.03)));
    const shR = add(add(chest, mul(U, 0.1)), mul(Lf, -0.19));
    const shL = add(add(chest, mul(U, 0.1)), mul(Lf, 0.19));
    const dir = (az, el) => {
      const a = rad(az), e = rad(el);
      return add(mul(add(mul(F, Math.cos(a)), mul(Lf, Math.sin(a))), Math.cos(e)), mul(U, Math.sin(e)));
    };
    // 右腕（ラケットを持つ腕）
    const elbowR = add(shR, mul(dir(v.uAz, v.uEl + this.elevFix), 0.3));
    const fdir = unit(dir(v.fAz + (this.fAzFix || 0), v.fEl));
    const handR = add(elbowR, mul(fdir, 0.27));
    // ラケット：前腕のひねり（pro）で面の向き、手首（cock）でラケットの先の向き、手首の曲げ（flex）で面の傾き
    let r0 = perp(U, fdir);
    r0 = len(r0) > 1e-6 ? unit(r0) : unit(perp(F, fdir));
    const th = rad(v.pro) + this.pro0;
    const nTh = add(mul(r0, Math.cos(th)), mul(cross(fdir, r0), Math.sin(th)));
    let d = rotAround(fdir, nTh, rad(v.cock));
    const ax = unit(cross(d, nTh));
    const n = rotAround(nTh, ax, this.flex0);
    d = rotAround(d, ax, this.flex0);
    const racketCenter = add(handR, mul(d, GRIP));
    return { pelvis, chest, neck, head, shR, shL, elbowR, handR, n, handle: mul(d, -1), racketCenter, F: Fh, L: Lf, U };
  }

  /** 打つ瞬間のラケット面を、物理計算の向き（this.n）に合わせる（前腕のひねりと手首の曲げを探す） */
  solveFace() {
    const target = this.n;
    let best = { cost: Infinity, pro: 0, flex: 0 };
    const tryAt = (pro, flex) => {
      this.pro0 = pro;
      this.flex0 = flex;
      const n = this.pose(0).n;
      const ang = Math.acos(clamp(dot(n, target), -1, 1));
      const cost = ang + 0.05 * Math.abs(flex);
      if (cost < best.cost) best = { cost, pro, flex };
    };
    for (let p = -180; p < 180; p += 4) for (let f = -85; f <= 85; f += 5) tryAt(rad(p), rad(f));
    const c = { ...best };
    for (let p = -4; p <= 4; p += 0.5) for (let f = -5; f <= 5; f += 0.5) tryAt(c.pro + rad(p), c.flex + rad(f));
    this.pro0 = best.pro;
    this.flex0 = best.flex;
  }

  /** 打つ瞬間のラケットの高さを、ボールの高さに合わせる（上腕の上下の角度を少し変え、足りない分はひざの曲げで） */
  solveHeight() {
    this.zFix = 0;
    const z = (fix) => {
      this.elevFix = fix;
      return this.pose(0).racketCenter[2];
    };
    let lo = -25, hi = 25;
    // 腕を上げるほどラケットは高くなる
    if ((z(lo) - this.c0[2]) * (z(hi) - this.c0[2]) > 0) {
      this.elevFix = Math.abs(z(lo) - this.c0[2]) < Math.abs(z(hi) - this.c0[2]) ? lo : hi;
    } else {
      for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2;
        if (z(mid) < this.c0[2]) lo = mid;
        else hi = mid;
      }
      this.elevFix = (lo + hi) / 2;
    }
    this.zFix = clamp(this.c0[2] - this.pose(0).racketCenter[2], -0.2, 0.12);
  }

  /** 打つ瞬間のラケットの動く向きを、物理計算の振る向き（contact.swing）にそろえる */
  solveSwing() {
    const D = this.contact.swing;
    const names = ["uAz", "uEl", "fAz", "fEl", "cock", "pro", "yaw"];
    const limit = [45, 45, 45, 45, 45, 45, 25];
    const base = Object.fromEntries(names.map((k) => [k, this.tracks[k].map((x) => [...x])]));
    const iB = this.phases.findIndex(([t]) => t === this.form.tBack);
    const iF = this.phases.findIndex(([t]) => t === this.form.tFollow);
    const apply = (delta) => {
      names.forEach((k, i) => {
        const tr = base[k].map((x) => [...x]);
        tr[iB][1] -= delta[i];
        tr[iF][1] += delta[i];
        tr[iF + 1][1] += delta[i]; // 振り抜きで止まっている間も同じ
        this.tracks[k] = tr;
      });
    };
    const err = (delta) => {
      apply(delta);
      const a = this.pose(-0.004).racketCenter, b = this.pose(0.004).racketCenter;
      const v = sub(b, a);
      const l = len(v) || 1;
      return Math.acos(clamp(dot(v, D) / l, -1, 1)) + 0.003 * delta.reduce((s, x) => s + Math.abs(x), 0);
    };
    // 少しずつ動かして、ずれが小さくなる方へ（各関節 最大45°、体のひねりは25°）
    const descend = (start) => {
      let best = [...start], bestE = err(best);
      for (const step of [12, 6, 3, 1.5]) {
        let improved = true;
        while (improved) {
          improved = false;
          for (let i = 0; i < names.length; i++) for (const sgn of [1, -1]) {
            const c = [...best];
            c[i] = clamp(c[i] + sgn * step, -limit[i], limit[i]);
            const e = err(c);
            if (e < bestE - 1e-4) {
              best = c;
              bestE = e;
              improved = true;
            }
          }
        }
      }
      return { best, bestE };
    };
    let res = descend(names.map(() => 0));
    // まだ大きくずれているときは、いろいろな出発点から探し直す（毎回同じ結果になるよう、決まった乱数で）
    let seed = 12345;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let k = 0; k < 24 && res.bestE > rad(15); k++) {
      const r = descend(limit.map((l) => rnd() * l));
      if (r.bestE < res.bestE) res = r;
    }
    apply(res.best);
    this.swingFix = res.best.map((x) => Math.round(x));
  }

  /** サーブのトスを上げる手の位置 */
  tossPalm() {
    return add(this.shot.p0, [0.04, 0.22, 0.02]);
  }

  /** 関節の位置（足・左腕を含む） */
  joints(t) {
    const j = this.pose(t);
    const { pelvis, chest, shL, F, L } = j;
    const hipR = add(pelvis, mul(L, -0.1));
    const hipL = add(pelvis, mul(L, 0.1));
    const kneeR = solveJoint(hipR, this.footR, 0.45, 0.45, add(F, [0, -0.2, 0]));
    const kneeL = solveJoint(hipL, this.footL, 0.45, 0.45, add(F, [0, 0.2, 0]));
    // 左手：バランスをとる（サーブではトスを上げる）
    let handL;
    if (this.shot.stroke === "serve") {
      const palm = this.tossPalm();
      handL = t < -0.5 ? palm : lerpV(palm, add(add(chest, mul(L, 0.35)), [0, 0, -0.1]), smooth(clamp((t + 0.5) / 0.4, 0, 1)));
    } else {
      handL = add(add(add(chest, mul(j.F, 0.28)), mul(L, 0.22)), [0, 0, -0.14]);
    }
    handL = reach(shL, handL, 0.57);
    const elbowL = solveJoint(shL, handL, 0.3, 0.28, add(mul(L, 0.8), [0, 0, -0.6]));
    return { ...j, hipR, hipL, kneeR, kneeL, footR: this.footR, footL: this.footL, handL, elbowL };
  }

  build(scene) {
    const g = new THREE.Group();
    // 棒人間：線は細く、ラケットを持つ腕だけオレンジにして目立たせる
    const body = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.6 });
    const arm = new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.6 });
    const shoe = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.6 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xf1d3b3, roughness: 0.6 });
    this.bodyMats = [body, arm, shoe];
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 10);
    const sph = new THREE.SphereGeometry(1, 16, 12);
    const limb = (mat, r) => {
      const m = new THREE.Mesh(cyl, mat);
      m.userData.r = r;
      g.add(m);
      return m;
    };
    const ball = (mat, r) => {
      const m = new THREE.Mesh(sph, mat);
      m.scale.setScalar(r);
      g.add(m);
      return m;
    };
    const L = 0.022, J = 0.03;
    this.parts = {
      torso: limb(body, 0.03),
      chestBall: ball(body, J),
      hipBall: ball(body, J),
      neck: limb(body, L),
      head: ball(body, 0.1),
      upperR: limb(arm, L), foreR: limb(arm, L), elbowR: ball(arm, J), handR: ball(arm, 0.001), shoulderR: ball(arm, J),
      upperL: limb(body, L), foreL: limb(body, L), elbowL: ball(body, J), handL: ball(body, 0.035), shoulderL: ball(body, J),
      thighR: limb(body, 0.026), shinR: limb(body, L), kneeR: ball(body, J),
      thighL: limb(body, 0.026), shinL: limb(body, L), kneeL: ball(body, J),
      footR: new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.05, 0.08), shoe),
      footL: new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.05, 0.08), shoe),
    };
    g.add(this.parts.footR, this.parts.footL);

    // ラケット（面の向き＝ローカルの y、グリップの向き＝ローカルの z）
    const racket = new THREE.Group();
    const red = new THREE.Mesh(new THREE.CylinderGeometry(0.076, 0.076, 0.004, 40), new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.5 }));
    red.position.y = 0.003;
    const black = new THREE.Mesh(new THREE.CylinderGeometry(0.076, 0.076, 0.004, 40), new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.5 }));
    black.position.y = -0.003;
    const wood = new THREE.Mesh(new THREE.CylinderGeometry(0.077, 0.077, 0.003, 40), new THREE.MeshStandardMaterial({ color: 0xd6a35c }));
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.024, 0.1), new THREE.MeshStandardMaterial({ color: 0xa16207 }));
    grip.position.z = 0.076 + 0.045;
    racket.add(red, black, wood, grip);

    // 手（シェークハンドの握り）：グリップをにぎるこぶしと、面に添える親指・人差し指
    // 打つ面に親指（フォア）／人差し指（バック）が来るように、バックの技では指を反対にする
    const side = this.shot.stroke === "bh" ? -1 : 1;
    // サーブは中指・薬指・小指をグリップから離して丸める（手首を使いやすい握り）
    const serveGrip = this.shot.stroke === "serve";
    // 手のひら（グリップの、親指と反対側をつつむ）
    const fist = serveGrip
      ? new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.045, 0.045), skin) // 丸めた指（グリップの外）
      : new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.03, 0.075), skin);
    if (serveGrip) fist.position.set(0.0, -0.03 * side, GRIP - 0.01);
    else fist.position.set(0.012, 0.004 * side, GRIP + 0.005);
    const fingerGeo = new THREE.CylinderGeometry(0.008, 0.008, 1, 8);
    const finger = (from, to) => {
      const m = new THREE.Mesh(fingerGeo, skin);
      const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to);
      const d = new THREE.Vector3().subVectors(b, a);
      m.position.copy(a).addScaledVector(d, 0.5);
      m.scale.set(1, d.length(), 1);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
      return m;
    };
    const thumb = finger([0.012, 0.012 * side, 0.098], [0.004, 0.012 * side, 0.058]);
    const index = finger([-0.016, -0.012 * side, 0.092], [0.022, -0.012 * side, 0.035]);
    // 残りの3本の指：グリップに巻きつける
    const wrap = new THREE.TorusGeometry(0.018, 0.0065, 6, 14, Math.PI);
    for (const z of serveGrip ? [] : [0.112, 0.13, 0.148]) {
      const f = new THREE.Mesh(wrap, skin);
      f.position.z = z;
      f.rotation.z = side > 0 ? Math.PI : 0;
      racket.add(f);
    }
    racket.add(fist, thumb, index);
    g.add(racket);
    this.racket = racket;

    scene.add(g);
    this.group = g;
  }

  /** インパクト視点では体を半透明にして、ラケットとボールを見やすくする */
  setSeeThrough(on) {
    for (const m of this.bodyMats) {
      m.transparent = on;
      m.opacity = on ? 0.3 : 1;
      m.depthWrite = !on;
      m.needsUpdate = true;
    }
  }

  setLimb(mesh, a, b) {
    const A = toV3(a), B = toV3(b);
    const d = new THREE.Vector3().subVectors(B, A);
    const l = d.length();
    mesh.position.copy(A).addScaledVector(d, 0.5);
    mesh.scale.set(mesh.userData.r, l, mesh.userData.r);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  }

  update(t) {
    const j = this.joints(t);
    const center = j.racketCenter;
    const P = this.parts;
    this.setLimb(P.torso, j.pelvis, j.neck);
    P.chestBall.position.copy(toV3(j.chest));
    P.hipBall.position.copy(toV3(j.pelvis));
    this.setLimb(P.neck, j.neck, j.head);
    P.head.position.copy(toV3(j.head));
    this.setLimb(P.upperR, j.shR, j.elbowR);
    this.setLimb(P.foreR, j.elbowR, j.handR);
    P.shoulderR.position.copy(toV3(j.shR));
    P.elbowR.position.copy(toV3(j.elbowR));
    P.handR.position.copy(toV3(j.handR));
    this.setLimb(P.upperL, j.shL, j.elbowL);
    this.setLimb(P.foreL, j.elbowL, j.handL);
    P.shoulderL.position.copy(toV3(j.shL));
    P.elbowL.position.copy(toV3(j.elbowL));
    P.handL.position.copy(toV3(j.handL));
    this.setLimb(P.thighR, j.hipR, j.kneeR);
    this.setLimb(P.shinR, j.kneeR, j.footR);
    P.kneeR.position.copy(toV3(j.kneeR));
    this.setLimb(P.thighL, j.hipL, j.kneeL);
    this.setLimb(P.shinL, j.kneeL, j.footL);
    P.kneeL.position.copy(toV3(j.kneeL));
    const toe = toV3([Math.cos(this.heading), Math.sin(this.heading), 0]).normalize();
    for (const [foot, pos] of [[P.footR, j.footR], [P.footL, j.footL]]) {
      foot.position.copy(toV3(pos));
      foot.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), toe);
    }

    // ラケット：面の向き（n）とグリップの向き（handle）は、前腕のひねりと手首から決まる
    const yAxis = toV3(j.n).normalize();
    const zAxis = toV3(j.handle).normalize();
    const xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis).normalize();
    this.racket.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis));
    this.racket.position.copy(toV3(center));
    this.lastJoints = j;
    return { center, joints: j };
  }
}

/* ==========================================================
 * 3Dの画面
 * ========================================================== */
class TrajectoryView {
  constructor({ title, shot, solved, startView = "back", contact = null }) {
    this.title = title;
    this.shot = shot;
    this.solved = solved;
    // contact を渡されたとき（スマホで測ったスイング）は、その角度を使う
    this.contact = contact || contactRacket(solved.v0, shot.spin);
    this.rate = 0.25;
    this.t = T_START;
    this.playing = true;
    this.showGhost = true;
    this.duration = solved.withSpin.points.at(-1).t;
    this.buildDom();
    this.buildScene();
    this.setView(startView);
    this.last = performance.now();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  /* ---------- 画面の部品 ---------- */
  buildDom() {
    const s = this.shot;
    const kmh = Math.round(Math.hypot(...this.solved.v0) * 3.6);
    const [, top, side] = s.spin;
    const spinText = [
      top > 0.5 ? `上回転 ${Math.round(top)}` : top < -0.5 ? `下回転 ${Math.round(-top)}` : "",
      Math.abs(side) > 0.5 ? `横回転 ${Math.round(Math.abs(side))}` : "",
    ]
      .filter(Boolean)
      .join("・") || "回転ほぼなし";
    const c = this.contact;
    const face = c.faceDeg < -3 ? `かぶせる ${Math.round(-c.faceDeg)}°` : c.faceDeg > 3 ? `ひらく ${Math.round(c.faceDeg)}°` : "ほぼ垂直";
    const lateral = Math.abs(c.swing[1]) > 0.4 ? lr(c.swing[1] > 0 ? "右→左へ" : "左→右へ") : "";
    const vertical = c.swingDeg > 8 ? `上へ ${Math.round(c.swingDeg)}°` : c.swingDeg < -8 ? `下へ ${Math.round(-c.swingDeg)}°` : "まっすぐ前へ";
    const root = document.createElement("div");
    root.className = "traj-overlay";
    root.innerHTML = `
      <div class="traj-head">
        <button class="traj-close" aria-label="閉じる">✕</button>
        <div class="flex-1 min-w-0">
          <p class="traj-title">${this.title}</p>
          <p class="traj-sub">初速 約${kmh}km/h ・ ${spinText}（回転/秒）</p>
        </div>
      </div>
      <div class="traj-stage"><canvas></canvas><p class="traj-clock"></p></div>
      <div class="traj-panel">
        ${s.note ? `<p class="traj-note">${lr(s.note)}</p>` : ""}
        <div class="traj-racket">
          <span><b>ラケット面</b>${face}</span>
          <span><b>スイング</b>${lateral}${lateral && vertical !== "まっすぐ前へ" ? "・" : ""}${lateral && vertical === "まっすぐ前へ" ? "" : vertical}</span>
        </div>
        <div class="traj-row">
          <button class="traj-play">一時停止</button>
          <div class="traj-seg" data-group="rate">${RATES.map((r) => `<button data-rate="${r.value}">${r.label}</button>`).join("")}</div>
        </div>
        <div class="traj-row">
          <div class="traj-seg traj-views" data-group="view">${Object.entries(VIEWS).map(([k, v]) => `<button data-view="${k}">${v.label}</button>`).join("")}</div>
        </div>
        <label class="traj-row traj-check">
          <input type="checkbox" class="traj-ghost" checked />
          <span><span class="traj-swatch"></span>回転なしだとこう飛ぶ（比較）</span>
        </label>
        <button class="traj-rec">🎬 動画として保存</button>
        <p class="traj-foot">数値は物理計算による例です（${MIRROR < 0 ? "左利き" : "右利き"}）。指でぐるっと回したり、2本指で拡大したりできます。</p>
      </div>`;
    document.body.appendChild(root);
    document.body.style.overflow = "hidden";
    this.root = root;
    this.canvas = root.querySelector("canvas");
    this.clock = root.querySelector(".traj-clock");

    root.querySelector(".traj-close").onclick = () => closeTrajectory();
    this.playBtn = root.querySelector(".traj-play");
    this.playBtn.onclick = () => {
      this.playing = !this.playing;
      if (this.playing && this.t >= this.duration) this.t = T_START;
      this.playBtn.textContent = this.playing ? "一時停止" : "▶ 再生";
    };
    root.querySelector('[data-group="rate"]').onclick = (e) => {
      const b = e.target.closest("[data-rate]");
      if (b) this.setRate(Number(b.dataset.rate));
    };
    root.querySelector('[data-group="view"]').onclick = (e) => {
      const b = e.target.closest("[data-view]");
      if (b) this.setView(b.dataset.view);
    };
    root.querySelector(".traj-ghost").onchange = (e) => {
      this.showGhost = e.target.checked;
    };
    this.recBtn = root.querySelector(".traj-rec");
    this.recBtn.onclick = () => this.record();
    this.setRate(this.rate);
  }

  setRate(rate) {
    this.rate = rate;
    this.root.querySelectorAll("[data-rate]").forEach((b) => b.classList.toggle("on", Number(b.dataset.rate) === rate));
  }

  setView(key) {
    this.viewKey = key;
    let pos, target;
    if (key === "eye") {
      // 位置と向きは毎回の描画で、選手の頭に合わせる
      const j = this.player.lastJoints || this.player.joints(this.t);
      pos = toV3(j.head);
      target = toV3([0.7, 0, TABLE.H]);
    } else if (key === "grip") {
      // 手元を横から追いかける（指で回すと見る向きを変えられる）
      const p0 = this.shot.p0;
      let side = unit(cross(this.contact.swing, [0, 0, 1]));
      if (len(side) < 0.5) side = [0, 1, 0];
      if (dot(side, sub(p0, this.player.pelvis0)) < 0) side = mul(side, -1);
      this.gripOffset = toV3(add(add(mul(side, 0.5), [0.2, 0, 0]), [0, 0, 0.12]));
      const rc = this.player.racket.position.clone();
      pos = rc.clone().add(this.gripOffset);
      target = rc;
    } else if (key === "impact") {
      // 打つ点の横から、スイングの向きが見える位置に寄る
      const p0 = this.shot.p0;
      let side = unit(cross(this.contact.swing, [0, 0, 1]));
      if (len(side) < 0.5) side = [0, 1, 0];
      const awayFromBody = sub(p0, this.player.pelvis0);
      if (dot(side, awayFromBody) < 0) side = mul(side, -1);
      // 横回転（回転の軸がたて）のときは、回転の矢印が見えるように少し上から見る
      const axisUp = len(this.shot.spin) > 0.5 ? Math.abs(unit(this.shot.spin)[2]) : 0;
      const camP = add(add(p0, mul(side, 0.42 - axisUp * 0.12)), [0.1, 0, 0.07 + axisUp * 0.28]);
      pos = toV3(camP);
      target = toV3(p0);
    } else {
      const v = VIEWS[key];
      // 縦長の画面（スマホ）では台が入りきるように、カメラを遠ざける
      const far = Math.min(2.4, Math.max(1, 1.2 / this.camera.aspect));
      target = new THREE.Vector3(v.target[0], v.target[1], v.target[2] * MIRROR);
      pos = new THREE.Vector3(v.pos[0], v.pos[1], v.pos[2] * MIRROR).sub(target).multiplyScalar(key === "top" ? Math.max(1, far * 0.8) : far).add(target);
    }
    this.camera.position.copy(pos);
    this.controls.target.copy(target);
    this.controls.minDistance = key === "impact" || key === "grip" ? 0.15 : 0.8;
    // 自分視点：広い画角にして、頭は表示しない（指で回す操作もしない）
    const eye = key === "eye";
    this.camera.fov = eye ? 75 : 45;
    this.camera.updateProjectionMatrix();
    this.controls.enabled = !eye;
    this.player.parts.head.visible = !eye;
    this.player.parts.neck.visible = !eye;
    this.eyeLook = null;
    this.controls.update();
    this.impactGroup.visible = key === "impact";
    this.player.setSeeThrough(key === "impact" || key === "grip");
    this.root.querySelectorAll("[data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === key));
  }

  /* ---------- 3Dの場面 ---------- */
  buildScene() {
    const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer = renderer;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a1020);
    scene.fog = new THREE.Fog(0x0a1020, 8, 16);
    this.scene = scene;
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.02, 50);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.maxDistance = 9;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-2, 5, 3);
    scene.add(sun);

    // 床
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(16, 10), new THREE.MeshStandardMaterial({ color: 0x7c2d12, roughness: 0.9 }));
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);

    // 台
    const top = new THREE.Mesh(new THREE.BoxGeometry(TABLE.L, 0.03, TABLE.W), new THREE.MeshStandardMaterial({ color: 0x1d4ed8, roughness: 0.55 }));
    top.position.set(0, TABLE.H - 0.015, 0);
    scene.add(top);
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const addLine = (w, d, x, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.002, d), lineMat);
      m.position.set(x, TABLE.H + 0.001, z);
      scene.add(m);
    };
    addLine(TABLE.L, 0.02, 0, TABLE.W / 2 - 0.01);
    addLine(TABLE.L, 0.02, 0, -TABLE.W / 2 + 0.01);
    addLine(0.02, TABLE.W, TABLE.L / 2 - 0.01, 0);
    addLine(0.02, TABLE.W, -TABLE.L / 2 + 0.01, 0);
    addLine(TABLE.L, 0.003, 0, 0);
    const legMat = new THREE.MeshStandardMaterial({ color: 0x334155 });
    for (const [x, z] of [[1.1, 0.6], [1.1, -0.6], [-1.1, 0.6], [-1.1, -0.6]]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, TABLE.H - 0.03, 0.05), legMat);
      leg.position.set(x, (TABLE.H - 0.03) / 2, z);
      scene.add(leg);
    }
    // ネット
    const net = new THREE.Mesh(
      new THREE.PlaneGeometry(TABLE.W + 0.305, TABLE.NET),
      new THREE.MeshBasicMaterial({ color: 0xe2e8f0, transparent: true, opacity: 0.45, side: THREE.DoubleSide })
    );
    net.rotation.y = Math.PI / 2;
    net.position.set(0, TABLE.H + TABLE.NET / 2, 0);
    scene.add(net);
    const tape = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.015, TABLE.W + 0.305), lineMat);
    tape.position.set(0, TABLE.H + TABLE.NET, 0);
    scene.add(tape);

    // 選手
    this.player = new Player(scene, this.shot, this.contact);

    // 軌道
    this.main = this.makePath(this.solved.withSpin, 0xfbbf24, 0xf97316);
    scene.add(this.main.group);
    this.ghostGroup = new THREE.Group();
    this.ghost = this.makePath(this.solved.noSpin, 0x94a3b8, 0x94a3b8, true);
    this.ghostGroup.add(this.ghost.group);
    scene.add(this.ghostGroup);

    // ボール（回転が見えるように、オレンジの帯を描いた白いボール）
    this.ball = this.makeBall();
    scene.add(this.ball);
    this.ghostBall = new THREE.Mesh(
      new THREE.SphereGeometry(0.02 * BALL_SCALE, 20, 14),
      new THREE.MeshStandardMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.6 })
    );
    this.ghostGroup.add(this.ghostBall);

    this.buildImpactMarks(scene);

    this.onResize = () => this.resize();
    window.addEventListener("resize", this.onResize);
    this.resize();
  }

  /** インパクト視点で出す矢印：スイングの向き（オレンジ）と、ボールの回転の向き（水色） */
  buildImpactMarks(scene) {
    const g = new THREE.Group();
    const c = this.contact;
    const p0 = this.shot.p0;
    const swingDir = toV3(c.swing).normalize();
    const from = toV3(sub(p0, mul(c.swing, 0.2))).addScaledVector(toV3(c.n).normalize(), -0.03);
    g.add(new THREE.ArrowHelper(swingDir, from, 0.3, 0xff7a1a, 0.06, 0.035));

    // 回転の向き：回転の軸のまわりをまわる矢印
    const w = this.shot.spin;
    if (len(w) > 0.5) {
      const axis = toAxis(unit(w)).normalize();
      const spinMark = new THREE.Group();
      const arc = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.004, 8, 40, Math.PI * 1.5), new THREE.MeshBasicMaterial({ color: 0x38bdf8 }));
      spinMark.add(arc);
      // 矢じり：円の終わり（角度 1.5π）で、回る向き（反時計回り＝軸の右ねじ）に向ける
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.014, 0.03, 12), new THREE.MeshBasicMaterial({ color: 0x38bdf8 }));
      const a = Math.PI * 1.5;
      cone.position.set(0.055 * Math.cos(a), 0.055 * Math.sin(a), 0);
      cone.rotation.z = a; // 円の接線方向（+角度の向き）に向ける
      spinMark.add(cone);
      // トーラスは z 軸まわりの輪なので、z 軸を回転の軸に合わせる
      spinMark.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
      spinMark.position.copy(toV3(p0));
      g.add(spinMark);
      this.spinMark = spinMark;
    }
    g.visible = false;
    scene.add(g);
    this.impactGroup = g;
  }

  makeBall() {
    const c = document.createElement("canvas");
    c.width = 128;
    c.height = 64;
    const g = c.getContext("2d");
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, 128, 64);
    g.fillStyle = "#f97316";
    g.fillRect(0, 26, 128, 12);
    g.fillRect(28, 0, 10, 64);
    const tex = new THREE.CanvasTexture(c);
    return new THREE.Mesh(new THREE.SphereGeometry(0.02 * BALL_SCALE, 28, 18), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.4 }));
  }

  /** 軌道の線（全体をうすく、通ったところを濃く）とバウンドの印 */
  makePath(sim, color, markColor, dashed = false) {
    const group = new THREE.Group();
    const pts = sim.points.map((p) => toV3(p.p));
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const faint = new THREE.Line(
      geo,
      dashed
        ? new THREE.LineDashedMaterial({ color, dashSize: 0.04, gapSize: 0.03, transparent: true, opacity: 0.55 })
        : new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.25 })
    );
    if (dashed) faint.computeLineDistances();
    group.add(faint);
    const trailGeo = new THREE.BufferGeometry().setFromPoints(pts);
    trailGeo.setDrawRange(0, 0);
    const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color }));
    if (!dashed) group.add(trail);
    const marks = sim.bounces.map((b) => {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.03, 0.045, 32),
        new THREE.MeshBasicMaterial({ color: markColor, side: THREE.DoubleSide, transparent: true, opacity: dashed ? 0.6 : 0.95 })
      );
      ring.rotation.x = -Math.PI / 2;
      const v = toV3(b.p);
      ring.position.set(v.x, TABLE.H + 0.003, v.z);
      ring.visible = dashed;
      group.add(ring);
      return { ring, t: b.t };
    });
    if (sim.net) {
      const last = toV3(sim.points.at(-1).p);
      const x = new THREE.Mesh(new THREE.TorusGeometry(0.04, 0.008, 8, 24), new THREE.MeshBasicMaterial({ color: 0xef4444 }));
      x.position.copy(last);
      x.rotation.y = Math.PI / 2;
      group.add(x);
    }
    return { group, trail, sim, pts, marks };
  }

  /** 時刻 t の位置（点と点の間はなめらかにつなぐ） */
  sample(sim, t) {
    const pts = sim.points;
    if (t <= 0) return { i: 0, p: pts[0].p, w: pts[0].w };
    let i = pts.findIndex((p) => p.t >= t);
    if (i < 0) return { i: pts.length - 1, p: pts.at(-1).p, w: pts.at(-1).w, done: true };
    const a = pts[i - 1] || pts[i], b = pts[i];
    const k = b.t === a.t ? 1 : (t - a.t) / (b.t - a.t);
    return { i, p: a.p.map((v, j) => v + (b.p[j] - v) * k), w: b.w };
  }

  /** 打つ前のボール：相手から飛んでくる球（サーブはトス） */
  incoming(t) {
    const p0 = this.shot.p0;
    if (this.shot.stroke === "serve") {
      const palm = this.player.tossPalm();
      const tUp = -0.54; // ここで手から離れる
      if (t < tUp) return palm;
      const k = (t - tUp) / -tUp; // 0→1
      const h = 0.36; // トスの高さ
      const base = lerpV(palm, p0, k);
      return [base[0], base[1], lerp(palm[2], p0[2], k) + 4 * h * k * (1 - k)];
    }
    // 相手コート → 自分のコートで1回バウンド → 打つ位置
    const q0 = [1.5, p0[1] * 0.4 + 0.1, 1.0];
    const bx = clamp(p0[0] + 0.55, -1.2, -0.3);
    const bounce = [bx, lerp(q0[1], p0[1], 0.8), TABLE.H + 0.02];
    const arc = (a, b, k, h) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k) + 4 * h * k * (1 - k)];
    if (t < -0.25) return arc(q0, bounce, clamp((t - T_START) / (-0.25 - T_START), 0, 1), 0.22);
    return arc(bounce, p0, clamp((t + 0.25) / 0.25, 0, 1), 0.18);
  }

  resize() {
    const stage = this.canvas.parentElement;
    const w = stage.clientWidth, h = stage.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.viewKey) this.setView(this.viewKey);
  }

  loop(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (this.playing) {
      // インパクト視点では、打つ瞬間の前後をさらに遅くする
      const slow = this.viewKey === "impact" && this.t > -0.12 && this.t < 0.1 ? IMPACT_SLOW : 1;
      this.t += dt * this.rate * slow;
      if (this.t > this.duration + END_PAUSE * this.rate) {
        if (this.recorder) this.stopRecord();
        this.t = T_START;
        this.ball.rotation.set(0, 0, 0);
      }
    }
    const t = Math.min(this.t, this.duration);
    this.player.update(t);

    if (t < 0) {
      this.ball.position.copy(toV3(this.incoming(t)));
      this.main.trail.geometry.setDrawRange(0, 0);
      this.main.marks.forEach((m) => (m.ring.visible = false));
    } else {
      const s = this.sample(this.solved.withSpin, t);
      this.ball.position.copy(toV3(s.p));
      this.main.trail.geometry.setDrawRange(0, s.i + 1);
      this.main.marks.forEach((m) => (m.ring.visible = t >= m.t));
      // 回転：本当の回転の向きで、見える速さに落として回す
      const w = toAxis(s.w);
      const wLen = w.length();
      if (wLen > 1e-6 && this.playing) {
        const visual = Math.min((wLen / (2 * Math.PI)) * this.rate, MAX_VISUAL_SPIN) * 2 * Math.PI;
        this.ball.rotateOnWorldAxis(w.normalize(), visual * dt);
      }
    }
    // 回転なしの比較は、打ったあとだけ出す
    this.ghostGroup.visible = this.showGhost && t >= 0;
    if (t >= 0) {
      const g = this.sample(this.solved.noSpin, Math.min(t, this.solved.noSpin.points.at(-1).t));
      this.ghostBall.position.copy(toV3(g.p));
    }
    if (this.spinMark) {
      this.spinMark.visible = t >= 0;
      if (t >= 0) this.spinMark.position.copy(this.ball.position);
    }

    // 自分視点：目の位置（頭の少し前）から、相手コートの方を見ながらボールを目で追う
    if (this.viewKey === "eye") {
      const j = this.player.lastJoints;
      const eyePos = add(add(j.head, mul(j.F, 0.06)), [0, 0, 0.02]);
      const ballP = [this.ball.position.x, -this.ball.position.z * MIRROR, this.ball.position.y]; // 物理の座標にもどす
      const want = lerpV([0.9, 0, TABLE.H + 0.1], ballP, 0.45);
      this.eyeLook = this.eyeLook ? lerpV(this.eyeLook, want, 0.12) : want; // 目の動きをなめらかに
      this.camera.position.copy(toV3(eyePos));
      this.controls.target.copy(toV3(this.eyeLook));
      this.camera.lookAt(this.controls.target);
    }
    // 「持ち方」の視点：ラケットを追いかける（指で回した向きはそのまま保つ）
    if (this.viewKey === "grip") {
      const rc = this.player.racket.position;
      this.camera.position.copy(rc).add(this.gripOffset);
      this.controls.target.copy(rc);
    }
    this.clock.textContent = t < 0 ? `打つ ${Math.round(-t * 1000)} ミリ秒前` : `打って ${Math.round(t * 1000)} ミリ秒`;
    this.controls.update();
    if (this.viewKey === "grip") this.gripOffset = this.camera.position.clone().sub(this.controls.target);
    this.renderer.render(this.scene, this.camera);
    this.raf = requestAnimationFrame(this.loop);
  }

  /* ---------- 動画として保存（1回分の再生を録画） ---------- */
  record() {
    if (this.recorder) return;
    if (!this.canvas.captureStream || !window.MediaRecorder) {
      alert("このブラウザでは動画の保存に対応していません");
      return;
    }
    const types = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
    const stream = this.canvas.captureStream(30);
    const rec = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 4_000_000 } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      const type = rec.mimeType || mimeType || "video/webm";
      const blob = new Blob(chunks, { type });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${this.title.replace(/^\S+\s/, "")}_軌道.${type.includes("mp4") ? "mp4" : "webm"}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      this.recBtn.textContent = "🎬 動画として保存";
      this.recBtn.disabled = false;
    };
    this.recorder = rec;
    this.t = T_START;
    this.playing = true;
    this.playBtn.textContent = "一時停止";
    this.recBtn.textContent = "● 録画中…（1回再生したら保存）";
    this.recBtn.disabled = true;
    rec.start();
  }

  stopRecord() {
    this.recorder.stop();
    this.recorder = null;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    if (this.recorder) this.stopRecord();
    window.removeEventListener("resize", this.onResize);
    this.controls.dispose();
    this.renderer.dispose();
    this.root.remove();
    document.body.style.overflow = "";
  }
}
