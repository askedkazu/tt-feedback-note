/* ==========================================================
   ボールの軌道を3Dで見る画面（three.js）
   - physics.js で計算した軌道を、台・ネットと一緒に再生する
   - スロー再生、視点の切り替え、回転なしの軌道との比較、動画として保存
   ========================================================== */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SHOTS, TABLE, solveShot } from "./physics.js";

// 物理の座標（x:長さ, y:横, z:高さ）→ three.js の座標（y が上）
const toV3 = (p) => new THREE.Vector3(p[0], p[2], -p[1]);

const VIEWS = {
  back: { label: "後ろ", pos: [-3.4, 1.75, 0.0], target: [0.4, 0.76, 0] },
  side: { label: "横", pos: [-0.2, 1.15, 3.4], target: [-0.1, 0.85, 0] },
  top: { label: "上", pos: [0.0, 4.6, 0.01], target: [0, 0.76, 0] },
  front: { label: "相手側", pos: [3.4, 1.6, 0.0], target: [-0.3, 0.8, 0] },
};
const RATES = [
  { label: "1/4", value: 0.25 },
  { label: "1/2", value: 0.5 },
  { label: "等速", value: 1 },
];
const END_PAUSE = 0.9; // 最後まで行ったら少し止まってからくり返す（秒）
const MAX_VISUAL_SPIN = 2.5; // 画面上のボールの回転は、見える速さ（回転/秒）までにおさえる

export const hasShot = (techId) => !!SHOTS[techId];

let current = null; // 開いている画面（1つだけ）

export function openTrajectory(tech) {
  const shot = SHOTS[tech.id];
  if (!shot) return;
  closeTrajectory();
  const solved = solveShot(shot);
  current = new TrajectoryView(tech, shot, solved);
}

export function closeTrajectory() {
  current?.dispose();
  current = null;
}

