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
  current = new TrajectoryView({ title: `${tech.icon} ${tech.name}`, shot, solved: solveShot(shot) });
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
const STROKES = {
  // 打つ位置から見た腰の位置、足の位置（体の前＝+x、左＝+y）、体のひねり（ラジアン）、前かがみ
  fh: { pelvis: [-0.32, 0.4], feetR: [-0.14, -0.3], feetL: [0.18, 0.28], yaw: [-0.75, -0.15, 0.5], lean: 0.28, ready: 0 },
  // バック：前かがみは浅めの高い姿勢（卓球レポート「基本のバックハンド」の連続写真を参考）
  bh: { pelvis: [-0.45, 0.04], feetR: [0.02, -0.3], feetL: [0.02, 0.3], yaw: [0.3, 0.0, -0.15], lean: 0.2, ready: 0, height: 0.92 },
  serve: { pelvis: [-0.3, 0.32], feetR: [-0.12, -0.24], feetL: [0.2, 0.26], yaw: [-1.0, -0.7, -0.35], lean: 0.38, ready: -0.8 },
};

/* スイングの形（右利き・体から見た位置：前＝x、左＝y、上＝z、腰が原点）
   back＝引いたときのラケット、follow＝振り抜いたときのラケット */
const SWINGS = {
  fh: {
    // ドライブ（卓球レポート「ようこそ卓球 フォアハンドドライブ」の連続写真を参考）：腰を大きくひねって
    // 利き手側の足に重心をかけ、ひざの高さまで低く引く → 床を蹴って腰を回し斜め上へ → 反対の足に重心を移して頭の高さへ
    drive: {
      back: [-0.05, -0.55, -0.38],
      follow: [0.3, 0.08, 0.62],
      weight: [[-0.3, -0.09], [0, -0.02], [0.25, 0.09], [0.8, 0]], // 横の重心（マイナス＝利き手側の足）
      dip: [[-0.3, 0.08], [0, 0.03], [0.25, -0.01], [0.8, 0]], // ひざの曲げ（沈み込み）
    },
    // フォアロング（卓球レポート「ようこそ卓球 フォアハンドロング」の連続写真を参考）：
    // 腰を小さくひねってラケットを腰の横へ（体より後ろに引かない）、体の斜め前で軽く押すように打ち、斜め上へ小さく振る
    hit: {
      back: [0.1, -0.42, 0.02],
      follow: [0.32, -0.02, 0.36],
      yaw: [-0.4, -0.1, 0.3],
      elbow: [[-0.3, [-0.2, -0.7, -0.7]], [0, [0.1, -0.8, -0.5]], [0.22, [0.25, -0.8, -0.3]]], // ひじは上げすぎない
    },
  },
  // バック：手首を内側に曲げておなかの前に引き寄せ、面を立てて前にはじき、顔の高さまで前上へ振り抜く
  bh: {
    drive: { back: [0.18, 0.02, 0.02], follow: [0.52, -0.25, 0.5] },
    hit: { back: [0.2, 0.0, 0.12], follow: [0.55, -0.12, 0.5] },
  },
};
// ひじの向き（体から見た向き）：引き → 打球 → 振り抜き
const ELBOW_POLE = {
  fh: [[-0.3, [-0.4, -0.7, -0.6]], [0, [0.1, -0.8, -0.5]], [0.22, [0.3, -0.7, 0.35]]],
  bh: [[-0.3, [0.45, -0.3, -0.85]], [0, [0.4, -0.35, -0.85]], [0.22, [0.3, -0.5, -0.6]]], // ひじは低く、体の前
  serve: [[-0.3, [-0.3, -0.8, 0.1]], [0, [0, -0.8, -0.5]], [0.22, [0.2, -0.8, -0.4]]],
};
const GRIP_ANGLE = 0.45; // シェークハンドは、グリップを前腕に対して斜め（約25°）に握る
// 手首：引くときに内側に曲げ（ラケットの先が下がる）、打つ瞬間に戻し、振り抜きで少し返す（ラジアン）
const WRIST = {
  fh: [[-0.3, 0.3], [0, 0], [0.22, -0.15]],
  bh: [[-0.3, 0.75], [0, 0], [0.22, -0.2]],
  serve: [[-0.3, 0.55], [0, 0], [0.22, -0.3]],
};

