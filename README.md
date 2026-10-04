# OSM Photo Mapper

写真をまとめて撮影し、あとから OpenStreetMap（OSM）の編集候補を作るための、モバイル向け実験的 PWA です。

現地では「タグを入力しながら歩く」のではなく、**撮影と位置記録に集中し、帰宅後または調査後にまとめて解析・確認する**ことを目的としています。

> **重要:** OSM Photo Mapper は自動編集ツールではありません。  
> AI が生成した候補は必ず人間が確認し、現在の MVP は OpenStreetMap へ直接アップロードせず、レビュー済みの変更を `osmChange` として出力します。

---

## 表示言語

ルートの `index.html` は日本語版、`en/index.html` は英語版です。画面右上の **English / 日本語** で切り替えられます。サーベイとプロキシ設定は同じブラウザ・同じ配信元で共有します。

画面文言は `data/locales/ja.json` で管理し、英語はソース文言を使います。主要画面を翻訳しており、OSMタグ・OCR文字列・外部APIのエラー詳細は元の値を保持します。新しい日本語文言はこの辞書に追加できます。

---

## 現在の状態

実験的な MVP として、次の一連の流れが動作します。

1. Survey を開始
2. GPS トラック、撮影時刻、カメラ位置、カメラ方位などを記録
3. 写真を連続撮影
4. **Map photos** で写真をまとめて解析
5. 写真から OSM 候補を検出
6. 候補の位置を推定
7. 近傍の既存 OSM オブジェクトを調査
8. 地図と写真を見ながら候補を確認
9. ピン位置、タグ、名前、既存オブジェクトとの対応を修正
10. 最終確認後、標準 `osmChange` を出力
11. iD / JOSM 等の OSM エディタで最終確認して適用

現在の主要機能には以下が含まれます。

- PWA / モバイル優先 UI
- MapLibre GL JS
- Survey 単位のローカル保存（IndexedDB）
- サーベイを開いている間のGPSトラック自動記録（一覧に戻ると停止）
- 移動経路の地図表示と、地図左上のGPS状態・精度インジケータ
- 撮影時 GPS / EXIF GPS の利用
- カメラ方位と移動方向を別の証拠として記録
- 外部カメラ / ファイル選択とアプリ内カメラ
- OpenAI Responses API を利用した画像解析
- 一枚の写真から複数オブジェクトを検出
- 複数写真から同一オブジェクト候補をまとめる処理
- 距離・方向・GPS を組み合わせた位置推定
- 既存 OSM オブジェクト候補の検索
- Review 画面でのタグ編集
- Survey 画面上での候補ピン選択、写真確認、タグ編集
- 写真点の選択と元写真確認
- タッチ操作による候補ピン移動
- OpenAI 解析結果の由来表示
- 検証できない過去の解析結果のエクスポート禁止
- OSM オブジェクトの最新状態を取得してから `modify` を生成
- `osmChange` 出力（editor-import only）

---

## 基本方針

### 人間の確認を必須にする

AI の判定だけで OSM を更新しません。

誤検出、位置ずれ、既存オブジェクトとの重複、タグの意味違いなどを、人間が確認してから変更候補にします。

### 現地では撮影を優先する

想定する使い方は、

```text
歩く
↓
気になるものを連続撮影
↓
調査終了
↓
まとめて画像解析
↓
地図上で修正
↓
OSM 編集候補として出力
```

です。

### 「写真 = 1ピン」ではない

データモデルは単純な `Photo -> Pin` ではありません。

```text
Survey
  ├─ Photos
  │    └─ 撮影位置 / 時刻 / 方位 / 画像
  │
  ├─ Observations
  │    └─ 写真内で検出した個々の物体
  │
  └─ Feature candidates
       └─ 複数 Observation をまとめた実世界の候補
```

一枚の写真に複数の物体が写る場合もあり、同じ実物を複数方向から撮影する場合もあります。

---

## 処理の流れ

```text
写真撮影
  │
  ├─ GPS / 精度
  ├─ 撮影時刻
  ├─ カメラ位置
  ├─ カメラ方位
  ├─ 移動方向
  └─ GPS トラック
  │
  ▼
画像解析
  │
  ├─ 物体クラス
  ├─ bbox
  ├─ detection confidence
  ├─ OCR
  ├─ 見えている属性
  └─ おおよその距離
  │
  ▼
Observation
  │
  ├─ 写真間の同一物体候補を照合
  ├─ 位置推定
  └─ 近傍 OSM データを照合
  │
  ▼
Feature candidate
  │
  ├─ 座標
  ├─ OSM タグ候補
  ├─ 既存オブジェクト候補
  ├─ confidence / warnings
  └─ 解析元写真
  │
  ▼
人間によるレビュー
  │
  ├─ ピン移動
  ├─ タグ追加・編集・削除
  ├─ name の修正
  ├─ New / Existing の判断・不要なピンの削除（Undo可能）
  └─ 既存 OSM オブジェクトへのリンク
  │
  ▼
osmChange 出力
  │
  ▼
iD / JOSM 等で最終確認
```

