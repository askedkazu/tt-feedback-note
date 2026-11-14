/* ==========================================================
   スマホをラケットにして素振りする画面
   ----------------------------------------------------------
   - スマホの画面＝ラケットの面。握って振ると、センサーでスイングを測る
     ・速さ   … 回転の速さ（ジャイロ）× 腕の長さ
     ・振る向き … 加速度のうち、上向きの割合（上へ振ったか、下へ振ったか）
     ・面の角度 … いちばん速い瞬間の、画面の向き（かぶせる／ひらく）
   - 測ったスイングでボールを打ったら、どう飛ぶかを物理計算して「入った／ネット／オーバー」を判定する
   - 「3Dで見る」で、そのスイングの打球を3Dの画面で再生する
   ========================================================== */
import { simulate, solveShot, TABLE } from "./physics.js";

const LS_KEY = "ttNote.swing"; // 記録（回数・入った回数・最高速度）とセンサーの向きの補正
const START_OMEGA = 380; // この速さ（度/秒）を超えたらスイングが始まったとみなす
const END_OMEGA = 160;
const ARM = 0.5; // スマホの回る半径（腕＋ラケット）。回転の速さ×これ＝ラケットの速さ（m/秒）
const COOLDOWN_MS = 450; // 振ったあとの戻りの動きを、次のスイングと数えない
const R = 0.02;
const REBOUND = 3; // 相手の打球が跳ね返る分の速さ（m/秒）
// 入る打ち出し角度の幅は数度しかないので、スイングの角度のずれが TOLERANCE 度以内なら入るように広げて判定する
const TOLERANCE = 12;

const P0 = {
  fh: [-1.75, -0.3, 0.95],
  bh: [-1.65, 0.1, 0.95],
};

let current = null;

// 利き手（設定タブのプロフィール）。3Dの選手を左右反転するのに使う
function isLefty() {
  try {
    return (JSON.parse(localStorage.getItem("ttNote.profile"))?.hand ?? "左") === "左";
  } catch {
    return true;
  }
}

export function openSwing() {
  current?.dispose();
  current = new SwingView();
}

function loadStats() {
  try {
    return { count: 0, inCount: 0, best: 0, streak: 0, bestStreak: 0, sign: 0, ...JSON.parse(localStorage.getItem(LS_KEY)) };
  } catch {
    return { count: 0, inCount: 0, best: 0, streak: 0, bestStreak: 0, sign: 0 };
  }
}

