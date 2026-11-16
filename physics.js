/* ==========================================================
   卓球のボールの軌道計算（3Dの軌道表示で使う）
   ----------------------------------------------------------
   座標（メートル）：
     x … 台の長い方向。自分のコートが x<0、相手のコートが x>0（自分は +x の向きに打つ）
     y … 横方向。+y が自分から見て左、-y が右
     z … 高さ。床が 0、台の上面が 0.76
   回転（ω、ラジアン/秒）：
     +y まわり … 上回転（ドライブ）、-y まわり … 下回転（ツッツキ）
     z まわり  … 横回転（-z：右に曲がる、+z：左に曲がる。自分から見て）
   空気抵抗・マグヌス力（回転で曲がる力）・重力と、台でのバウンド（摩擦で回転が変わる）を計算する
   ========================================================== */

export const TABLE = { L: 2.74, W: 1.525, H: 0.76, NET: 0.1525 };

const R = 0.02; // ボールの半径
const M = 0.0027; // 重さ
const AREA = Math.PI * R * R;
const RHO = 1.2; // 空気の密度
const CD = 0.5; // 抗力係数
const CM = 0.45; // マグヌス力の係数
const G = 9.81;
const E = 0.89; // 台での反発係数
const MU = 0.25; // 台との摩擦係数
const INERTIA = (2 / 3) * M * R * R; // 中空の球

const DRAG_K = (0.5 * RHO * AREA * CD) / M;
const MAGNUS_K = (0.5 * RHO * AREA * R * CM) / M;

export const rps = (n) => n * 2 * Math.PI;
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);

const onTable = (x, y) => Math.abs(x) <= TABLE.L / 2 && Math.abs(y) <= TABLE.W / 2;

/**
 * 打った瞬間の位置 p0・速度 v0・回転 w0 から軌道を計算する
 * 返り値：{ points: [{t, p:[x,y,z], w:[...]}], bounces: [{t, p}], net: bool, end }
 */
export function simulate(p0, v0, w0, { dt = 0.0005, maxT = 3, spin = true, sampleEvery = 0.004 } = {}) {
  let p = [...p0], v = [...v0], w = spin ? [...w0] : [0, 0, 0];
  const points = [{ t: 0, p: [...p], w: [...w] }];
  const bounces = [];
  let t = 0, nextSample = sampleEvery, net = false;
  while (t < maxT) {
    const speed = norm(v);
    const mag = cross(w, v);
    const a = [
      -DRAG_K * speed * v[0] + MAGNUS_K * mag[0],
      -DRAG_K * speed * v[1] + MAGNUS_K * mag[1],
      -DRAG_K * speed * v[2] + MAGNUS_K * mag[2] - G,
    ];
    const prev = [...p];
    v = [v[0] + a[0] * dt, v[1] + a[1] * dt, v[2] + a[2] * dt];
    p = [p[0] + v[0] * dt, p[1] + v[1] * dt, p[2] + v[2] * dt];
    t += dt;

    // ネット（x=0 を通るとき、ネットの高さより低ければ当たる）
    if ((prev[0] < 0) !== (p[0] < 0) && Math.abs(p[1]) < TABLE.W / 2 + TABLE.NET && p[2] - R < TABLE.H + TABLE.NET) {
      net = true;
      p[0] = prev[0] < 0 ? -R : R;
      points.push({ t, p: [...p], w: [...w] });
      return { points, bounces, net, end: "net" };
    }

    // 台でのバウンド
    if (v[2] < 0 && p[2] - R <= TABLE.H && prev[2] - R > TABLE.H - 0.02 && onTable(p[0], p[1])) {
      p[2] = TABLE.H + R;
      const vzIn = -v[2];
      v[2] = E * vzIn;
      // ボールと台が触れている点のすべり速度（横方向）
      const rc = [0, 0, -R];
      const wr = cross(w, rc);
      const u = [v[0] + wr[0], v[1] + wr[1]];
      const us = Math.hypot(u[0], u[1]);
      if (us > 1e-9) {
        // すべりを止めるのに必要な力積と、摩擦で出せる力積の小さい方
        const jMax = MU * (1 + E) * M * vzIn;
        const jRoll = (M * us * INERTIA) / (INERTIA + M * R * R);
        const j = Math.min(jMax, jRoll);
        const J = [(-u[0] / us) * j, (-u[1] / us) * j, 0];
        v[0] += J[0] / M;
        v[1] += J[1] / M;
        const dw = cross(rc, J);
        w = [w[0] + dw[0] / INERTIA, w[1] + dw[1] / INERTIA, w[2] + dw[2] / INERTIA];
      }
      bounces.push({ t, p: [...p] });
      points.push({ t, p: [...p], w: [...w] });
      nextSample = t + sampleEvery;
      if (bounces.length >= 3) break;
      continue;
    }

    if (t >= nextSample) {
      points.push({ t, p: [...p], w: [...w] });
      nextSample += sampleEvery;
    }
    // 台の横や手前から、台の高さより下にもぐった（台の角に当たった）
    if (p[2] - R < TABLE.H - 0.005 && onTable(p[0], p[1])) {
      points.push({ t, p: [...p], w: [...w] });
      return { points, bounces, net, end: "edge" };
    }
    // 床に落ちた／遠くへ飛んだら終わり
    if (p[2] < R || Math.abs(p[0]) > 4.5) break;
  }
  points.push({ t, p: [...p], w: [...w] });
  return { points, bounces, net, end: "out" };
}