---

## 画像解析

### 現在の構成

本番ビルドでは、ブラウザから OpenAI API を直接呼びません。

```text
OSM Photo Mapper (Browser / PWA)
        │
        │ HTTPS
        ▼
Cloudflare Worker
        │
        │ OpenAI API key は Worker 側だけに保持
        ▼
OpenAI Responses API
```

OpenAI API key を GitHub Pages やブラウザ JavaScript に埋め込まない構成です。

### 対応モデル

現在の Cloudflare Worker の allow-list は以下です。

```text
gpt-4o-mini
gpt-6-luna
gpt-6.1-sol
```

アプリ側で Model を指定できます。

現在の既定値は `gpt-4o-mini` です。  
より高度な画像理解を試す場合は `gpt-6-luna` または `gpt-6.1-sol` を指定できます。

> Worker の allow-list に名前があっても、実際にそのモデルを利用できるかどうかは OpenAI 側の API 利用条件・モデル提供状況にも依存します。

### 解析結果

OpenAI Analyzer は、写真ごとに主に以下を返します。

- feature type
- bbox
- detection confidence
- OCR text
- OCR confidence
- 画像から確認できる属性
- 距離推定
- 距離の不確実性
- visual identity の補助情報

Structured Outputs を利用し、想定外の自由形式レスポンスをそのまま OSM 編集へ流さない構成です。

### POI の二段階認識

POI の大分類と小分類は [`data/poi-catalog.json`](data/poi-catalog.json) に定義しています。OSM Wiki のタグ説明と Taginfo の使用状況を参照した主要項目の抜粋であり、OSM タグ全体を網羅するものではありません。設定ファイル内に各分類の参照 URL を記載しています。

初回の写真解析では大分類の ID・名称だけを送ります。モデルが `playground` と `visualType=swing` のように明確な種類を返し、設定のキーワードと一意に一致すれば、アプリ側で `playground=swing` に対応付けて完了します。曖昧な物体がある場合だけ、同じ写真の `previous_response_id` と該当大分類の小分類 ID・名称を使って追加問い合わせをします。追加リクエストには画像データを再添付しません。前回の画像を含む文脈の入力トークンは課金対象です。

小分類が確認できない場合は OSM タグを推測せず、観測情報を未確定候補として残します。OSM タグの適用とエクスポート判定は従来どおりアプリ側で行います。

---

## 対応している Feature Class

従来の個別 Feature Class に加え、設定ファイルから店舗・飲食店などのクラスを生成します。以下は従来の個別クラスです。

### Business / Amenities

- Vending machine
- Public toilets

### Emergency

- AED
- Fire extinguisher
- Fire hydrant
- Fire hose

### Street furniture

- Bench
- Waste basket
- Drinking water
- Information board
- Street lamp
- Manhole
- Bollard
- Public clock

### Religious

- Torii
- Stone lantern
- Komainu

### Artwork / memorial

- Statue

### Playground

- Playground equipment
- Playground area

### Transport

- Bicycle parking
- Bicycle repair station

画像に写っているすべての物体を自由に OSM タグ化するのではなく、まずこのクラス集合の中から検出します。

`stone_lantern`、`komainu` など、OSM の標準的なタグ付けが確立していないものは **review-only** とし、自動でタグを確定しません。

---

## 同一物体のまとめ方

複数写真に同じ物体が写っている場合でも、単純な AI の文字列一致だけではまとめません。

現在の cross-photo grouping では、少なくとも以下を組み合わせます。

- 同一 feature type
- 推定位置の近さ
- bbox crop の perceptual hash（dHash）

誤って二つの別物を一つにまとめるより、同一物体が二候補に分かれる方を安全側と考えています。

---

## 位置推定

写真の GPS 座標を、そのまま対象物の座標にはしません。

対象物の位置推定には、利用可能な範囲で以下を使います。

- 撮影位置
- GPS accuracy
- カメラ方位
- カメラ方位の不確実性
- 写真から推定した距離
- 同じ対象物を撮った別写真
- GPS トラック
- 近傍 OSM オブジェクト
- 航空写真等による補助的な構造推定

カメラ位置と対象物位置は別物として保持します。

移動方向（movement heading）もカメラ方位とは別の情報として扱います。

---

## Survey 画面

Survey を開くと、地図上に主に以下を表示します。

- GPS トラック
- 写真撮影地点
- Feature candidate

Candidate pin はタッチ / マウスで移動できます。

候補をタップすると Survey 内の inspector を開き、

- 元写真
- bbox
- 現在の OSM タグ
- タグ追加・編集・削除
- name
- candidate status
- analyzer / model
- detection confidence
- 座標・位置情報

