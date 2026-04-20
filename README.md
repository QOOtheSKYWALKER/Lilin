# Lilin High-Fidelity Audio Engine

Lilin は、Web Audio API と WebAssembly (AssemblyScript) を駆使して構築された、ハイエンド・オーディオ・プロセッシング・エンジンです。
128倍の極めて高いオーバサンプリングレートと、独自の7次デルタシグマ（ΔΣ）変調アルゴリズムにより、デジタルオーディオに「空気感」と「密度」をもたらします。

## 核心的な技術

### 1. 7th-Order Delta-Sigma Modulator
デジタル信号を極めて高密度のパルス系列へと変換します。量子化ノイズを可聴帯域外へ強力に押し出す（ノイズシェーピング）ことで、シルクのような滑らかな高域再現を実現します。

### 2. Full-Wasm DSP Architecture
演算負荷の高いすべての処理は WebAssembly 内で実行されます。
- **Real-time AGC & Expander**: 各チャンネル独立してピークを検出し、ダイナミックレンジを最適化。
- **RMS-based Detail Boost**: 弱音部や残響成分をインテリジェントに検知し、微細なディテールを持ち上げます。
- **Built-in Exciter**: 10kHz以上の倍音成分を制御し、現代的な解像度感を付加します。

### 3. Stability & Professionalism
- **Leaky Integrators**: 積分器に極微量の減衰を加えることで、デジタル領域特有の無限発振を防止。
- **State Guard**: 異常値を検知した際の自動復帰機能およびシーク時のリセット機能を備え、一貫した動作を保証します。

## 内部構造
### コア・エンジン
- `assembly/processor.ts`: DSPエンジンの心臓部（AssemblyScript / SIMD最適化）。
- `processor.js`: AudioWorkletProcessor と Wasm メモリのブリッジ。

### Chrome 拡張機能
ブラウザのタブ音声をキャプチャし、リアルタイムで Lilin エンジンを適用します。
- `manifest.json`: 拡張機能の設定ファイル。
- `background.js`: タブキャプチャの制御。
- `offscreen.js`: Lilin エンジンを駆動するオフスクリーン・ドキュメント。
- `popup.html/js`: 拡張機能の設定画面。

### プレイヤー (Standalone)
- `index.html`: ファイル・フォルダを選択して再生可能なローカルプレイヤー。

## インストール (Chrome 拡張機能)
1. Chrome を開き `chrome://extensions` にアクセス。
2. 右上の「デベロッパー モード」を ON にする。
3. 「パッケージ化されていない拡張機能を読み込む」をクリックし、本プロジェクトのルートディレクトリを選択。
4. 拡張機能アイコンをクリックし、対象のタブで「START」を押すと高音質化が有効になります。

## 開発環境
- AssemblyScript によるビルド: `npm run asbuild`
- ローカルプレビュー: `npm run dev`

## 哲学
"Simple, Minimal, and Pure."
一つのプロセス、一つの実装による無駄のないインターフェースと、妥協のない内部処理を目指しています。