/** 速さ・上下の角度・左右の角度（度）から速度ベクトルを作る */
function velocity(speed, elevDeg, aziDeg) {
  const e = (elevDeg * Math.PI) / 180, a = (aziDeg * Math.PI) / 180;
  return [speed * Math.cos(e) * Math.cos(a), speed * Math.cos(e) * Math.sin(a), speed * Math.sin(e)];
}

/**
 * 狙った場所に「最初のバウンド」が来るように、打ち出す角度を探す
 * shot: { p0, speed(m/s), spin:[x,y,z](回転/秒), target:[x,y] }
 * サーブ（自分のコートに1回バウンドさせる）は target を自分のコート（x<0）にする
 */
export function solveShot(shot) {
  const w0 = shot.spin.map(rps);
  let azi = (Math.atan2(shot.target[1] - shot.p0[1], shot.target[0] - shot.p0[0]) * 180) / Math.PI;
  let best = null;
  for (let round = 0; round < 6; round++) {
    // 上下の角度：最初のバウンドの x が target に合うように二分探索
    const landX = (elev) => {
      const r = simulate(shot.p0, velocity(shot.speed, elev, azi), w0, { maxT: 2, sampleEvery: 1 });
      if (r.bounces[0]) return r.bounces[0].p[0];
      if (r.net) return -Infinity;
      // 台に入らなかったときは、落ちた場所の x（手前に落ちれば小さく、奥へ飛べば大きくなる）
      return r.points[r.points.length - 1].p[0];
    };
    let lo = -45, hi = 60;
    // lo は手前すぎ、hi は遠すぎになるよう、上から順に探す
    for (let e = -45; e <= 60; e += 1) {
      const x = landX(e);
      if (x !== -Infinity && x >= shot.target[0]) { hi = e; break; }
      lo = e;
    }
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      const x = landX(mid);
      if (x === -Infinity || x < shot.target[0]) lo = mid;
      else hi = mid;
    }
    const elev = hi;
    const v0 = velocity(shot.speed, elev, azi);
    const r = simulate(shot.p0, v0, w0, { maxT: 2, sampleEvery: 1 });
    best = { elev, azi, v0 };
    const b = r.bounces[0];
    if (!b) break;
    // 横回転で曲がった分だけ、左右の狙いを直す
    const dy = shot.target[1] - b.p[1];
    if (Math.abs(dy) < 0.005) break;
    azi += ((dy / Math.hypot(b.p[0] - shot.p0[0], b.p[1] - shot.p0[1])) * 180) / Math.PI;
  }
  const w = w0;
  return {
    ...best,
    withSpin: simulate(shot.p0, best.v0, w),
    noSpin: simulate(shot.p0, best.v0, w, { spin: false }),
  };
}

/* ----------------------------------------------------------
   技ごとの打球の例（右利き・シェークハンド、中級者くらいの速さと回転）
   p0：打つ位置、speed：初速（m/s）、spin：[x,y,z] 回転/秒、target：最初のバウンドの場所
   stroke：体の使い方（fh＝フォア、bh＝バック、serve＝フォアサーブ）。3Dの選手の動きに使う
   ---------------------------------------------------------- */