class TrajectoryView {
  constructor(tech, shot, solved) {
    this.tech = tech;
    this.shot = shot;
    this.solved = solved;
    this.rate = 0.25;
    this.t = 0;
    this.playing = true;
    this.showGhost = true;
    this.duration = solved.withSpin.points.at(-1).t;
    this.buildDom();
    this.buildScene();
    this.setView("back");
    this.last = performance.now();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  /* ---------- 画面の部品 ---------- */
  buildDom() {
    const s = this.shot;
    const v0 = this.solved.v0;
    const kmh = Math.round(Math.hypot(...v0) * 3.6);
    const [, top, side] = s.spin;
    const spinText = [
      top > 0 ? `上回転 ${top}` : top < 0 ? `下回転 ${-top}` : "",
      side ? `横回転 ${Math.abs(side)}` : "",
    ]
      .filter(Boolean)
      .join("・");
    const root = document.createElement("div");
    root.className = "traj-overlay";
    root.innerHTML = `
      <div class="traj-head">
        <button class="traj-close" aria-label="閉じる">✕</button>
        <div class="flex-1 min-w-0">
          <p class="traj-title">${this.tech.icon} ${this.tech.name}</p>
          <p class="traj-sub">初速 約${kmh}km/h ・ ${spinText}（回転/秒）</p>
        </div>
      </div>
      <div class="traj-stage"><canvas></canvas><p class="traj-clock"></p></div>
      <div class="traj-panel">
        <p class="traj-note">${this.shot.note}</p>
        <div class="traj-row">
          <button class="traj-play">一時停止</button>
          <div class="traj-seg" data-group="rate">${RATES.map((r) => `<button data-rate="${r.value}">${r.label}</button>`).join("")}</div>
        </div>
        <div class="traj-row">
          <span class="traj-label">視点</span>
          <div class="traj-seg" data-group="view">${Object.entries(VIEWS).map(([k, v]) => `<button data-view="${k}">${v.label}</button>`).join("")}</div>
        </div>
        <label class="traj-row traj-check">
          <input type="checkbox" class="traj-ghost" checked />
          <span><span class="traj-swatch"></span>回転なしだとこう飛ぶ（比較）</span>
        </label>
        <button class="traj-rec">🎬 動画として保存</button>
        <p class="traj-foot">数値は中級者くらいの打球の例です（右利き）。指でぐるっと回したり、2本指で拡大したりできます。</p>
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
      if (this.playing && this.t >= this.duration) this.t = 0;
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
      this.ghostGroup.visible = this.showGhost;
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
    const v = VIEWS[key];
    this.viewKey = key;
    // 縦長の画面（スマホ）では台が入りきるように、カメラを遠ざける
    const far = Math.min(2.4, Math.max(1, 1.2 / this.camera.aspect));
    const target = new THREE.Vector3(...v.target);
    const pos = new THREE.Vector3(...v.pos).sub(target).multiplyScalar(key === "top" ? Math.max(1, far * 0.8) : far).add(target);
    this.camera.position.copy(pos);
    this.controls.target.copy(target);
    this.controls.update();
    this.root.querySelectorAll("[data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === key));
  }

  /* ---------- 3Dの場面 ---------- */
  buildScene() {
    const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer = renderer;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f172a);
    scene.fog = new THREE.Fog(0x0f172a, 7, 14);
    this.scene = scene;
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 50);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 0.8;
    this.controls.maxDistance = 9;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-2, 5, 3);
    scene.add(sun);

    // 床
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(14, 10), new THREE.MeshStandardMaterial({ color: 0x7c2d12, roughness: 0.9 }));
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);

    // 台
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(TABLE.L, 0.03, TABLE.W),
      new THREE.MeshStandardMaterial({ color: 0x1d4ed8, roughness: 0.55 })
    );
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

    // 打つ位置（ラケット）
    const p0 = toV3(this.shot.p0);
    const racket = new THREE.Mesh(
      new THREE.CylinderGeometry(0.075, 0.075, 0.01, 32),
      new THREE.MeshStandardMaterial({ color: 0xdc2626, transparent: true, opacity: 0.55 })
    );
    racket.position.copy(p0).add(new THREE.Vector3(-0.06, 0, 0));
    racket.rotation.z = Math.PI / 2 - 0.3;
    scene.add(racket);

    // 軌道
    this.main = this.makePath(this.solved.withSpin, 0xfbbf24, 0xf97316);
    scene.add(this.main.group);
    this.ghostGroup = new THREE.Group();
    this.ghost = this.makePath(this.solved.noSpin, 0x94a3b8, 0x94a3b8, true);
    this.ghostGroup.add(this.ghost.group);
    scene.add(this.ghostGroup);

    // ボール（回転が見えるように、オレンジの帯を描いた白いボール）
    this.ball = this.makeBall(0xffffff);
    scene.add(this.ball);
    this.ghostBall = new THREE.Mesh(
      new THREE.SphereGeometry(0.02 * 1.6, 20, 14),
      new THREE.MeshStandardMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.6 })
    );
    this.ghostGroup.add(this.ghostBall);

    this.onResize = () => this.resize();
    window.addEventListener("resize", this.onResize);
    this.resize();
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
    // 実物は直径4cm。画面で見やすいように少し大きく描く
    return new THREE.Mesh(new THREE.SphereGeometry(0.02 * 1.6, 28, 18), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.4 }));
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
    // バウンドした場所に輪
    const marks = sim.bounces.map((b) => {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.03, 0.045, 32),
        new THREE.MeshBasicMaterial({ color: markColor, side: THREE.DoubleSide, transparent: true, opacity: dashed ? 0.6 : 0.95 })
      );
      ring.rotation.x = -Math.PI / 2;
      const v = toV3(b.p);
      ring.position.set(v.x, TABLE.H + 0.003, v.z);
      ring.visible = dashed; // 比較用はずっと見せる。本物はボールが着いたときに出す
      group.add(ring);
      return { ring, t: b.t };
    });
    // ネットに当たったら×
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
      this.t += dt * this.rate;
      // 最後まで行ったら少し止めてから最初に戻る（動画の保存中は止めない）
      if (this.t > this.duration + END_PAUSE * this.rate) {
        if (this.recorder) this.stopRecord();
        this.t = 0;
      }
    }
    const t = Math.min(this.t, this.duration);
    const s = this.sample(this.solved.withSpin, t);
    this.ball.position.copy(toV3(s.p));
    this.main.trail.geometry.setDrawRange(0, s.i + 1);
    this.main.marks.forEach((m) => (m.ring.visible = t >= m.t));
    // 回転：本当の回転の向きで、見える速さに落として回す
    const w = toV3(s.w);
    const wLen = w.length();
    if (wLen > 1e-6 && this.playing) {
      const visual = Math.min((wLen / (2 * Math.PI)) * this.rate, MAX_VISUAL_SPIN) * 2 * Math.PI;
      this.ball.rotateOnWorldAxis(w.normalize(), visual * dt);
    }
    const g = this.sample(this.solved.noSpin, Math.min(t, this.solved.noSpin.points.at(-1).t));
    this.ghostBall.position.copy(toV3(g.p));

    this.clock.textContent = `${(t * 1000).toFixed(0)} ミリ秒`;
    this.controls.update();
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
      a.download = `${this.tech.name}_軌道.${type.includes("mp4") ? "mp4" : "webm"}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      this.recBtn.textContent = "🎬 動画として保存";
      this.recBtn.disabled = false;
    };
    this.recorder = rec;
    this.t = 0;
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