class Player {
  constructor(scene, shot, contact) {
    this.shot = shot;
    this.contact = contact;
    this.cfg = STROKES[shot.stroke] || STROKES.fh;
    const p0 = shot.p0;
    const cfg = this.cfg;

    // 立つ位置（台にめりこまないように、台の端より後ろ）
    let px = Math.min(p0[0] + cfg.pelvis[0], -TABLE.L / 2 - 0.2);
    const py = p0[1] + cfg.pelvis[1];
    const low = p0[2] < 0.85 ? 0.07 : 0;
    this.pelvis0 = [px, py, (cfg.height || 0.88) - low];
    // 打つ位置が台の上（短い球）なら、前にかがんで右足を台の下に踏み込む
    this.reachOver = clamp((p0[0] - (px + 0.35)) * 1.3, 0, 0.55);
    this.lean = cfg.lean + this.reachOver;
    const stepIn = this.reachOver > 0.05 && shot.stroke !== "serve";
    this.footR = [px + (stepIn ? 0.42 : cfg.feetR[0]), py + cfg.feetR[1], 0.04];
    this.footL = [px + cfg.feetL[0], py + cfg.feetL[1], 0.04];

    // ラケットの通り道（打つ瞬間に、ボールの後ろにラケット面が来る）
    const n = contact.n, D = contact.swing;
    this.n = n;
    this.c0 = sub(p0, mul(n, 0.02 + 0.006));
    // スイングの種類：ドライブ（大きく振り上げる）、打つ、ツッツキ（下へ）、台上（小さく）、サーブ
    const compact = this.reachOver > 0.05 && shot.stroke !== "serve";
    const kind =
      shot.stroke === "serve" ? "serve" : contact.swingDeg < -5 ? "push" : compact ? "short" : (contact.racketSpeed || 0) > 10 ? "drive" : "hit";
    this.kind = kind;
    let back, follow;
    const tpl = SWINGS[shot.stroke]?.[kind];
    if (tpl?.yaw) this.yawKeys = tpl.yaw; // 技によって体のひねりの大きさを変える
    if (tpl?.weight) this.weightKeys = tpl.weight;
    if (tpl?.dip) this.dipKeys = tpl.dip;
    if (tpl) {
      back = this.bodyPoint(tpl.back, this.yawAt(-0.3));
      follow = this.bodyPoint(tpl.follow, this.yawAt(0.22));
    } else {
      // ツッツキ・台上・サーブは、振る向きにそって短く（サーブは上から振り下ろす）
      const L = { push: [0.28, 0.25, 0.04], short: [0.18, 0.28, -0.03], serve: [0.32, 0.35, 0.12] }[kind];
      back = add(sub(this.c0, mul(D, L[0])), [0, 0, L[2]]);
      follow = add(this.c0, mul(D, L[1]));
    }
    // 打つ瞬間の前後は、振る向き（D）にまっすぐ通す
    const pts = [back, sub(this.c0, mul(D, 0.15)), this.c0, add(this.c0, mul(D, 0.15)), follow].map((p) => new THREE.Vector3(...p));
    this.curve = new THREE.CatmullRomCurve3(pts, false, "centripetal");
    this.elbowKeys = tpl?.elbow || ELBOW_POLE[shot.stroke] || ELBOW_POLE.fh;

    // 斜めの握り：打つ瞬間にラケットの先が上を向く側に傾ける
    // どちらに傾けてもラケットの真ん中は同じなので、手の高さで比べる：手が低い方＝ラケットの先が上
    this.gripSign = this._handZ(1) <= this._handZ(-1) ? 1 : -1;

    this.build(scene);
  }

  /** 体から見た位置（腰が原点、前・左・上）を、物理の座標にする */
  bodyPoint(p, yaw) {
    const fwd = [Math.cos(yaw), Math.sin(yaw), 0];
    const left = [-Math.sin(yaw), Math.cos(yaw), 0];
    return add(add(add(this.pelvis0, mul(fwd, p[0])), mul(left, p[1])), [0, 0, p[2]]);
  }

  _handZ(sign) {
    const keep = this.gripSign;
    this.gripSign = sign;
    const z = this.joints(0, this.c0).handR[2];
    this.gripSign = keep;
    return z;
  }

  /** 時刻 t の体のひねり（ラジアン） */
  yawAt(t) {
    const [b, c, f] = this.yawKeys || this.cfg.yaw;
    const r = this.cfg.ready;
    return keyed([[-0.6, r], [-0.3, b], [0, c], [0.22, f], [0.4, f], [0.8, r]], t);
  }

  /** ラケットの真ん中の位置 */
  racketAt(t, readyPos) {
    const u = keyed([[-0.3, 0], [-0.1, 0.3], [0, 0.5], [0.08, 0.72], [0.22, 1]], t);
    const onCurve = this.curve.getPoint(clamp(u, 0, 1)).toArray();
    if (t < -0.3) return lerpV(readyPos, this.curve.getPoint(0).toArray(), smooth(clamp((t + 0.6) / 0.3, 0, 1)));
    if (t > 0.3) return lerpV(onCurve, readyPos, smooth(clamp((t - 0.3) / 0.45, 0, 1)));
    return onCurve;
  }