を確認できます。

写真点を選択した場合は、

- 写真
- 撮影時刻
- GPS / camera position
- note
- 関連 candidate

を確認できます。

これにより、Survey を開き直したあとも Review 画面へ移動せずに候補の確認・修正ができます。

---

## Review と安全策

Review 画面では AI の最終候補だけでなく、判断材料も表示します。

- Analyzer / model
- 元写真
- bbox
- detection confidence
- OCR
- 距離推定
- position quality
- OSM mapping
- warnings

解析は OpenAI のみです。過去に保存したデモ解析結果はエクスポートできません。OpenAI で写真を再解析してください。

---

## OSM への出力

### 現在は直接アップロードしない

現在の MVP は OSM OAuth を使った直接アップロードを行いません。

出力は **editor-import only** です。

```text
OSM Photo Mapper
↓
osmChange
↓
iD / JOSM
↓
人間による最終確認
↓
OpenStreetMap
```

### modify の安全策

既存 OSM オブジェクトを変更する場合は、解析時に取得した古いコピーをそのまま利用しません。

export 直前に public OSM API から現在の状態を再取得し、

- current version
- current tags

を使って `modify` を作成します。

取得に失敗した場合は、その変更を明示的な conflict として除外します。

### way / relation

現在、自動 export する既存オブジェクトの変更は **node のみ**です。

way / relation の変更には現在の構造全体が必要になるため、リンク候補にはできますが `modify` 出力はしません。

---

## ローカル保存

Survey、写真、Observation、Candidate は IndexedDB に保存します。

Proxy 設定については、単独利用を想定した現在の MVP では以下を端末に保存できます。

- Proxy endpoint
- Proxy token

再読み込みやブラウザ再起動後も復元されます。

Analysis 画面の **Forget / Clear proxy settings** で削除できます。

### 保存しないもの

`OPENAI_API_KEY` はブラウザに保存しません。

OpenAI API key は Cloudflare Worker の Secret としてのみ保持します。

---

# セットアップ

## フロントエンド

必要環境:

- Node.js 22
- npm

```bash
git clone https://github.com/K-Sakanoshita/OSM-Photo-Mapper.git
cd OSM-Photo-Mapper

npm ci
npm test
npm run build
npm run dev
```

主な npm script:

```text
npm run dev       Vite 開発サーバー
npm run build     TypeScript typecheck + Vite build
npm run typecheck TypeScript の型チェック
npm test          Vitest
npm run preview   production build のローカル確認
```

---

# OpenAI Proxy のセットアップ

Cloudflare Worker の実装は `proxy/` にあります。

## 1. OpenAI API key を用意

ChatGPT の契約とは別に、OpenAI API 用の API key が必要です。

OpenAI API key はブラウザには入力せず、Worker Secret に設定します。

## 2. Worker Secret の登録

```bash
cd proxy

npx wrangler login
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put PROXY_TOKEN
```

`PROXY_TOKEN` はブラウザから自分の Worker を利用するための認証用 token です。

例えばランダム値を作る場合:

```bash
openssl rand -hex 32
```

Secret の登録状況は確認できます。

```bash
npx wrangler secret list
```

想定:

```text
OPENAI_API_KEY
PROXY_TOKEN
```

Secret の値そのものは表示されません。

## 3. Worker のデプロイ

```bash
npx wrangler deploy
```

初回に、

```text
You need to register a workers.dev subdomain
```

と表示された場合は、Cloudflare アカウント用の `workers.dev` サブドメインを登録します。

例:

```text
openacrossbase.workers.dev
```

Worker 名が `osm-photo-mapper-proxy` の場合、公開 URL は次のような形式になります。

```text
https://osm-photo-mapper-proxy.<subdomain>.workers.dev
```

アプリの Proxy endpoint には `/v1/responses` まで指定します。

```text
https://osm-photo-mapper-proxy.<subdomain>.workers.dev/v1/responses
```

## 4. Worker のモデル制限

`proxy/wrangler.toml` の現在値:

```toml
ALLOWED_MODELS = "gpt-4o-mini,gpt-6-luna,gpt-6.1-sol"
MAX_IMAGE_CHARS = "4500000"
MAX_IMAGES_PER_REQUEST = "1"
MAX_OUTPUT_TOKENS = "2000"
REQUESTS_PER_MINUTE = "10"
```

`ALLOWED_MODELS` を変更しただけでは、すでに公開済みの Worker は更新されません。

必ず再デプロイします。

```bash
cd proxy
npx wrangler deploy
```

デプロイログで、意図した `ALLOWED_MODELS` が Binding として表示されることを確認してください。

---

# GitHub Pages のデプロイ

フロントエンドは GitHub Actions から GitHub Pages へデプロイします。

設定ファイル:

