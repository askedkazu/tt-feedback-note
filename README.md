# 卓球フィードバックノート

**▶ アプリを開く：https://askedkazu.github.io/tt-feedback-note/**

練習の動画をAIに見てもらい、フォームのフィードバックと振り返りの助言をもらう、自分用の卓球ノートです。
HTML / CSS / JavaScript だけで動き、ビルドは不要です。「ちょいステップ習慣」と同じ Firebase プロジェクトを使います。

## 使い方

1. ホームの「練習をはじめる」→ 今日の技と、意識するポイント（1〜2個）を選ぶ
2. 練習して、動画を撮る（または選ぶ）。打っている場面で一時停止して「ここから」を押し、AIに見せる範囲（2・3・5秒）を決める
3. 「AIにフィードバックしてもらう」→ フォーム点・良かった点・直す点（優先順）・チェック項目の ◎○△・次の練習メニュー
4. 振り返りを書くと、AIが原因と対策を助言（同じ技の最近の記録も踏まえる）→ 記録する
5. 記録の詳細で「☆ ベストにする」と、次からその技はベストの回と比べたフィードバックになる

## ボールの軌道を3Dで見る

図鑑の技を開き「🎥 ボールの軌道を3Dで見る」を押すと、その技の打球を3Dで再生する（フットワークの技以外の15技）。

- スロー再生（1/4・1/2・等速）、視点（後ろ・横・上・相手側）、指で回転・拡大
- 点線は「回転がなかったらこう飛ぶ」軌道。回転でどれだけ落ちる・曲がるかが比べられる
- 「🎬 動画として保存」で、1回分の再生を動画ファイル（mp4 または webm）にして保存
- 軌道は `physics.js` で計算している：重力・空気抵抗・マグヌス力（回転で曲がる力）と、台でのバウンド（摩擦で回転が変わる）。
  技ごとの打球（打つ位置・初速・回転・狙う場所）は `physics.js` の `SHOTS`。打ち出す角度は、狙った場所に落ちるように自動で計算する
- 3D表示は three.js（CDN）を使い、ボタンを押したときだけ読み込む（`trajectory-view.js`）

## ファイル構成

| ファイル | 内容 |
| --- | --- |
| `index.html` | 画面（Tailwind CSS を CDN で読み込み） |
| `style.css` | 共通部品の見た目 |
| `app.js` | 画面の切り替え、動画からの写真の切り出し、AI呼び出し、記録・グラフ・バッジ、ログイン |
| `physics.js` | ボールの軌道の計算と、技ごとの打球の例 |
| `trajectory-view.js` | 軌道を3Dで見る画面（three.js） |
| `techniques.js` | 技の図鑑（コツ・よくあるミス・チェック項目・おすすめ練習・撮り方）。技を足すときはここに追加 |
| `firebase-config.js` | Firebase の設定（ちょいステップ習慣と同じ） |
| `manifest.webmanifest`, `icons/` | ホーム画面に追加したときのアプリ名・アイコン |

## AIに送るもの（`app.js` の `requestFeedback` / `requestAdvice`）

- 動画そのものは送らない。選んだ範囲を等間隔に16枚（5秒のときは20枚）、長辺512pxの JPEG に切り出して送る
  （Gemini は動画を1秒に1コマしか見ないため、速いスイングは写真で送った方が細かく見られる）
- 一緒に送る：プロフィール（利き手・グリップ・ラバー・戦型・レベル・目標）、技の要点とよくあるミス、意識したこと、
  ベストの回と比べるときはその回の写真10枚
- モデルは `gemini-3.8-flash` → だめなら `gemini-3.5-flash-lite`（Firebase AI Logic 経由。APIキーは不要）
- 返事は `responseSchema` で形を決めている。チェック項目の ◎○△ を 3・2・1 点として平均し、100点満点の「フォーム点」にする

## データの保存（Firestore）

| 場所 | 中身 |
| --- | --- |
| `tt_users/{uid}` | プロフィール、技ごとのベストの回 |
| `tt_users/{uid}/sessions/{id}` | 記録（技・意識したこと・フィードバック・フォーム点・振り返り・助言・小さなサムネイル） |
| `tt_users/{uid}/frames/{id}` | 記録ごとの連続写真（長辺360px）。記録を開いたときとベストと比べるときだけ読む |

- ログインしていないときは、記録はこの端末（localStorage）だけに保存し、写真は保存しない。あとでログインするとアカウントに送る

## 最初の設定（1回だけ）

### 1. GitHub Pages で公開する

GitHub のこのリポジトリ → **Settings** → **Pages** →「Build and deployment」の Source を **Deploy from a branch**、
Branch を **main** / **/(root)** にして **Save**。数分で https://askedkazu.github.io/tt-feedback-note/ が開けるようになる。

### 2. Firestore のルールに `tt_users` を追加する

Firebase コンソール → Firestore Database → **ルール** に、`match /tt_users/...` の部分を足して「公開」
（`管理者のUID` は今のルールに書いてある値のまま）：

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isAdmin() {
      return request.auth != null && request.auth.uid == "管理者のUID";
    }
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
      allow read: if isAdmin();
    }
    match /photos/{id} {
      allow create: if request.auth != null && request.resource.data.uid == request.auth.uid;
      allow read, delete: if isAdmin();
    }
    // 卓球フィードバックノート（本人だけが読み書きできる）
    match /tt_users/{uid}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

ログイン（承認済みドメイン `askedkazu.github.io`）と App Check（reCAPTCHA のドメイン）は、
ちょいステップ習慣と同じドメインなので追加の設定は不要。

## ローカルで試す

```bash
python3 -m http.server 8000   # → http://localhost:8000
```

ログインとAIは公開URL（GitHub Pages）から開いたときに使える。