  /** 関節の位置（物理の座標）を計算する */
  joints(t, racketCenter) {
    const yaw = this.yawAt(t);
    const fwd = [Math.cos(yaw), Math.sin(yaw), 0];
    const left = [-Math.sin(yaw), Math.cos(yaw), 0];
    // 打つ瞬間に向けて少し前に体重を移す
    const shift = keyed([[-0.3, -0.05], [0, 0.03], [0.25, 0.06], [0.8, 0]], t);
    const dip = keyed(this.dipKeys || [[-0.3, 0.03], [0, 0], [0.3, -0.01]], t);
    // 横の重心移動（ドライブ：利き手側の足 → 反対の足）
    const lat = this.weightKeys ? keyed(this.weightKeys, t) : 0;
    const pelvis = add(add(this.pelvis0, [shift, 0, -dip]), mul(left, lat));
    const spine = add(mul(fwd, Math.sin(this.lean)), [0, 0, Math.cos(this.lean)]);
    const chest = add(pelvis, mul(spine, 0.36));
    const neck = add(pelvis, mul(spine, 0.5));
    const head = add(neck, add(mul(spine, 0.11), mul(fwd, 0.03)));
    const shR = add(add(chest, mul(spine, 0.1)), mul(left, -0.19));
    const shL = add(add(chest, mul(spine, 0.1)), mul(left, 0.19));
    const hipR = add(pelvis, mul(left, -0.1));
    const hipL = add(pelvis, mul(left, 0.1));
    const kneeR = solveJoint(hipR, this.footR, 0.45, 0.45, add(fwd, [0, -0.2, 0]));
    const kneeL = solveJoint(hipL, this.footL, 0.45, 0.45, add(fwd, [0, 0.2, 0]));

    // 右手：ラケットのグリップ
    let handR = null, elbowR = null, handle = null;
    if (racketCenter) {
      // ひじの向き（引き → 打球 → 振り抜きで、下・後ろ → 横 → 肩の高さへ）
      const pl = keyedV(this.elbowKeys || ELBOW_POLE.fh, t);
      const pole = add(add(mul(fwd, pl[0]), mul(left, pl[1])), [0, 0, pl[2]]);
      // グリップは前腕の延長線上に、斜めに握る（何回か計算して、手・ひじ・グリップの向きをそろえる）
      let h = perp(sub(shR, racketCenter), this.n);
      h = len(h) > 1e-6 ? unit(h) : [0, 0, 1];
      for (let k = 0; k < 3; k++) {
        handR = reach(shR, add(racketCenter, mul(h, GRIP)), 0.57);
        elbowR = solveJoint(shR, handR, 0.3, 0.28, pole);
        const toElbow = perp(sub(elbowR, handR), this.n);
        // 斜めの握り（先が上がる向き）と、手首の曲げ（先が下がる向き）
        const wrist = keyed(WRIST[this.shot.stroke] || WRIST.fh, t);
        if (len(toElbow) > 1e-6) h = rotAround(unit(toElbow), this.n, (this.gripSign || 1) * (GRIP_ANGLE - wrist));
      }
      handle = h;
      // 手が届かないときは手をとどく所まで引き寄せ、ラケットは必ず手に持たせる
      handR = reach(shR, add(racketCenter, mul(handle, GRIP)), 0.57);
      elbowR = solveJoint(shR, handR, 0.3, 0.28, pole);
      racketCenter = sub(handR, mul(handle, GRIP));
    }
    // 左手：バランスをとる（サーブではトスを上げる）
    let handL;
    if (this.shot.stroke === "serve") {
      const palm = this.tossPalm();
      handL = t < -0.5 ? palm : lerpV(palm, add(add(chest, mul(left, 0.35)), [0, 0, -0.1]), smooth(clamp((t + 0.5) / 0.4, 0, 1)));
    } else {
      handL = add(add(add(chest, mul(fwd, 0.3)), mul(left, 0.22)), [0, 0, -0.12]);
    }
    const elbowL = solveJoint(shL, reach(shL, handL, 0.57), 0.3, 0.28, add(mul(left, 0.8), [0, 0, -0.6]));
    return { pelvis, chest, neck, head, shR, shL, hipR, hipL, kneeR, kneeL, footR: this.footR, footL: this.footL, handR, elbowR, handL: reach(shL, handL, 0.57), elbowL, handle, racketCenter, fwd, left };
  }

  /** サーブのトスを上げる手の位置 */
  tossPalm() {
    return add(this.shot.p0, [0.04, 0.22, 0.02]);
  }

  readyRacket(j) {
    // 構えのとき：体の前、おなかの高さ（バックは胸の前）
    const bh = this.shot.stroke === "bh";
    return add(add(add(j.chest, mul(j.fwd, bh ? 0.35 : 0.4)), mul(j.left, bh ? 0.02 : -0.2)), [0, 0, bh ? -0.04 : -0.22]);
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
    // 手のひら（グリップの、親指と反対側をつつむ）
    const fist = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.03, 0.075), skin);
    fist.position.set(0.012, 0.004 * side, GRIP + 0.005);
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
    for (const z of [0.112, 0.13, 0.148]) {
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
    const pre = this.joints(t, null);
    const j = this.joints(t, this.racketAt(t, this.readyRacket(pre)));
    const center = j.racketCenter; // 手ににぎった位置
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
    for (const [foot, pos] of [[P.footR, j.footR], [P.footL, j.footL]]) {
      foot.position.copy(toV3(pos));
      foot.rotation.y = this.yawAt(0) * 0.5;
    }

    // ラケット：面はボールが飛ぶ側、グリップは手の方
    const yAxis = toV3(this.n).normalize();
    const zAxis = toV3(j.handle).normalize();
    const xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis).normalize();
    this.racket.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis));
    this.racket.position.copy(toV3(center));
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
    if (key === "grip") {
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