```text
.github/workflows/deploy-pages.yml
```

この Workflow には二つの起動方法があります。

```yaml
on:
  push:
    branches:
      - main
  workflow_dispatch:
```

つまり、

- `main` への push で自動実行
- GitHub Actions 画面の **Run workflow** から手動実行

の両方に対応しています。

GitHub 画面に、

```text
This workflow has a workflow_dispatch event trigger.
```

と表示されるのは、

> この Workflow は手動実行できます

という意味です。

Workflow 内では、

```text
npm ci
↓
npm test
↓
npm run build
↓
GitHub Pages へ dist をデプロイ
```

を実行します。

## 重要: GitHub Pages と Cloudflare Worker は別のデプロイ

GitHub Actions の **Run workflow** を実行しても、Cloudflare Worker は更新されません。

```text
GitHub Pages
  → .github/workflows/deploy-pages.yml

Cloudflare Worker
  → cd proxy
     npx wrangler deploy
```

例えば `proxy/wrangler.toml` の `ALLOWED_MODELS` を変更して GitHub へ push しても、Worker 側には自動反映されません。

Worker の変更は別途 `wrangler deploy` が必要です。

---

# セキュリティ

## OPENAI_API_KEY

`OPENAI_API_KEY` は Cloudflare Worker Secret としてのみ保持します。

以下には保存しません。

- Git リポジトリ
- GitHub Pages
- ブラウザ JavaScript
- IndexedDB
- localStorage
- URL
- ログ

## PROXY_TOKEN

現在の単独利用 MVP では、ブラウザから Worker を利用するために共通 `PROXY_TOKEN` を利用しています。

Proxy token は端末に保存できますが、これを知っている人は Worker 経由で API を利用できるため、公開しないでください。

---

# 第三者向けサービスとして公開する場合

現在の `PROXY_TOKEN` 方式は、個人利用・限定テスト向けです。

不特定多数へ公開する場合、全利用者へ同じ token を配る構成にはしないでください。

想定する本番構成:

```text
Browser / PWA
    │
    ├─ user session / anonymous session
    ├─ Turnstile 等の bot 対策
    │
    ▼
Cloudflare Worker
    │
    ├─ user/session authentication
    ├─ rate limit
    ├─ daily/monthly quota
    ├─ image-size limit
    ├─ model allow-list
    ├─ output-token limit
    └─ usage accounting
    │
    ▼
OpenAI Responses API
```

一般公開する場合は、少なくとも次の追加を想定しています。

- user/session 単位の認証
- Cloudflare Turnstile 等
- 利用回数 / quota 管理
- D1 / Durable Objects 等による利用量管理
- abuse 対策
- コスト上限
- プライバシーポリシー
- 写真を外部 AI API へ送信することの明示

---

# 現在の制約

- OSM への直接 OAuth upload は未実装
- way / relation の `modify` export は未対応
- 一枚の写真から polygon / way geometry を自動生成しない
- review-only feature は人間が意味を確定する必要がある
- カメラ方位が得られない端末・撮影方法では位置精度が下がる
- 写真からの距離推定は近似値
- POI 設定にない小分類や判別できない物体は未確定候補として残る
- Cloudflare Worker の現在の rate limit は単独利用 MVP 向け

---

# ディレクトリ構成

主要部分:

```text
OSM-Photo-Mapper/
├─ src/
│  ├─ analysis/        画像解析、candidate grouping、tag policy
│  ├─ capture/         GPS、camera、orientation、EXIF
│  ├─ imagery/         航空写真等の provider
│  ├─ map/             MapLibre 表示
│  ├─ osm/             Overpass / OSM API / osmChange
│  ├─ db/              IndexedDB
│  ├─ main.ts          UI / application flow
│  └─ types.ts         data model
├─ proxy/
│  ├─ worker.ts        Cloudflare Worker
│  ├─ limits.ts        model / image / token / rate limit
│  ├─ wrangler.toml    Worker 設定
│  └─ README.md
├─ test/               Vitest
├─ docs/
│  └─ MVP.md
└─ .github/workflows/
   └─ deploy-pages.yml
```

---

# 開発上の重要な考え方

- AI provider と OSM domain logic を分離する
- 位置推定とタグ推定を分離する
- 「不明」を有効な結果として扱う
- confidence が低い情報を無理に確定しない
- camera GPS を対象物の位置として代用しない
- 同一物体 merge は conservative に行う
- 既存 OSM オブジェクトの変更時は必ず最新状態を確認する
- 検証できない過去の解析結果をエクスポートしない
- 最終判断は常に mapper が行う

---

# ライセンス / OSM データ

OpenStreetMap データを利用する場合は、OpenStreetMap のライセンスおよび attribution 要件に従ってください。

OSM Photo Mapper 自体のライセンスについては、このリポジトリのライセンスファイルを参照してください。