export const SHOTS = {
  "fh-hit": {
    stroke: "fh",
    p0: [-1.75, -0.3, 0.98], speed: 9, spin: [0, 25, 0], target: [0.95, -0.3],
    note: "軽い上回転で、まっすぐ前へ。低く安定した弧を描く",
  },
  "bh-hit": {
    stroke: "bh",
    p0: [-1.65, 0.15, 1.02], speed: 8.5, spin: [0, 20, 0], target: [0.95, 0.3],
    note: "体の正面から、コンパクトに前へ",
  },
  push: {
    stroke: "bh",
    p0: [-1.05, 0.1, 0.9], speed: 5.5, spin: [0, -25, 0], target: [1.0, 0.3],
    note: "下回転。低く飛び、バウンド後も伸びずに止まり気味",
  },
  "fh-push": {
    stroke: "fh",
    p0: [-1.05, -0.3, 0.9], speed: 6, spin: [0, -25, 0], target: [1.0, -0.3],
    note: "フォア側の短い下回転を、下回転で低く返す。ひじを安定させてコンパクトに",
  },
  block: {
    stroke: "bh",
    p0: [-1.6, 0.1, 0.98], speed: 9, spin: [0, 15, 0], target: [0.85, 0.35],
    note: "相手のドライブの勢いを利用して、低く返す",
  },
  "fh-loop-under": {
    stroke: "fh",
    p0: [-2.0, -0.4, 0.82], speed: 12.5, spin: [0, 80, 0], target: [1.05, 0.35],
    note: "強い上回転で、高く打ち出しても急に落ちる。バウンド後は前に伸びる",
  },
  "fh-loop-top": {
    stroke: "fh",
    p0: [-2.1, -0.4, 1.0], speed: 19, spin: [0, 60, 0], target: [1.05, 0.4],
    note: "スピードのあるドライブ。低い弧で一気に相手コートへ",
  },
  "bh-loop": {
    stroke: "bh",
    p0: [-1.8, 0.1, 0.93], speed: 15, spin: [0, 60, 0], target: [1.05, 0.4],
    note: "体の正面から前上へ。上回転で落ちて台に入る",
  },
  counter: {
    stroke: "fh",
    p0: [-2.2, -0.35, 1.05], speed: 20, spin: [0, 55, 0], target: [1.1, 0.3],
    note: "相手のドライブをドライブで返す。速く低い弧",
  },
  stop: {
    stroke: "fh",
    p0: [-1.0, -0.1, 0.9], speed: 4.2, spin: [0, -20, 0], target: [0.3, 0.1],
    note: "ネット際に短く。相手コートで2回バウンドする長さ",
  },
  flick: {
    stroke: "fh",
    p0: [-1.0, -0.25, 0.92], speed: 9, spin: [0, 25, 0], target: [1.0, 0.45],
    note: "台上で前にはじく。低く速く相手コートの奥へ",
  },
  chiquita: {
    stroke: "bh",
    p0: [-1.0, 0.05, 0.92], speed: 11, spin: [0, 55, 45], target: [1.0, -0.15],
    note: "上回転＋横回転。空中で弧を描くように曲がる（バナナのように）",
  },
  "bs-serve": {
    stroke: "serve",
    p0: [-1.6, 0.45, 0.93], speed: 6, spin: [0, -40, 0], target: [-1.15, 0.35], serve: true,
    note: "強い下回転。相手コートで2回バウンドする短いサーブ。止まるように弾み、持ち上げにくい",
  },
  pendulum: {
    stroke: "serve",
    p0: [-1.6, 0.45, 0.95], speed: 7, spin: [0, -15, -45], target: [-1.0, 0.3], serve: true,
    note: "横下回転。自分から見て右へ曲がり、相手のバックへ逃げていく",
  },
  yg: {
    stroke: "serve",
    p0: [-1.6, 0.3, 0.95], speed: 7, spin: [0, -15, 45], target: [-1.1, 0.15], serve: true,
    note: "逆横回転。順横回転サーブとは反対向きに曲がる",
  },
  reverse: {
    stroke: "serve",
    p0: [-1.6, 0.0, 0.95], speed: 7, spin: [0, -10, 45], target: [-1.0, 0.0], serve: true,
    note: "逆横回転。横回転が強く、バウンド後に横へ跳ねる",
  },
  squat: {
    stroke: "serve",
    p0: [-1.6, 0.4, 0.95], speed: 7, spin: [0, -20, -40], target: [-1.0, 0.25], serve: true,
    note: "横下回転。振り方向を変えると、曲がる向きが逆になる",
  },
};

/* ----------------------------------------------------------
   打球から、当たった瞬間のラケットを逆算する（3Dの選手とインパクトの表示に使う）
   - ボールに回転をかけるには、ボールの表面と同じ向きにラケットをこする
   - 回転が強いほどラケット面は回転の向きに傾き（上回転ならかぶせる、下回転ならひらく）、
     スイングはこする向きに大きく振る
   ---------------------------------------------------------- */
export function contactRacket(v0, spinRps) {
  const w = spinRps.map(rps);
  const speed = norm(v0);
  const d = v0.map((x) => x / speed);
  // ラケットが当たる点（ボールの後ろ側）の表面の動き
  let t = cross(w, d.map((x) => -x * R));
  const along = t[0] * d[0] + t[1] * d[1] + t[2] * d[2];
  t = t.map((x, i) => x - along * d[i]);
  const surf = norm(t); // 表面の速さ（m/s）
  const tHat = surf > 1e-6 ? t.map((x) => x / surf) : [0, 0, 0];
  const share = surf / (surf + speed);
  const nRaw = d.map((x, i) => x - tHat[i] * 1.3 * share);
  const nLen = norm(nRaw);
  const n = nRaw.map((x) => x / nLen); // ラケット面の向き（ボールが飛ぶ側）
  const vr = d.map((x, i) => x * speed * 0.7 + tHat[i] * surf * 0.8); // ラケットの動き
  const vrLen = norm(vr);
  const swing = vr.map((x) => x / vrLen);
  const deg = (r) => (r * 180) / Math.PI;
  return {
    n,
    swing,
    brush: tHat,
    surfaceSpeed: surf,
    racketSpeed: vrLen,
    faceDeg: deg(Math.asin(Math.max(-1, Math.min(1, n[2])))), // マイナス＝かぶせる、プラス＝ひらく
    swingDeg: deg(Math.asin(Math.max(-1, Math.min(1, swing[2])))), // プラス＝振り上げる、マイナス＝振り下ろす
  };
}