const deg = (r) => (r * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/**
 * スイング（ラケットの速さ・振る角度・面の角度）から、打球を作る
 * - 面に垂直な成分でボールをはじき、面に沿った成分（こする動き）で回転をかける
 */
export function shotFromSwing({ speed, swingDeg, faceDeg, mode }) {
  const th = rad(faceDeg), ph = rad(swingDeg);
  const n = [Math.cos(th), 0, Math.sin(th)]; // 面の向き（プラス＝ひらく）
  const t = [-Math.sin(th), 0, Math.cos(th)]; // 面に沿って上向き
  const vn = speed * Math.cos(ph - th); // はじく速さ
  const vt = speed * Math.sin(ph - th); // こする速さ（プラス＝上へこする＝上回転）
  // ボールは「面の向き」と「振る向き」の間に飛ぶ。速さは、はじく速さ＋こする速さの一部＋相手の打球の跳ね返り（REBOUND）
  const ballSpeed = clamp(Math.max(0, vn) * 1.05 + Math.abs(vt) * 0.25 + REBOUND, 3, 30);
  const top = clamp((vt * 0.6) / (R * 2 * Math.PI), -120, 150); // 回転/秒
  const userElev = 0.55 * faceDeg + 0.45 * swingDeg; // 自分のスイングでの打ち出し角度
  // 同じ速さ・回転で、相手コートの真ん中に入る打ち出し角度
  const p0 = P0[mode];
  const target = [0.9, mode === "fh" ? -0.25 : 0.25];
  const ideal = solveShot({ p0, speed: ballSpeed, spin: [0, top, 0], target });
  const w0 = [0, top * 2 * Math.PI, 0];
  const velAt = (deg) => {
    const e = rad(deg), a = rad(ideal.azi);
    return [ballSpeed * Math.cos(e) * Math.cos(a), ballSpeed * Math.cos(e) * Math.sin(a), ballSpeed * Math.sin(e)];
  };
  // 実際に相手コートに入る打ち出し角度の範囲を探す
  const isIn = (deg) => {
    const r = simulate(p0, velAt(deg), w0, { maxT: 2, sampleEvery: 1 });
    return !r.net && r.bounces[0] && r.bounces[0].p[0] > 0;
  };
  let lo = ideal.elev, hi = ideal.elev;
  while (lo > ideal.elev - 20 && isIn(lo - 0.25)) lo -= 0.25;
  while (hi < ideal.elev + 20 && isIn(hi + 0.25)) hi += 0.25;
  const center = (lo + hi) / 2, half = Math.max(0.25, (hi - lo) / 2);
  // ずれ（TOLERANCE を1とした大きさ）を、入る範囲の中／外に当てはめる
  const k = (userElev - center) / TOLERANCE;
  const elev = Math.abs(k) <= 1 ? center + k * half * 0.9 : center + Math.sign(k) * (half + 0.5 + (Math.abs(k) - 1) * 6);
  const v0 = velAt(elev);
  const sim = simulate(p0, v0, [0, top * 2 * Math.PI, 0], { sampleEvery: 0.01 });
  return { p0, v0, spin: [0, top, 0], sim, outcome: judge(sim), n, swing: [Math.cos(ph), 0, Math.sin(ph)], elevError: userElev - center };
}

function judge(sim) {
  const b = sim.bounces[0];
  if (b && b.p[0] > 0) return { key: "in", label: "IN!", note: "相手コートに入った" };
  if (sim.net) return { key: "net", label: "NET", note: "ネットにかかった" };
  if (b && b.p[0] <= 0) return { key: "short", label: "SHORT", note: "自分のコートに落ちた（下に向きすぎ）" };
  const last = sim.points.at(-1).p;
  if (Math.abs(last[1]) > TABLE.W / 2 && last[0] > 0 && last[0] < TABLE.L / 2) return { key: "side", label: "SIDE", note: "横に出た" };
  if (last[0] > TABLE.L / 2) return { key: "over", label: "OVER", note: "台を越えた（上に向きすぎ・強すぎ）" };
  return { key: "short", label: "SHORT", note: "台に届かなかった" };
}

function describe(r) {
  const face = r.faceDeg < -5 ? `かぶせる ${Math.round(-r.faceDeg)}°` : r.faceDeg > 5 ? `ひらく ${Math.round(r.faceDeg)}°` : "ほぼ垂直";
  const swing = r.swingDeg > 10 ? `上へ ${Math.round(r.swingDeg)}°` : r.swingDeg < -10 ? `下へ ${Math.round(-r.swingDeg)}°` : "まっすぐ前へ";
  const top = r.shot.spin[1];
  const spin = top > 15 ? `上回転 ${Math.round(top)}` : top < -10 ? `下回転 ${Math.round(-top)}` : "回転少なめ";
  const type = top > 40 ? "ドライブ" : top > 15 ? "軽い上回転の打球" : top < -10 ? "ツッツキ系（下回転）" : "フラットな打球";
  return { face, swing, spin, type };
}

class SwingView {
  constructor() {
    this.stats = loadStats();
    this.mode = "fh";
    this.samples = [];
    this.state = "idle";
    this.lastSwingEnd = 0;
    this.orient = null; // { beta, gamma }（度）
    this.gravity = null; // 重力の向き（センサーの座標。止まっているときの値をなめらかにしたもの）
    this.last = null; // 最後のスイングの結果
    this.onMotion = this.onMotion.bind(this);
    this.onOrient = this.onOrient.bind(this);
    this.build();
  }

  build() {
    const root = document.createElement("div");
    root.className = "traj-overlay sw-overlay";
    root.innerHTML = `
      <div class="traj-head">
        <button class="traj-close" aria-label="閉じる">✕</button>
        <div class="flex-1 min-w-0">
          <p class="traj-title">📱 スマホでスイング</p>
          <p class="traj-sub">スマホをラケットにして素振り。入ったかどうか判定します</p>
        </div>
      </div>
      <div class="sw-body">
        <section class="sw-step" data-step="start">
          <div class="sw-howto">
            <p class="sw-big">📱＝🏓</p>
            <ol>
              <li><b>画面がラケットの面</b>です。画面を前（相手の方）に向けて握ります</li>
              <li>フォアかバックを選んで、いつものように素振り</li>
              <li>速さ・ラケットの角度・振る向きから、ボールがどう飛ぶか計算します</li>
            </ol>
            <p class="sw-warn">⚠️ スマホを飛ばさないよう、しっかり握るかストラップを付けて。周りに人や物がない所で振ってください。</p>
          </div>
          <button class="sw-main-btn" data-act="sensor">センサーを使う</button>
          <button class="sw-sub-btn" data-act="demo">センサーなしで試す（ランダムなスイング）</button>
        </section>

        <section class="sw-step hidden" data-step="calib">
          <div class="sw-howto">
            <p class="sw-big">📱</p>
            <p class="sw-lead">画面を上に向けて、<br />平らに持ってください</p>
            <p class="text-sm text-slate-500 mt-2">センサーの向きを合わせます（はじめの1回だけ）</p>
          </div>
          <button class="sw-main-btn" data-act="calib">平らに持った</button>
        </section>

        <section class="sw-step hidden" data-step="play">
          <div class="traj-seg sw-mode" data-group="mode">
            <button data-mode="fh" class="on">フォア</button>
            <button data-mode="bh">バック</button>
          </div>
          <div class="sw-result">
            <p class="sw-outcome">振ってみよう！</p>
            <p class="sw-outcome-note">画面を前に向けて、しっかり握って</p>
            <div class="sw-speed"><span class="sw-num">--</span><small>km/h</small></div>
            <p class="sw-speed-label">ラケットの速さ</p>
            <div class="sw-grid">
              <span><b>ラケット面</b><i data-f="face">--</i></span>
              <span><b>振る向き</b><i data-f="swing">--</i></span>
              <span><b>回転</b><i data-f="spin">--</i></span>
              <span><b>ボールの速さ</b><i data-f="ball">--</i></span>
            </div>
            <p class="sw-type" data-f="type"></p>
          </div>
          <button class="sw-main-btn hidden" data-act="view3d">🎥 このスイングを3Dで見る</button>
          <div class="sw-stats">
            <span><b data-s="count">0</b>回</span>
            <span>IN率 <b data-s="rate">-</b></span>
            <span>連続IN <b data-s="streak">0</b></span>
            <span>最高 <b data-s="best">0</b>km/h</span>
          </div>
          <button class="sw-sub-btn" data-act="demo">ランダムなスイングで試す</button>
          <button class="sw-sub-btn" data-act="reset">記録をリセット</button>
        </section>
        <p class="sw-msg hidden"></p>
      </div>`;
    document.body.appendChild(root);
    document.body.style.overflow = "hidden";
    this.root = root;
    root.querySelector(".traj-close").onclick = () => this.dispose();
    root.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (b) this.action(b.dataset.act);
      const m = e.target.closest("[data-mode]");
      if (m) {
        this.mode = m.dataset.mode;
        root.querySelectorAll("[data-mode]").forEach((x) => x.classList.toggle("on", x === m));
      }
    });
    this.renderStats();
  }

  q(sel) {
    return this.root.querySelector(sel);
  }

  showStep(name) {
    this.root.querySelectorAll(".sw-step").forEach((s) => s.classList.toggle("hidden", s.dataset.step !== name));
  }

  msg(text) {
    const m = this.q(".sw-msg");
    m.textContent = text || "";
    m.classList.toggle("hidden", !text);
  }

  async action(act) {
    if (act === "sensor") return this.startSensors();
    if (act === "calib") return this.calibrate();
    if (act === "demo") {
      this.showStep("play");
      return this.demoSwing();
    }
    if (act === "view3d") return this.view3d();
    if (act === "reset") {
      if (!confirm("素振りの記録をリセットしますか？")) return;
      this.stats = { ...this.stats, count: 0, inCount: 0, best: 0, streak: 0, bestStreak: 0 };
      this.save();
      this.renderStats();
    }
  }

  /* ---------- センサー ---------- */
  async startSensors() {
    this.msg("");
    // iPhone は、ボタンを押したときに許可をもらう必要がある（許可がなくても値が届く端末もあるので、続ける）
    let denied = false;
    try {
      if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
        denied = (await DeviceMotionEvent.requestPermission()) !== "granted";
        if (typeof DeviceOrientationEvent?.requestPermission === "function") await DeviceOrientationEvent.requestPermission().catch(() => {});
      }
    } catch (err) {
      console.error(err);
      denied = true;
    }
    window.addEventListener("devicemotion", this.onMotion);
    window.addEventListener("deviceorientation", this.onOrient);
    // しばらく待ってもセンサーの値が来なければ、使えない端末
    this.gotMotion = false;
    setTimeout(() => {
      if (this.gotMotion) return;
      this.msg(
        denied
          ? "センサーの使用が許可されませんでした。iPhone は、いったん閉じてもう一度「センサーを使う」を押し、「許可」を選んでください"
          : "センサーの値が取れませんでした。スマホのブラウザで開いてください（PCでは「センサーなしで試す」が使えます）"
      );
    }, 1500);
    if (this.stats.sign) this.showStep("play");
    else this.showStep("calib");
  }

  calibrate() {
    const g = this.gravity;
    if (!g || Math.abs(g[2]) < 6) {
      this.msg("もう少し平らに、画面を上に向けて持ってから押してください");
      return;
    }
    // 端末によって加速度の符号が逆のことがあるので、画面が上のときの向きを覚えておく
    this.stats.sign = Math.sign(g[2]);
    this.save();
    this.msg("");
    this.showStep("play");
  }

  onOrient(e) {
    if (e.beta == null || e.gamma == null) return;
    this.orient = { beta: e.beta, gamma: e.gamma };
  }

  /** 世界の「上」の向きを、スマホの座標で表したもの */
  upVector() {
    if (this.orient) {
      const b = rad(this.orient.beta), g = rad(this.orient.gamma);
      return [-Math.cos(b) * Math.sin(g), Math.sin(b), Math.cos(b) * Math.cos(g)];
    }
    if (this.gravity && this.stats.sign) {
      const s = this.stats.sign, l = Math.hypot(...this.gravity) || 1;
      return this.gravity.map((x) => (x * s) / l);
    }
    return null;
  }

  onMotion(e) {
    this.gotMotion = true;
    const aig = e.accelerationIncludingGravity;
    const r = e.rotationRate;
    if (!r) return;
    const omega = Math.hypot(r.alpha || 0, r.beta || 0, r.gamma || 0); // 度/秒
    let lin = null;
    if (e.acceleration && e.acceleration.x != null) lin = [e.acceleration.x, e.acceleration.y, e.acceleration.z];
    if (aig && aig.x != null) {
      const v = [aig.x, aig.y, aig.z];
      if (this.state === "idle" && omega < 60) this.gravity = this.gravity ? this.gravity.map((x, i) => x * 0.85 + v[i] * 0.15) : v;
      if (!lin && this.gravity) lin = v.map((x, i) => x - this.gravity[i]);
    }
    if (this.state === "play-ignore") return;
    const now = e.timeStamp || performance.now();
    const sample = { t: now, omega, lin, up: this.upVector() };

    if (this.state === "idle") {
      if (omega > START_OMEGA && now - this.lastSwingEnd > COOLDOWN_MS && this.stats.sign) {
        this.state = "swing";
        this.samples = [sample];
      }
      return;
    }
    // スイング中
    this.samples.push(sample);
    const dur = now - this.samples[0].t;
    const quiet = this.samples.slice(-4).every((s) => s.omega < END_OMEGA);
    if (quiet || dur > 700) {
      this.state = "idle";
      this.lastSwingEnd = now;
      this.analyze(this.samples);
    }
  }

  /** 1回のスイングを調べる */
  analyze(samples) {
    if (samples.length < 3) return;
    const peak = samples.reduce((a, b) => (b.omega > a.omega ? b : a));
    const speed = clamp(rad(peak.omega) * ARM, 1, 32); // m/秒
    // 速いところ（いちばん速い瞬間の60%以上）で、加速度の上向きの割合を見る
    const s = this.stats.sign || 1;
    let upSum = 0, absSum = 0;
    for (const x of samples) {
      if (x.omega < peak.omega * 0.6 || !x.lin || !x.up) continue;
      const a = x.lin.map((v) => v * s);
      upSum += a[0] * x.up[0] + a[1] * x.up[1] + a[2] * x.up[2];
      absSum += Math.hypot(...a);
    }
    const u = absSum > 0 ? clamp(upSum / absSum, -1, 1) : 0;
    const swingDeg = clamp(deg(Math.asin(u)), -70, 80);
    // 面の角度：いちばん速い瞬間の、画面の向き（上に向いているほど「ひらく」）
    const up = peak.up || [0, 0, 0];
    const faceDeg = clamp(deg(Math.asin(clamp(up[2], -1, 1))), -80, 80);
    this.showResult({ speed, swingDeg, faceDeg });
  }

  demoSwing() {
    const r = (a, b) => a + Math.random() * (b - a);
    this.showResult({ speed: r(8, 20), swingDeg: r(10, 60), faceDeg: r(-35, 10) });
  }

  showResult({ speed, swingDeg, faceDeg }) {
    const shot = shotFromSwing({ speed, swingDeg, faceDeg, mode: this.mode });
    const r = { speed, swingDeg, faceDeg, shot, mode: this.mode };
    this.last = r;
    const d = describe(r);
    const kmh = Math.round(speed * 3.6);
    const ballKmh = Math.round(Math.hypot(...shot.v0) * 3.6);

    // 記録
    const st = this.stats;
    st.count++;
    if (shot.outcome.key === "in") {
      st.inCount++;
      st.streak++;
      st.bestStreak = Math.max(st.bestStreak, st.streak);
    } else st.streak = 0;
    const newBest = kmh > st.best;
    st.best = Math.max(st.best, kmh);
    this.save();

    const o = this.q(".sw-outcome");
    o.textContent = shot.outcome.label;
    o.className = `sw-outcome ${shot.outcome.key}`;
    void o.offsetWidth; // アニメーションをやり直す
    o.classList.add("pop");
    this.q(".sw-outcome-note").textContent = shot.outcome.note + (newBest && st.count > 1 ? "　🔥最高速度更新！" : "");
    this.q(".sw-num").textContent = kmh;
    this.q('[data-f="face"]').textContent = d.face;
    this.q('[data-f="swing"]').textContent = d.swing;
    this.q('[data-f="spin"]').textContent = d.spin;
    this.q('[data-f="ball"]').textContent = `${ballKmh}km/h`;
    this.q('[data-f="type"]').textContent = `→ ${d.type}`;
    this.q('[data-act="view3d"]').classList.remove("hidden");
    this.renderStats();
    if (navigator.vibrate) navigator.vibrate(shot.outcome.key === "in" ? 40 : [30, 60, 30]);
  }

  renderStats() {
    const st = this.stats;
    this.q('[data-s="count"]').textContent = st.count;
    this.q('[data-s="rate"]').textContent = st.count ? `${Math.round((st.inCount / st.count) * 100)}%` : "-";
    this.q('[data-s="streak"]').textContent = `${st.streak}（最高${st.bestStreak}）`;
    this.q('[data-s="best"]').textContent = st.best;
  }

  save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(this.stats));
    } catch {}
  }

  async view3d() {
    const r = this.last;
    if (!r) return;
    const btn = this.q('[data-act="view3d"]');
    btn.disabled = true;
    btn.textContent = "3Dを準備中…";
    // 3Dを見ている間は、スイングとして数えない
    const prev = this.state;
    this.state = "play-ignore";
    try {
      const mod = await import("./trajectory-view.js");
      const d = describe(r);
      mod.openCustomShot({
        title: `📱 あなたのスイング（${r.mode === "fh" ? "フォア" : "バック"}）`,
        shot: { p0: r.shot.p0, v0: r.shot.v0, spin: r.shot.spin, stroke: r.mode, note: `${r.shot.outcome.label}　${r.shot.outcome.note}（${d.type}）` },
        contact: { n: r.shot.n, swing: r.shot.swing, faceDeg: r.faceDeg, swingDeg: r.swingDeg },
        startView: "side",
        lefty: isLefty(),
      });
      // 3Dを閉じたら、また振れるようにする
      const watch = setInterval(() => {
        if (!document.querySelector(".traj-overlay:not(.sw-overlay)")) {
          clearInterval(watch);
          this.state = prev === "play-ignore" ? "idle" : prev;
          document.body.style.overflow = "hidden";
        }
      }, 400);
    } catch (err) {
      console.error(err);
      this.state = "idle";
      alert(`3Dの表示を読み込めませんでした。\n${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "🎥 このスイングを3Dで見る";
    }
  }

  dispose() {
    window.removeEventListener("devicemotion", this.onMotion);
    window.removeEventListener("deviceorientation", this.onOrient);
    this.root.remove();
    document.body.style.overflow = "";
    if (current === this) current = null;
  }
}
